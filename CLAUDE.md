# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

papyra renders PDFs fast in both Node and the browser from a single Rust core. The
rendering engine is [hayro](https://github.com/LaurenzV/hayro) (pure Rust, compiled in —
no pdfium binaries are shipped). `napi build` produces the native addon *and* the browser
wasm bundle; there is no wasm-pack/emscripten step.

`README.md` is the user-facing API guide. `docs/spike-results.md` is the measurement log
and the source of truth for every "why is it like this" question — the wasm memory-growth
race, the rayon-on-wasm deadlock, the per-draw-call (not per-pixel) render cost. Read it
before changing anything about concurrency, memory, or build targets.

## Commands

Bun is the package manager (pinned `bun@1.3.11`); turbo orchestrates the workspace.

```bash
bun install
bun run corpus          # fetch test PDFs from pdf.js's suite into ./corpus (gitignored)

bun run build           # napi native addon + tsc for the TS packages
bun run --filter @build-qube/papyra-native build:wasm   # wasm32-wasip1-threads
bun run --filter @build-qube/papyra-native build:debug  # unoptimised native addon

bun run test            # pure-TypeScript units — no addon, no corpus, no build
bun run test:integration  # wrapper against a real addon + fetched corpus
bun run test:rust       # cargo test --workspace
bun run test:all        # all three

bun run typecheck
bun run coverage        # both languages, one run -> coverage/{rust,ts}.lcov
bun run coverage:report # ... -> summary.json, badge SVGs, the PR comment body
bun run --filter papyra-docs-gen build   # regenerate the API model for /docs
bun run lint            # biome check
bun run format          # biome --write + cargo fmt + taplo format
bun run check           # biome + cargo fmt --check + clippy -D warnings (what CI runs)
```

Single tests:

```bash
bun test packages/papyra/test/unit/scheduler.test.ts     # one file
bun test packages/papyra/test/unit/scheduler.test.ts -t "coalesce"   # one by name
cargo test -p papyra-hayro pdf_is_send_and_sync          # one Rust test
```

**`test/unit` and `test/integration` are split on purpose.** CI's `unit-test` job runs
with no Rust toolchain, no build and no corpus, so anything under `test/unit` must not
import the wrapper's entrypoint — `document.ts` loads the native addon at module scope
and would fail the whole job. Type-only imports from `@build-qube/papyra-native` are
fine; they are erased. Tests needing a real artifact go in `test/integration`, which the
`smoke` job runs against a downloaded binding.

Apps (both need `bun run corpus` first; the demo also needs the wasm build):

```bash
bun run --filter papyra-demo dev        # Vite + React viewer at :5173
bun run --filter papyra-demo fixtures   # copy corpus PDFs into public/ for ?file=/x.pdf
bun run --filter papyra-bench smoke     # quick correctness/sanity pass
bun run --filter papyra-bench bench     # vs pdf.js on the corpus
bun run --filter papyra-bench text      # text extraction vs pdf.js, with coverage
bun run --filter papyra-bench encode    # WebP/PNG/JPEG size and time per page
bun run --filter papyra-bench priority  # also: cache, scaling, large-format
```

Releases go through changesets: `bun run change` to add one, `bun run release` to publish.
`@build-qube/papyra` and `@build-qube/papyra-native` are version-locked (`fixed` in
`.changeset/config.json`); `papyra-demo` and `papyra-bench` are private and ignored.

## Architecture

Four layers, each with a deliberate boundary:

1. **`crates/papyra-core`** — engine-agnostic `Engine`/`Document` traits plus `Bitmap`,
   `PageSize`, `RenderOptions`. No PDF library depended on. This boundary exists so a
   second backend (e.g. native-only pdfium) can be added without a rewrite; keep
   engine-specific types out of it.
2. **`crates/papyra-hayro`** — the hayro implementation. Also holds the rayon batch path.
   hayro's `RenderCache<'a>` borrows the document, so it cannot be stored on
   `HayroDocument` without a self-referential wrapper; instead `render_pages` shares one
   cache across a batch and `render_pages_parallel` builds a per-worker cache via
   rayon's `map_init` (the cache is `Rc`-based, so not `Send`).
3. **`packages/bindings`** (`papyra-bindings` crate → `@build-qube/papyra-native`) — napi-rs
   surface. Thin: load, `pageCount`, `pageSize`, `renderPageAsync`, `renderPagesAsync`,
   plus `runtime()`, `configureThreadPool()`, `reserveMemory()`. Everything ergonomic lives
   in TypeScript, not here.
4. **`packages/papyra`** (`@build-qube/papyra`) — the public API and where the real logic
   is: the priority scheduler, the byte-bounded LRU render cache, `fitWidth`→DPI
   resolution, source normalisation (`Uint8Array`/`ArrayBuffer`/`Blob`/`File`), outline
   tree assembly, and canvas painting. Deliberately in TS so it works identically on both
   runtimes without doubling the Rust surface.

Three features beyond rendering follow the same split:

- **Outlines.** `crates/papyra-hayro/src/outline.rs` walks the PDF object graph directly
  — hayro's object layer is public but it exposes no outline API — and returns a **flat,
  pre-order** `Vec<OutlineItem>` whose `level` carries the tree. The tree is rebuilt in
  `packages/papyra/src/outline.ts`, so nothing recursive crosses the napi boundary.
- **Encoding.** `crates/papyra-encode` turns a `Bitmap` into WebP, PNG or JPEG bytes and
  knows nothing about hayro. Every codec is pure Rust — that is the whole constraint,
  since a C codec would put a toolchain in the middle of the wasm build — so WebP is
  lossless VP8L only and there is no AVIF. `image` is already in the tree via hayro, so
  `jpeg` costs no new crates and `webp` costs three tiny ones.
- **Text and search.** `crates/papyra-hayro/src/text.rs` implements
  `hayro_interpret::Device` and collects glyphs, which is how encodings, `ToUnicode`
  cmaps, CID and Type3 fonts, and the graphics-state transform all arrive already
  resolved. Rust does the part hayro cannot — grouping glyphs into lines and putting the
  spaces back. Matching itself (`search.ts`) is pure TypeScript over the extracted text,
  because it is string work with no reason to cross the boundary twice.

Text geometry is stored **along the baseline** — an origin, a unit direction, and a
distance per character — not as a rectangle per glyph. That is a tenth the payload and
it is what makes a highlight on rotated text a quadrilateral at the text's own angle.
`lineQuad` in `packages/papyra/src/text.ts` is the one place that reconstructs it.

`apps/demo` is a Vite/React viewer (plus `perf.html`, a React-free wasm probe);
`apps/bench` is the Node benchmark suite against pdf.js.

**The API reference is generated, not written.** `packages/docs-gen` runs TypeDoc over
`packages/papyra/src` and emits its serialised model to `apps/demo/public/papyra-api.json`;
the demo's `/docs` route renders that model itself (`src/components/docs/`) so the
reference is styled like the rest of the site rather than like a second, foreign one.
The model is fetched at runtime, which is why it lives in `public/` — 144 KB of API
surface stays out of every JS bundle, and `tsc` never has to infer a type for it.

`packages/papyra/README.md` opens that page, via TypeDoc's `readme` option, which puts
it in the model as the same comment token stream everything else uses — so the
quickstart and the reference render through one path and no markdown parser is
involved. It is the npm landing page as well, so keep it portable: plain markdown, no
TSDoc-only syntax like `{@link}`. The root `README.md` stays the long-form guide;
this one is the quickstart, and the two should not grow into each other.

Because the source of truth is the wrapper's own TSDoc, **an exported member with no
doc comment fails the build** — `treatValidationWarningsAsErrors` in
`packages/docs-gen/typedoc.json` turns TypeDoc's `notDocumented` warning into a
non-zero exit, and `bun run typecheck` reaches it through turbo. That is the whole
gate; CI needed no new job.

### Things that will surprise you

- **`packages/bindings` ships no checked-in `index.js`/`index.d.ts`** — napi generates them
  at build time, and they are gitignored. Anything downstream (typecheck included) fails
  until `bun run build` has run. This is why turbo's `typecheck` task `dependsOn ^build`
  and why the CI typecheck job installs a Rust toolchain.
- **Concurrency strategy differs per runtime, and the TS wrapper picks it.** Native:
  one async task with rayon inside (independent of `UV_THREADPOOL_SIZE`, which an addon
  cannot set). wasm: per-page async tasks, capped at 4 — napi-rs hardcodes
  `asyncWorkPoolSize = 4` in its browser glue, and rayon's wasm workers are Web Workers
  the JS event loop must create, so a rayon batch cannot be driven from a blocked thread.
  See `MAX_WASM_CONCURRENCY` in `runtime.ts` and `renderPages` in `document.ts`.
- **Never return napi `Buffer` from a task.** `napi_create_external_buffer` needs
  `globalThis.Buffer`, which exists in Node and not in a browser, so an addon that
  returns one works everywhere except the target papyra exists to support. Return
  `Uint8Array` (external arraybuffer), as `RenderedPage.data` and the encoders do.
  `NAPI_RS_FORCE_WASI` does not catch this — it runs the wasm build under *Node*, where
  `Buffer` is defined. Only a real browser does.
- **The browser build requires cross-origin isolation.** napi-rs generates shared wasm
  memory, so consumers must serve `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. `apps/demo/vite.config.ts` sets both.
- **wasm heap is pre-grown on first load** (`reserveMemory`, 256 MiB default). Concurrent
  workers hitting `memory.grow` on a cold heap trap intermittently. Do not remove.
- **`panic = "abort"` is deliberately absent** from the release profile: papyra parses
  untrusted PDFs and napi-rs turns caught panics into JS exceptions, so a malformed file
  must reject a promise rather than kill the host process.
- **`.cargo/config.toml` forces `+simd128` for wasm** — vello_cpu is a SIMD rasteriser and
  is ~1.7x slower without it.
- **Size renders with `fitWidth`, not `dpi`.** Page sizes vary by two orders of magnitude
  in area; `document.ts` rejects anything over 100 MP with a message pointing at
  `fitWidth`. Only the single-page path (`render`/`renderPage`/`stream`) is cached —
  `renderPages` is a throughput API and would evict everything useful in one call.
- **Running work is never cancelled or preempted**, only reordered while pending. A render
  is dominated by a non-preemptible content-stream interpretation cost (~95ms of a ~150ms
  render on a large drawing, independent of output size), so cancelling mid-render would
  reclaim only the rasterisation tail. `yieldToUrgent` exists because queue ordering alone
  is insufficient — a started job competes for CPU for its whole duration.
- **Benchmark wasm only in a clean headless browser.** An attached debugger suppresses JIT
  tiering and inflates timings ~4x.
- **Anything walking the PDF object graph needs a cycle guard, not a depth cap.** Real
  files contain cyclic `/Next` and `/Kids` chains. A depth limit does not save a name
  tree whose two `/Kids` point back at it — that branches rather than repeats, so 32
  levels is four billion visits. `outline.rs` uses a visited set for exactly this.
- **PDF text strings are not Latin-1.** They are UTF-16 or UTF-8 with a BOM, else
  PDFDocEncoding, which differs from Latin-1 precisely in `0x80..=0x9F` — where the em
  and en dashes live. `decode_text_string` in `outline.rs` is the one place this is
  handled; reuse it rather than reaching for `from_utf8_lossy`.
- **Text extraction coordinates come from `page.initial_transform(true)`**, the same
  transform the renderer uses. That is what makes text land in the same space as the
  pixels on a rotated page or a non-zero crop box. Deriving them any other way puts
  every highlight a quarter turn out on exactly the documents that need it.
- **`hayro/embed-fonts` is load-bearing for text**, and only reaches us transitively
  through the `hayro` dependency's default features. Without it the 14 standard fonts
  resolve to nothing and every page that does not embed its fonts extracts empty. There
  is a note in `crates/papyra-hayro/Cargo.toml`; do not "tidy" that dependency away.
- **`Glyph::as_unicode()` returning `None` is a real and common outcome**, not an edge
  case. Word-generated Cambria/Calibri subsets carry no `ToUnicode` cmap and name every
  glyph `gNN` in both the `/Differences` and the CFF `/CharSet`, so no Unicode exists
  anywhere in the file. Never silently drop those: `PageText.undecoded_glyphs` counts
  them so a caller can tell "no text" from "text nobody can read".
- **Do not compare text extraction to pdf.js by character count.** On a font like the
  above pdf.js emits the raw character codes as if they were Unicode — 38,426 of its
  59,313 characters on `TAMReview.pdf` are C0 controls. `bun run --filter papyra-bench
  text` splits usable from control characters for exactly this reason; a raw count
  ranks a tool that emits junk above one that admits it cannot read the page.
- **TypeDoc cannot run on this repo's TypeScript.** `typescript@7` is the Go rewrite,
  and its main entry exports exactly two symbols (`version`, `versionMajorMinor`) — the
  compiler API TypeDoc calls (`ts.createProgram`, the type checker) is gone, and
  TypeStrong/typedoc#3098 is feature-frozen on it with no timeline. So
  `packages/docs-gen` pins its own `typescript@5.9.3`; bun nests it and the root stays
  on 7. Do not "unify" those versions, and do not add `typedoc` to a package that
  resolves TypeScript 7 — it fails at `createProgram` with nothing useful in the error.
- **Rust coverage comes mostly from the TypeScript tests, not `cargo test`.**
  `packages/bindings` has no `#[test]` in it and the render path is only reachable
  across the napi boundary, so `cargo test --workspace` reports that crate at a flat
  0% and the workspace at 69.52%. `bun run coverage` instead builds the addon with
  LLVM instrumentation, runs every suite against it, and unions the counters — 91.61%,
  with bindings at 83.38%. `scripts/coverage.ts` carries the details. Two things there
  are load-bearing and both fail *silently*, producing a lower but entirely plausible
  number: the addon must be passed to `llvm-cov` as an extra `--object` (which is why
  `cargo llvm-cov report` cannot finish the job — it has no flag for a cdylib), and
  `target/<host-triple>/coverage` must be cleared by hand, since `napi build` writes
  there and `cargo llvm-cov clean` does not look. The script asserts a non-zero
  `packages/bindings/src/lib.rs` at the end for exactly this reason; if that assertion
  fires, the pipeline broke, the tests did not.
- **Each coverage stage needs its own `LLVM_PROFILE_FILE`.** cargo-llvm-cov's
  default pattern ends in `%18m` — online merging, where writers share a pool of 18
  files. That is only valid between processes running the same coverage map, and
  here the writers are a cargo test binary, node loading the addon and bun loading
  the addon. On a pool collision LLVM discards the mismatched counters silently, and
  which writer loses depends on timing: this reproduced on Linux CI and never on
  macOS, reporting the outline and text paths 23 points low with all 73 tests
  passing. `scripts/coverage.ts` overrides the pattern per stage with a plain `%p`;
  llvm-profdata merges everything at the end, which is where merging belongs.
- **There is no coverage service.** `scripts/coverage-report.ts` writes the badge
  SVGs and the PR comment body itself, so CI needs only `GITHUB_TOKEN` — no account,
  no repo activation, no secret. Badges are force-pushed to an orphan `badges`
  branch from a scratch repo, so main's history stays clean and the branch never
  grows a commit per run; the README points at raw.githubusercontent.com. The delta
  column comes from the last green `main` run's `coverage-summary` artifact, which
  is advisory — the first run has no baseline and the column renders empty. Adding
  a service later would mean deleting this, not working around it.
- **Bun's lcov lists only files a test imported.** A module nobody touches is not 0%,
  it is absent, and the percentage is computed over what remains — `bun test
  test/unit` covers 6 of the 13 files in the wrapper, silently omitting `document.ts`.
  `packages/papyra/test/coverage-entry.ts` is preloaded solely to import the package
  entrypoint and drag the rest into the denominator. There is no `--coverage.all`.
- **`indexText()` must stay native-only on the rayon path.** It has the same wasm hazard
  as `renderPages`, and falls back to per-page extraction through the scheduler on wasm.

## Conventions

- Rust: 2-space indent (`rustfmt.toml`), edition 2024. `clippy -D warnings` gates CI.
- **`rust-toolchain.toml` pins the compiler**, so a plain `cargo clippy` here is the
  same compiler CI runs — that was not true before, and a lint arriving in a new stable
  (`chunks_exact_to_as_chunks`, in 1.98) failed CI against a clean local run. Bumping
  `channel` is its own commit: raise it, run
  `cargo clippy --workspace --all-targets -- -D warnings`, fix what the new release
  found.
- **The pin is not the MSRV.** `rust-version` in `Cargo.toml` is 1.92 and governs what
  consumers need; verify it with `cargo +1.92 check --workspace`, since an explicit
  `+toolchain` overrides the file.
- **`dtolnay/rust-toolchain` does not read `rust-toolchain.toml`.** Its `targets:`
  input would install to whatever `@stable` resolves to that day, leaving the pinned
  toolchain without the target, so the build matrices in `CI.yml` and `release.yml`
  use `rustup target add` instead. Adding a target to a job means adding that line,
  not that input.
- TS/JS: biome, 2-space, single quotes, 80 cols. `verbatimModuleSyntax` and
  `noUncheckedIndexedAccess` are on; imports use explicit `.js` extensions.
- TOML: `taplo format`.
- Comments in this codebase explain *why*, usually with a measured number attached. Match
  that: a comment restating the code is worse than none.
- A pre-commit hook (husky + lint-staged) runs `bun run build`, `cargo fmt`, and
  `cargo clippy --fix` whenever a `.rs` file is staged — expect commits touching Rust to
  take a while.
- The `rust-best-practices` skill is vendored at `.agents/skills/rust-best-practices`
  (symlinked into `.claude/skills`); consult it when writing or reviewing Rust here.
