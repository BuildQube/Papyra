# papyra

Fast PDF rendering for Node **and** the browser, from one Rust core.

- **One toolchain.** `napi build` produces both the native addon and the browser wasm
  bundle. No wasm-pack, no emscripten, no pdfium binaries to ship.
- **Nothing to install.** The rendering engine ([hayro](https://github.com/LaurenzV/hayro),
  pure Rust) is compiled in.
- **Concurrent by default.** Rendering is parallelised in Rust and never blocks the
  event loop.

```ts
import { open, paintToCanvas } from '@build-qube/papyra';

const doc = await open(file);                    // Uint8Array | Blob | File
const page = await doc.renderPage(0, { dpi: 150 });
paintToCanvas(page, canvas);

// stream thumbnails, bounded concurrency, yields as they finish
for await (const { page, bitmap } of doc.stream({ fitWidth: 160 })) {
  paint(page, bitmap);
}
```

Rendering is scheduled: **you** supply the priority, papyra honours the order. Lower runs
first and the default is the most urgent tier, so callers who do not care can ignore it.

```ts
const doc = await open(file, { concurrency: 4 });   // viewers want a narrow pool

// Thumbnails yield to whatever is on screen.
for await (const { page, bitmap } of doc.stream({ fitWidth: 160, priority: 2 })) { … }

// Reprioritise on scroll instead of cancelling and resubmitting.
const job = doc.render(12, { fitWidth: 1600, priority: 2 });
onScroll(() => job.setPriority(isVisible(12) ? 0 : 3));
```

Requests for the same page at the same size coalesce into one render. Pending work
reorders freely; work already running is never interrupted. Lower-priority renders are
also held back while something more urgent is still running (`yieldToUrgent`, on by
default) — ordering the queue is not enough on its own, since a job that has already
started competes for CPU for its whole duration.

`doc.render()`'s handle reports `timing: { waitMs, runMs }` once it settles, which is how
you tell a long queue from a slow render.

## Outlines

```ts
for (const node of await doc.outline()) {
  console.log(node.title, node.page);   // page is null for a container or a URL
  node.children;                        // nested, as the document nests it
}
```

A tree, not a flat list, and containers that group children without pointing anywhere
are kept — dropping them reparents their children and flattens the table of contents.
`dest` carries the view as well as the page (`XYZ`, `FitH`, …) in PDF points from the
page's bottom-left, because a bookmark is frequently a position two thirds of the way
down a page rather than the page itself. `bold`, `italic` and `open` are the
document's own presentation hints.

hayro has no outline API, so papyra walks the object graph itself: explicit
destinations, name trees, the legacy `/Dests` dictionary, and `GoTo` actions all
resolve; `GoToR` and `URI` deliberately do not, and surface as `dest: null`. Malformed
outlines with cyclic `/Next` or `/Kids` chains terminate rather than hang.

## Text and search

```ts
for await (const hit of doc.search('site plan')) {
  hit.page;      // where
  hit.rects;     // one box per line the match covers, in 72-DPI page space
  hit.context;   // surrounding text, for a results list
}

await doc.indexText();          // extract everything up front; a later search is instant
const text = await doc.pageText(0);
```

Matching is case- and diacritic-insensitive by default (`annee` finds `année`),
expands ligatures, collapses runs of whitespace, and **runs across line breaks** — a
search for `dynamic languages` finds a title set as `… for Dynamic` / `Languages`, and
returns a box for each of the two lines.

Search order is yours: `{ order }` lets a viewer search outward from the page on
screen, so the first result is the nearest one rather than whatever is on page 1.
`{ limit }` and `{ signal }` stop it early.

Geometry is stored along the baseline, not as rectangles, so a match on rotated text —
a drawing's vertical dimension label — comes back as a quadrilateral at the text's own
angle. `hit.rects` is the upright bounding box if that is all you need.

Spaces are reconstructed. PDF encodes a word break as a position change at least as
often as it writes a space character, so the gap is measured against each glyph's own
advance; the signal is sharply bimodal in practice (0.000 within a word, 0.196 of an em
between, on the test corpus).

**What it cannot read.** Some documents draw text with no `ToUnicode` cmap and an
encoding hayro's fallback chain does not resolve. Those glyphs are visible but
unmappable, and `undecodedGlyphs` says so rather than quietly returning nothing:

```ts
const { lines, undecodedGlyphs } = await doc.pageText(n);
// lines, zero undecoded  -> searchable
// lines AND undecoded    -> partly readable — the case worth warning about, since the
//                           page looks searchable and mostly is not
// no lines, undecoded    -> text nothing can read; retrying will not help
// neither                -> no text at all; probably a scan
```

`bun run --filter papyra-bench text` reports coverage against pdf.js per file. Compare
*usable* characters, not raw counts: given a font with no Unicode information pdf.js
passes the raw character codes through as if they were Unicode, so on `TAMReview.pdf`
38,426 of the 59,313 characters it returns are control codes. papyra drops those and
counts them in `undecodedGlyphs` instead.

Against pdf.js's usable output, papyra reads 99-102% on twelve of the fourteen corpus
files at ~15x the speed, and on the two pages of `TAMReview.pdf` that use ordinary
fonts it reads slightly more. The rest of that file is Word-generated Cambria subsets
with no `ToUnicode` cmap and opaque `gNN` glyph names in both the encoding and the CFF
charset — no Unicode exists anywhere in the file for that text, and no tool recovers it
without OCR.

Rendered pages are cached by `(page, size)` under a byte budget — 128 MB by default,
`cacheBytes: 0` to disable. It matters more than it sounds: on a large CAD drawing every
page costs >=93 ms however small the output, because the cost is per-draw-call rather
than per-pixel. Revisiting a page you have already seen is ~50x faster, and a lookup
never occupies a render slot.

```ts
doc.cache;        // { bytes, entries, hits, misses, evictions }
doc.clearCache();
``` Priority only helps when the
queue is deeper than the pool — measured 5.2x faster to the visible page at concurrency
4, but only 1.1x at 18.

Size thumbnails and viewports with `fitWidth` (output pixels), not `dpi`. Page sizes
vary enormously: 36 DPI is a 306x396 thumbnail for US Letter but 1512x1080 — 6.5 MB —
for a 42x30in drawing. papyra rejects renders over 100 MP and tells you to use
`fitWidth`.

## Export

Raw RGBA is the right output for a canvas — `putImageData` needs no decode. When the
pixels are *leaving* the process, encode them instead:

```ts
// Pixels never cross into JS. 8.2 MB raw becomes 305 KB of WebP.
const img = await doc.renderImage(0, { fitWidth: 2000 });
await writeFile('page-0.webp', (await img.toWebp()).bytes);

// Or encode a page you already have.
const page = await doc.renderPage(0, { dpi: 150 });
paintToCanvas(page, canvas);
const png = await encode(page, { format: 'png' });
img.src = png.toBlobUrl();
```

Three formats, all pure Rust — which is what keeps the browser build free of a C
toolchain. Page 0 of each corpus file at 150 DPI, aggregate:

| format | size | vs raw | vs PNG | time |
| ------ | ---- | ------ | ------ | ---- |
| `webp` | 851 KB | 69x smaller | **2.96x smaller** | 26 ms |
| `png` | 2516 KB | 23x smaller | — | 18 ms |
| `jpeg` (q80) | 1322 KB | 45x smaller | 1.9x smaller | 86 ms |

`webp` is the default and is lossless VP8L — there is no lossy WebP encoder in pure
Rust, and none is needed: pages are line art, text and flat fills, which is precisely
what VP8L is good at. It is roughly a third the size of PNG for about the same encode
time. `jpeg` is the only lossy option and the only one with a `quality` knob; it loses
to lossless WebP on every file in the corpus, so reach for it for scans, photographic
pages, or a consumer that will not take anything else. Measure your own documents with
`bun run --filter papyra-bench encode`.

`EncodedImage` gives you `bytes`, `toBlob()`, `toBlobUrl()` and `toDataUrl()`. In a
browser prefer `toBlobUrl()` for `<img src>` — base64 inflates by a third and puts a
multi-megabyte string on the heap. `toDataUrl()` is for bytes that must be embedded:
CSS, serialised output, SSR HTML. `img.toDataUrl()` on a `PageImage` does the base64 in
Rust, so neither the pixels nor the encoded bytes ever cross the boundary — only the
finished string.

`renderImage` shares the scheduler with every other render, so priority and concurrency
behave exactly as they do for `render`. Use `doc.imageHandle()` when you want the handle
— to reprioritise, cancel, or read `timing` — the same way `render()` relates to
`renderPage()`. Neither is cached: the cache is keyed by page and size with no format
dimension, and it measures raw bytes.

### SVG

The fourth format is not an encoding of pixels at all. `renderSvg` re-runs the page's
content stream into vector output — paths stay paths, text stays glyph outlines — so
there is no `dpi`, no `fitWidth` and no `quality` to choose:

```ts
const page = await doc.renderSvg(0);
await writeFile('page-0.svg', page.markup);

// Everything an EncodedImage gives you is here too.
img.src = page.toBlobUrl();

// Going on top of something else? Drop the white background — an opaque rectangle
// behind vector artwork is the one thing a consumer cannot undo.
const overlay = await doc.renderSvg(0, { background: 'transparent' });
```

`SvgPage` is an `EncodedImage` whose markup is also readable as a string, since the
usual thing to do with an SVG is inline it rather than hand a browser a URL. `bytes` is
UTF-8, encoded on first access.

The trade is size, and how bad it is depends entirely on how large you were going to
raster. Across the corpus SVG is **8.6x larger than WebP at 150 DPI and 2.9x larger at
400** — the same 7548 KB both times, because vector output has no resolution to grow
with. Conversion costs about what a render's non-preemptible portion does (52 ms for 14
pages, against 42 ms to *encode* pages already rendered), and it comes off the same
scheduler, with `doc.svgHandle()` for the handle. Not cached, for the same reason
`renderImage` is not.

Reach for it when the output has to survive being scaled — print, a drawing someone will
zoom into, an asset going into a design tool. For anything that lands on a screen at a
size you already know, WebP is smaller and paints faster.

## Layout

```
crates/papyra-core     engine-agnostic traits and types
crates/papyra-encode   pure-Rust WebP/PNG/JPEG encoders (SVG comes from hayro-svg)
crates/papyra-hayro    hayro-backed engine
packages/bindings      napi-rs bindings  -> @build-qube/papyra-native
packages/papyra        TypeScript wrapper -> @build-qube/papyra
apps/demo              Vite + React viewer with an in-browser benchmark
apps/bench             Node benchmark vs pdf.js
docs/spike-results.md  measurements and the two wasm bugs behind the design
```

The `papyra-core` trait boundary exists so the engine can be swapped or supplemented
(a native-only pdfium backend is a plausible future addition) without a rewrite.

## Getting started

The toolchain is pinned by `rust-toolchain.toml`; rustup installs it on the first
cargo command, so a local `cargo clippy` is the same compiler CI runs.

```bash
bun install
bun run corpus          # fetch test PDFs from the pdf.js suite (gitignored)
bun run build           # native addon + TypeScript
bun run --filter @build-qube/papyra-native build:wasm
bun run --filter papyra-bench smoke
bun run --filter papyra-bench bench
bun run --filter papyra-bench text      # text extraction vs pdf.js, with coverage
bun run --filter papyra-demo dev
bun run --filter papyra-demo fixtures   # corpus PDFs -> public/, open with ?file=/x.pdf
```

## Two things that will bite you

**The browser build needs cross-origin isolation.** napi-rs generates shared wasm
memory, so `SharedArrayBuffer` must be available. Serve with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`apps/demo/vite.config.ts` sets these; the wrapper warns if `crossOriginIsolated` is
false.

**Concurrency works differently per runtime**, and the wrapper handles it for you:
native uses one async task with rayon inside, wasm uses per-page async tasks capped at
4 in flight. See `docs/spike-results.md` for why — including a memory-growth race and a
rayon deadlock that shaped the design.

## Performance, honestly

- **Node**: ~5.6x pdf.js aggregate on the test corpus (`bun run --filter papyra-bench bench`).
- **Text**: ~15x pdf.js aggregate on the test corpus (`bun run --filter papyra-bench text`),
  at ~0.4ms per page. Read the coverage column with it — see "What it cannot read".
- **Browser**: ~1.3x pdf.js on multi-page throughput, but pdf.js is ~2.3x faster on a
  single page — it draws straight into an accelerated canvas while papyra rasterises on
  the CPU and copies pixels out. papyra's browser win is batch work (thumbnails,
  prerendering, export), not single-page viewing.

Benchmark wasm only in a clean headless browser; an attached debugger suppresses JIT
tiering and inflates timings ~4x. `apps/demo/perf.html` exists for this — see
`docs/spike-results.md`.

## Licence

MIT. Bundles no third-party binaries; see `NOTICE` for linked Rust crates
(hayro is Apache-2.0).
