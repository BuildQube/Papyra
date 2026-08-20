# papyra spike results

Date: 2026-08-19 · M-series mac (arm64), rustc 1.95.0, node 25.8.1, bun 1.3.11

Two questions:
1. Does hayro + napi-rs give us one build path for both Node and the browser?
2. Is it faster than pdf.js?

Answer: **yes to (1), no to (2) in the browser.**

## 1. Build path — clean win

`napi build --platform --release --target wasm32-wasip1-threads` produced the entire
browser bundle with **zero extra tooling** (no wasm-pack, no emscripten):

```
papyra.darwin-arm64.node        4.9 MB   native addon
papyra.wasm32-wasi.wasm         4.1 MB   browser/wasm
papyra.wasi-browser.js                   generated glue
wasi-worker-browser.mjs                  generated worker
browser.js / index.js / index.d.ts       generated entrypoints + types
```

Same shape as takeoff-calculator. Nothing for the end user to install. Both artifacts
verified running (`backendName() === "hayro"`, documents load, pages render).

Notes:
- The whole hayro/vello_cpu tree compiles for `wasm32-wasip1-threads` without patches.
- `emnapi`, `@emnapi/core`, `@emnapi/runtime` must be pinned to the **same version**
  or the napi CLI refuses to build.
- Generated glue uses `new WebAssembly.Memory({ shared: true })` → **SharedArrayBuffer →
  consumers must serve COOP/COEP headers.**
- `RENDER CACHE`: hayro's `RenderCache<'a>` borrows from the document, so it cannot live
  inside our `Document` struct without a self-referential wrapper (`self_cell`/`ouroboros`).
  Worked around here with a batch `render_pages()` API.

## 2. Correctness — very good

Visually indistinguishable from pdf.js on text, AcroForm widgets, and transparency.
Differing pixels (threshold 60/765, 100 DPI): tracemonkey 2.87%, 160F-2019 2.19%,
alphatrans 0.39% — all antialiasing-level, no structural differences.

Encrypted PDFs: hayro **does** support them (`Pdf::new_with_password`); it correctly
reported `Decryption(PasswordProtected)` on `pr6531_1.pdf`, exactly as pdfium and pdf.js
do. The claim in hayro's README that encryption is unsupported is stale.

## 3. Performance — the thesis does not hold in the browser

Corpus: 8 PDFs / 45 pages from the pdf.js test suite. 150 DPI. Best of 5 after warmup.
pdf.js 6.2.108 via `pdfjs-dist/legacy` + `@napi-rs/canvas`, given its standard_fonts and cmaps.

### Whole-document throughput

| engine                     | aggregate | vs pdf.js       |
|----------------------------|-----------|-----------------|
| pdfium (native)            |   130 ms  | **3.81x faster**|
| papyra / hayro (native)    |   374 ms  | 1.32x faster    |
| pdf.js (node + canvas)     |   495 ms  | 1.00x           |
| papyra / hayro (wasm+simd) |   627 ms  | **0.79x — slower** |

### Time to first page (open + render page 0)

native 1.49x faster than pdf.js · wasm 0.89x (i.e. ~1.1x slower)

### Per file (ms/page, throughput)

| file                         | pg | native | wasm  | pdf.js | nat/pdfjs | wasm/pdfjs |
|------------------------------|----|--------|-------|--------|-----------|------------|
| 160F-2019.pdf                |  1 |   8.63 | 14.46 |  22.79 |     2.64x |      1.58x |
| TAMReview.pdf                | 23 |   7.43 | 12.97 |   9.60 |     1.29x |      0.74x |
| alphatrans.pdf               |  1 |  11.98 | 20.50 |   4.50 |     0.38x |      0.22x |
| arial_unicode_en_cidfont.pdf |  1 |   2.37 |  5.01 |   3.77 |     1.59x |      0.75x |
| cmykjpeg.pdf                 |  1 |   2.50 |  5.45 |   2.23 |     0.89x |      0.41x |
| franz.pdf                    |  1 |   0.09 |  0.19 |   1.68 |    17.95x |      8.92x |
| sizes.pdf                    |  3 |   1.86 |  3.80 |   0.76 |     0.41x |      0.20x |
| tracemonkey.pdf              | 14 |  12.31 | 19.39 |  16.96 |     1.38x |      0.87x |

### Findings

- **`-C target-feature=+simd128` is mandatory.** Without it the wasm penalty is 2.82x;
  with it, 1.67x. It moved wasm-vs-pdf.js from 0.46x to 0.79x.
- **Transparency is hayro's weak spot.** `alphatrans` (0.38x) and `sizes` (0.41x) are the
  two clear losses; both are transparency/blend heavy.
- **hayro's per-document overhead is far lower than pdf.js's.** `franz.pdf` (one tiny page)
  is 18-22x faster — pdf.js pays a large fixed cost for worker + font setup. Good for
  viewers opening many small documents.
- pdfium is 2.73x faster than hayro natively, consistent across both harnesses.

## Reproduce

```
cargo run --release -p papyra-spike-bench --features pdfium   # rust: hayro vs pdfium
cd packages/bindings && RUSTFLAGS="-C target-feature=+simd128" \
  bunx napi build --platform --release --target wasm32-wasip1-threads
cd spike/bench-js && node bench.mjs   # native vs wasm vs pdf.js (throughput)
                     node ttfp.mjs    # time to first page
                     node dump.mjs tracemonkey.pdf 0   # visual diff
```

---

# Addendum: concurrency changes the verdict

The single-page numbers above are the wrong benchmark. pdf.js is effectively
single-threaded per document; Rust is not. Exploiting that flips both results.

## hayro parallelises cleanly

`hayro_syntax::Pdf` is `Send + Sync` (test in `crates/papyra-hayro`). `RenderCache` is
`Rc`-based and **not** `Send`, so each worker builds its own via rayon's `map_init` and
reuses it across the pages it handles.

## Native — TAMReview.pdf, 23 pages @ 150 DPI, 18 cores

| strategy                              | ms/page | vs pdf.js  |
|---------------------------------------|---------|------------|
| serial (sync)                         |    7.28 |      1.32x |
| AsyncTask + `Promise.all`, uv pool 4  |    2.00 |      4.81x |
| rayon `renderPagesParallel`           |    0.88 |     10.85x |
| AsyncTask + `Promise.all`, uv pool 16 |    0.82 | **11.66x** |

Event-loop responsiveness during a full-document render (timer ticks, higher = better):
**async 37, sync 0.** AsyncTask keeps the loop free; the sync path stalls it completely.

## WASM — threads work, with a catch

- `std::thread::spawn` **succeeds** under `wasm32-wasip1-threads` + `@napi-rs/wasm-runtime`.
- But `available_parallelism()` returns *unsupported*, so **rayon silently defaults to 1
  thread**. This is why the first wasm measurement showed 0.97x — no parallelism at all.
- Fix: an explicit `configureThreadPool(n)` binding (`rayon::ThreadPoolBuilder::build_global`),
  called with `navigator.hardwareConcurrency` / `os.cpus().length` **before any render**.
  It must be first — any earlier rayon call locks in the 1-thread global pool.

With 8 threads: **2.38–2.58x speedup**, 12.66 → 5.04 ms/page ⇒ **~1.9x faster than pdf.js**
in the browser, versus 0.79x (slower) single-threaded.

Sharp edge: pool sizing is fragile. 8 threads is reliable; 4 deadlocks (worker-pool
exhaustion — node glue defaults to `asyncWorkPoolSize: 4`, tunable via
`NAPI_RS_ASYNC_WORK_POOL_SIZE`). The browser glue already sizes from
`navigator.hardwareConcurrency`. Needs a proper fix before shipping.

## Streaming thumbnails — `spike/bench-js/thumbs.mjs`

Async generator over `renderPageAsync` with a bounded in-flight window, yielding in
completion order. TAMReview, 23 pages @ 48 DPI, concurrency 8:

```
first thumbnail:            4.1 ms
half rendered:             10.9 ms
all 23:                    16.6 ms
first 4 then break:         4.7 ms   (generator stops scheduling)
viewport-first (5 pages):   5.3 ms   (custom priority order)
```

Backpressure, early exit, and priority ordering all fall out of the generator for free —
no Rust-side queue needed. This also bounds memory: 23 pages at 150 DPI RGBA is ~193 MB
if you hold them all, so streaming is a correctness requirement, not just a latency win.

## Recommended architecture

Drive rayon from **inside** an `AsyncTask` — one JS-visible promise, full parallelism,
event loop stays free, and no dependence on `UV_THREADPOOL_SIZE` (which swung the
AsyncTask-only path from 4.81x to 11.66x). Keep the streaming generator in the TS layer
so it behaves identically on native and wasm.

## Revised verdict

|                | single-threaded | with concurrency |
|----------------|-----------------|------------------|
| native vs pdf.js |        1.32x  |  **~11x**        |
| wasm vs pdf.js   |        0.79x  |  **~1.9x**       |

Caveats: this only helps multi-page work. Single-page renders are unchanged, and hayro
still loses on transparency-heavy pages (`alphatrans` 0.38x, `sizes` 0.41x).

---

# Addendum 2: why rayon and not tokio

## tokio's multi-thread runtime does not exist on wasm

```
$ cargo build -p tokio-probe --target wasm32-wasip1-threads
error: Only features sync,macros,io-util,rt,time are supported on wasm.
  --> tokio-1.53.1/src/lib.rs:479:1
```

`rt-multi-thread` is a hard compile error. Only `rt` (current_thread) builds — which is
zero parallelism. **tokio cannot deliver browser parallelism at all**, and the browser was
requirement #1. rayon compiled for the WASI target without complaint.

## They also solve different problems

- **rayon** — data parallelism over CPU-bound work: work-stealing pool sized to cores.
  PDF rasterization is exactly this.
- **tokio** — async I/O concurrency: many tasks that *yield*. Rasterization never yields.
  Putting it on tokio worker threads starves the scheduler; the correct tokio answer is
  `spawn_blocking`, whose pool is designed for blocking I/O (grows to 512 threads on
  demand), not a work-stealing compute pool.

napi-rs's tokio support (`tokio_rt`) is about letting you write `async fn` in `#[napi]`
and get a JS Promise back. Good DX — but for CPU work `AsyncTask` already returns a
Promise, using the lower-level `napi_create_async_work` primitive with no runtime to carry.

## Measured: all four strategies, both targets

TAMReview, 23 pages @ 150 DPI, `UV_THREADPOOL_SIZE` at its default of 4.

| strategy                          | native ms/pg | vs pdf.js | wasm ms/pg | vs pdf.js |
|-----------------------------------|--------------|-----------|------------|-----------|
| serial (sync)                     |         7.19 |     1.33x |      12.26 |     0.78x |
| rayon (sync)                      |         0.89 |    10.79x |       5.02 |     1.91x |
| AsyncTask per page + `Promise.all`|         1.98 |     4.84x |       3.90 |     2.46x |
| **AsyncTask + rayon inside**      |     **0.82** | **11.76x**|       4.16 |     2.31x |

`AsyncTask` works on **both** targets — in wasm emnapi maps async work straight onto its
worker pool, which is why it edges out rayon there.

## Decision: AsyncTask outside, rayon inside

The batch form hits **11.76x at the default libuv pool of 4**, whereas AsyncTask-per-page
needs `UV_THREADPOOL_SIZE=16` to reach comparable numbers. That decoupling from a host
setting we cannot control from inside the addon is the deciding factor. Event loop stays
free on both targets (20 ticks native / 82 wasm during a full-document batch).

## Where tokio would earn its place

Async I/O, not rendering: streaming a PDF over HTTP with range requests, incremental or
linearized loading, a server-side job queue. That is genuine async work and could be added
later, native-only, without touching the render path.

---

# Addendum 3: the `async` feature, and a correction on wasm parallelism

## Is `napi`'s `async` feature needed? No — not for what we build.

In napi 3.12.1, `async = ["tokio_rt"]`. It gates **tokio integration**: `#[napi] async fn`
and `Env::spawn_future_with_callback`.

`Task` / `AsyncTask` are **not** behind it. In `napi/src/lib.rs`, `mod async_work;` and
`mod task;` are ungated; only `mod tokio_runtime;` is gated on
`any(feature = "tokio_rt", feature = "async-runtime")`. That is why our build works with
just `default-features = false, features = ["napi4"]` — `AsyncTask` uses
`napi_create_async_work` (libuv natively, the emnapi async-work plugin on wasm).

**Correction to Addendum 2:** enabling `async` does *not* break the wasm build. napi-rs
already solves this with per-target dependency specs:

```toml
[target.'cfg(all(target_family = "wasm", not(tokio_unstable)))'.dependencies.tokio]
features = ["rt", "sync"]                            # no rt-multi-thread
[target.'cfg(any(all(target_family="wasm", tokio_unstable), not(target_family="wasm")))'.dependencies.tokio]
features = ["rt", "rt-multi-thread", "sync"]
```

Verified with `cargo tree -e features`: wasm resolves to `rt` + `sync`, native adds
`rt-multi-thread`. Builds clean on both. Cost of enabling it: **20,487 bytes (0.5%)** of wasm.

The substantive point stands — on wasm you get a current-thread runtime, so tokio still
yields no parallelism there. But "it won't compile" was wrong; it compiles and is simply
single-threaded.

Also worth knowing: napi 3 has an **`async-runtime`** feature — an SPI for plugging a custom
async runtime with *no tokio linked at all*. That is the route to `async fn` ergonomics
without the tokio dependency, if we ever want it.

**Decision: leave `async` off.** We use `AsyncTask`; enable it only if we later want
`async fn` or tokio for I/O.

## ⚠ Correction: wasm parallel rendering is UNSTABLE

The Addendum 2 wasm numbers are real but were measured under conditions that hid a bug.
The benchmark ran a serial render *before* the parallel ones. That warmup is load-bearing.

Cold, both wasm concurrency paths trap **consistently**:

```
worker (tid = 45) sent an error! memory access out of bounds
  at vello_common::coarse::Wide<0_u8>::new
  at vello_cpu::render::RenderContext::new_with
  at hayro::render
  at rayon::iter::plumbing::bridge_producer_consumer::helper
```

Isolation matrix (TAMReview, 8 threads):

| scenario                                   | result |
|--------------------------------------------|--------|
| 5 pages @ 150 DPI, cold                     | **FAILS** |
| 23 pages @ 150 DPI, cold                    | **FAILS** |
| 23 pages @ 150 DPI, after a main-thread render | OK |
| 23 pages @ 48 DPI, cold                     | OK |

Not simply total output size — 5 pages cold fails while 23 pages at 48 DPI succeeds.
Raising the glue's `initial` shared memory from 4000 to 16384 pages (256 MB → 1 GB) did
**not** fix it, so it is not plain heap exhaustion. Leading hypothesis is stale per-worker
memory views after growth, or wasm thread stack size — **not yet confirmed**.

Native parallelism is unaffected and stable throughout.

### Status

wasm parallelism is **not shippable as-is**. Known workaround: force a main-thread render
at init. Combined with the earlier deadlock at certain thread counts (8 reliable, 4 hangs),
this is the single biggest open risk in the browser story and needs a proper fix before
any of these wasm numbers can be quoted.

---

# Addendum 4: wasm memory bug — FIXED

## Root cause

Concurrent **linear-memory growth** from render worker threads. Rust's allocator grows
wasm memory via `memory.grow`; several workers hitting that on a cold heap traps with
`memory access out of bounds` inside whatever happened to be allocating (usually
`vello_common::coarse::Wide::new` → `hashbrown reserve_rehash`).

It is a **race**, so it is intermittent — roughly **14% of cold runs** at 23 pages /
150 DPI / 8-way. Earlier "consistent" failures and "consistent" passes were both timing
luck; any rebuild reshuffles it. That is why the first attempted fix appeared to work
while doing nothing.

Evidence for the diagnosis:

| experiment                                        | result |
|---------------------------------------------------|--------|
| concurrency 1, up to 300 DPI                       | always OK — not a per-render size limit |
| raising the **glue's** `WebAssembly.Memory` initial| no effect — the module still calls `memory.grow` |
| swapping in Rust `dlmalloc` (`global`, unlocked on wasm) | **100% failure** — confirms allocation-path race |
| one main-thread render before any parallel work    | always OK — growth already done, single-threaded |

wasi-libc's malloc locks its own structures (hence only 14%, not 100%), but the growth
path still races across threads.

## Fix

Grow the heap once, single-threaded, before any worker allocates — `reserve_memory(mb)`,
invoked automatically from `PdfDocument::load` behind a `std::sync::Once`. It allocates
and touches one byte per 64 KiB page, then frees, leaving the heap grown and the space in
the allocator's free list. Default 256 MiB. `#[cfg]`-gated to wasm; a no-op on native.

## Validation

| workload                          | before fix      | after fix   |
|-----------------------------------|-----------------|-------------|
| 23 pages @ 150 DPI, 8-way         | 5 fail / 40     | **0 / 45**  |
| 23 pages @ 220 DPI, 8-way         | 5 fail / 12     | **0 / 12**  |
| 46 renders @ 150 DPI, 8-way       | 2 fail / 12     | **0 / 12**  |
| **total**                         | **12 fail / 64**| **0 / 69**  |

Cost: **~15 ms once per process**, and it needs no user action. Performance is unchanged:

- wasm parallel, 23 pages @ 150 DPI: **3.96 ms/page — 2.42x faster than pdf.js**
- native AsyncTask+rayon:            **0.79 ms/page — 12.11x faster than pdf.js**

The Addendum 2 wasm numbers are now reproducible rather than accidental.

## Second bug found and characterised: sync rayon deadlocks on wasm

`renderPagesParallel` (synchronous, rayon) **hangs 8/8** on wasm. rayon's workers are Web
Workers, created by the JS event loop — blocking the main thread to wait for them cannot
work. This is deterministic, not flaky, and explains the earlier intermittent "hang".

**API consequence: no synchronous parallel entry point on wasm.** The split is:

- **native** — `renderPagesAsync` (AsyncTask outer, rayon inner) → 12.11x
- **wasm**   — `renderPageAsync` + `Promise.all` (emnapi async-work pool) → 2.42x

Both keep the event loop free. `configureThreadPool()` remains wasm-only and must be
called before any other rayon use (`available_parallelism` is unsupported there, so rayon
otherwise pins itself to one thread).

---

# Addendum 5: browser wasm perf — the problem was the measurement

The scaffold landed with "browser wasm is ~3000 ms/page vs 8.7 ms/page in Node" as the
top open risk. That number was wrong, for two independent reasons.

## Cause 1: the debugger was suppressing JIT tiering

Every earlier browser measurement was taken in a tab with the browser-automation
extension attached. An attached debugger stops V8 tiering wasm up from Liftoff to
TurboFan, so the numbers reflected unoptimised code.

Same page, same build, same machine — the only difference is the debugger:

| measurement           | debugger attached | clean headless |
|-----------------------|-------------------|----------------|
| single page @150 DPI  |          56.1 ms  |    **14.5 ms** |
| stream, concurrency 1 |       79.1 ms/pg  | **17.7 ms/pg** |
| stream, concurrency 4 |       25.2 ms/pg  |  **6.2 ms/pg** |

**Never benchmark wasm in an automated/instrumented tab.** `apps/demo/perf.html` +
`src/perf.ts` POST their results to a `/__perf` dev-server route precisely so they can
be run in a plain headless browser:

```bash
bun run --filter papyra-demo dev
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox --user-data-dir=/tmp/chrome-perf \
  http://localhost:5173/perf.html
# results appear in the vite output between ===PERF=== markers
```

Use a fresh `--user-data-dir` each run; a reused dirty profile produced misleading
degradation at high concurrency.

## Cause 2: the demo starved its own viewport

The remaining slowness was the app, not the engine. `App` rendered the visible page
while `Thumbnails` simultaneously scheduled a render for every page in the document.
They share one pool, so the page the user was looking at queued behind 14 thumbnails.
Fixed by gating thumbnail streaming on the first page being on screen.

## Real browser numbers

tracemonkey.pdf, 14 pages @ 150 DPI, clean headless Chrome, best of 5 after 3 warmup
passes. Single-threaded browser (17.6 ms/pg) now matches Node wasm (~18.9 ms/pg), which
is the sanity check that the wasm build itself was never the problem.

| in-flight renders | ms/page |
|-------------------|---------|
| 1                 |   17.58 |
| 2                 |    9.86 |
| 3                 |    7.37 |
| 4                 |  **6.18** |
| 6                 |    6.10 |
| 8                 |    6.11 |
| 16                |    6.12 |

Throughput plateaus at 4 in-flight renders — exactly napi-rs's hardcoded
`asyncWorkPoolSize = 4` in the generated browser glue. Patching that constant to scale
with `navigator.hardwareConcurrency` did **not** help and made concurrency 8–16 *worse*
(6.2 → 9.1 → 11.7 ms/pg), so the patch was reverted rather than shipped. Instead the
wrapper caps wasm concurrency at `MAX_WASM_CONCURRENCY = 4`; going higher only inflates
peak memory.

## papyra vs pdf.js, same browser, same page

This is the comparison that counts, and it is far more modest than the Node one:

| | papyra | pdf.js | |
|---|---|---|---|
| all 14 pages @150 | 6.13 ms/pg | 8.21 ms/pg | **papyra 1.30x** |
| single page @150  | 14.3 ms    | 6.4 ms     | **pdf.js 2.3x**  |

Two things to absorb:

- **pdf.js is much faster in a real browser than in Node** (8.2 vs 16.3 ms/pg): it
  renders into a canvas backed by Chrome's own accelerated rasteriser, where the Node
  comparison used CPU-only `@napi-rs/canvas`. Our Node benchmark flatters us.
- **pdf.js wins decisively on a single page.** papyra rasterises on the CPU in wasm and
  then hands pixels back across the boundary; pdf.js draws straight into the canvas with
  no copy. papyra's 14.3 ms does not even include `paintToCanvas`.

So the browser story is **batch work, not viewing**: thumbnail grids, prerendering,
export, bulk rasterisation. For "open a PDF and look at one page", pdf.js is still the
better tool in the browser. The 5.59x aggregate advantage is a **Node** result and
should be quoted as such.
