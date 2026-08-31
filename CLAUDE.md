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
bunx shadcn@latest add <component> -c apps/demo   # lands in packages/ui/src/components
bun run --filter papyra-demo fixtures   # copy corpus PDFs into public/ for ?file=/x.pdf
bun run --filter papyra-bench smoke     # quick correctness/sanity pass
bun run --filter papyra-bench bench     # vs pdf.js on the corpus
bun run --filter papyra-bench text      # text extraction vs pdf.js, with coverage
bun run --filter papyra-bench encode    # WebP/PNG/JPEG size and time per page
bun run --filter papyra-bench priority  # also: cache, scaling, large-format
```

Releases go through changesets: `bun run change` to add one, `bun run release` to publish.
`@build-qube/papyra` and `@build-qube/papyra-native` are version-locked (`fixed` in
`.changeset/config.json`); `papyra-demo`, `papyra-bench` and `@workspace/ui` are
ignored. `@workspace/pdf-viewer` is **not** — it is private and never published, but
`privatePackages: { version: true, tag: false }` gives it a version and a CHANGELOG,
because its registry items are installed by URL and that changelog is the only record
a consumer of them has. It is also what a Pages deploy can be gated on, instead of
every push to `main`. `tag: false` keeps it out of the git tags, which name published
packages; being private exempts it from the rule that a dependent of an ignored
package must itself be ignored, which is what lets it depend on `@workspace/ui`.
Because of `updateInternalDependencies: "patch"` a papyra release bumps it too.

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
   tree assembly, link and metadata normalisation, typed password errors, and canvas
   painting. Deliberately in TS so it works identically on both runtimes without
   doubling the Rust surface.

`packages/pdf-viewer` (`@workspace/pdf-viewer`) is the viewer UI as a **shadcn
registry**: private, unbuilt, depending on `@workspace/ui` and `@build-qube/papyra`.
Three things about it are not negotiable, and all three were established against the
real CLI rather than guessed — see `packages/pdf-viewer/README.md`:

- Files import through `@/components/ui/*`, `@/components/*`, `@/lib/*`,
  `@/hooks/*` and `@/lib/utils`. `shadcn build` rewrites **nothing**, and `add`
  rewrites only those forms, so a `@workspace/…` specifier ships verbatim into a
  consumer and breaks. `@/` therefore means this package repo-wide; `apps/demo`
  mirrors the mappings in its tsconfig and vite config, most specific first.
- Filenames are flat and `pdf-`-prefixed: `add` takes the install directory from a
  file's `type`, so every item lands in one directory in the consumer. The five
  blocks live in `src/blocks` and everything else in `src/components`, which is a
  distinction only this repo sees — but `src/blocks` must stay a *sibling* of
  `src/components`, since a subdirectory under the aliased one survives the install.
  A block therefore still imports a sibling block as `@/components/…`; the two
  tsconfigs and the demo's vite alias carry `src/blocks` as a fallback for that.
- Sibling items are named by **absolute URL**: a bare `registryDependencies` entry
  always means an official shadcn item. `scripts/build-registry.ts` substitutes
  `{{REGISTRY}}` and turbo runs it before the demo's build, so the items ship with
  the site. The items pin `@build-qube/papyra@^0.2.0` — they use `pageLabels()`,
  `links()` and `fingerprint`, which the published 0.1.0 does not have, so the
  registry is not installable until that release goes out.
- `globals.css` names this package in an `@source`. Tailwind's detection reaches
  `packages/ui` and whichever app holds the CSS entry, but no further, so a class
  used only here is otherwise never generated — silently, with a plausible
  stylesheet.

Its props are documented under the same gate the wrapper's reference has:
`packages/docs-gen` runs a second TypeDoc pass over the package into
`papyra-registry-api.json`, with `treatValidationWarningsAsErrors`, so an
undocumented prop fails the build. Each file is its own entry point
(`entryPointStrategy: "expand"`) since registry items install one at a time — which
means a `{@link}` across files has no target and cross-item references are code
spans.

`packages/ui` (`@workspace/ui`) sits outside that stack: it is the private home of
every shadcn component, consumed as **source** rather than as a build artifact, so
Tailwind v4's scanner can follow the import graph into it. `apps/demo` is built
entirely from it — there is no hand-written stylesheet left, and
`packages/ui/src/styles/globals.css` is the only CSS file in the app's graph. Two
things live there that semantic tokens cannot express: the API reference's syntax
colours (`--syntax-*`, surfaced as `text-syntax-intrinsic` and friends — a type
keyword is not "less important" than a literal, it is a different thing) and the
`checkerboard` utility behind a transparent SVG. papyra's accent, #6ea8fe, is on
`--primary` and `--ring`; **not** on `--accent`, which in shadcn is the hover
surface. See `packages/ui/README.md`.

Five features beyond rendering follow the same split:

- **Outlines.** `crates/papyra-hayro/src/outline.rs` walks the PDF object graph directly
  — hayro's object layer is public but it exposes no outline API — and returns a **flat,
  pre-order** `Vec<OutlineItem>` whose `level` carries the tree. The tree is rebuilt in
  `packages/papyra/src/outline.ts`, so nothing recursive crosses the napi boundary.
  Destination resolution itself lives in `dest.rs`, not here, because links resolve
  theirs identically; `strings.rs` holds the text-string decoding all three readers need.
- **Links.** `crates/papyra-hayro/src/links.rs` reads `/Annots`, keeps the `/Link`
  subtypes, and resolves each target through the same `dest.rs` resolver the outline
  uses. hayro already *draws* annotations (`InterpreterSettings.render_annotations`) but
  exposes nothing about where they are, which is the difference between showing a link
  and having one. Rects are mapped through `page.initial_transform(true)` — the same
  transform text extraction uses — so a hit region and a highlight share one space.
  Unlike text, links do not go through the priority queue: an object-graph read is
  ~1/1000th of a render, and queueing it behind renders adds latency for nothing.
- **Metadata and page labels.** `crates/papyra-hayro/src/info.rs`. hayro parses the
  information dictionary (`Pdf::metadata`) but returns raw bytes and its own date type;
  page labels it does not touch, so the `/PageLabels` number tree is walked here and
  resolved to one label per page. Labels come back **empty** when the document defines
  none, which is what lets a caller distinguish that from a document that asked for
  plain numbering.
- **Encoding.** `crates/papyra-encode` turns a `Bitmap` into WebP, PNG or JPEG bytes and
  knows nothing about hayro. Every codec is pure Rust — that is the whole constraint,
  since a C codec would put a toolchain in the middle of the wasm build — so WebP is
  lossless VP8L only and there is no AVIF. `image` is already in the tree via hayro, so
  `jpeg` costs no new crates and `webp` costs three tiny ones.
- **SVG.** Deliberately *not* in `papyra-encode`: it is not an encoding of a bitmap but a
  second interpretation of the page, so it lives on the `Document` trait as `page_svg`
  and is implemented in `papyra-hayro` over `hayro-svg`. That is why `EncodeOptions.format`
  takes `RasterFormat` (`webp`/`png`/`jpeg`) while `EncodedFormat` also includes `'svg'` —
  `PageImage` holds pixels and can never produce one. `hayro-svg` needs the same
  `embed-fonts` default feature as `hayro`, for the same reason.
- **Structure (tagged PDF).** `crates/papyra-hayro/src/struct_tree.rs` walks
  `/StructTreeRoot` and returns a **flat, pre-order** `Vec<StructNode>` whose `level`
  carries the tree, exactly as the outline does. The half that cannot be done from
  outside hayro is already there: `Device::begin_marked_content(tag, mcid)` is public
  with a default no-op body, and the interpreter dispatches to it from both `BDC` (with
  the id) and `BMC` (with `None`) — so `text.rs` tags each line with the id that
  produced it and nothing needs a second interpretation pass. Reading order is the
  point of all this, and it is the one ordering content-stream order cannot give.
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
- **View rotation is TypeScript-only, and deliberately not a render option.** hayro's
  `RenderSettings` carries `x_scale`/`y_scale`/`width`/`height`/`bg_color` and nothing
  else, so a rotated render would be a post-hoc buffer shuffle — a copy, a napi field
  and a new cache-key dimension to reproduce what a canvas transform does in the draw
  call. `viewport.ts` holds the whole feature instead: `viewport()` resolves scale and
  rotation together, `viewportRect`/`viewportQuad` turn link regions and text quads
  into the same space, and `paintToCanvas` takes the rotation. Note that
  `putImageData` **ignores the canvas transform**, which is why the rotated path
  blits from a scratch surface via `drawImage` rather than painting directly.
  `rotatePage` does exist for Node, and is the slow path by design.
- **A viewport's `fitWidth` and a render's `fitWidth` are different measurements.**
  The render's fits the page's own width; the viewport's fits the width *on screen*,
  which at 90° is the page's height. `viewport()` floors its dimensions because
  `hayro::render` floors `scaled_width`/`scaled_height` into its pixmap — reporting the
  fractional value would put the viewport a pixel wider than the bitmap it describes
  about half the time.
- **The annotation switch is part of the render cache key.** `RenderOptions.annotations`
  reaches hayro as `InterpreterSettings.render_annotations`, which is a plain bool —
  pdf.js's `enableForms`/`enableStorage` have no analogue because they are about writing
  values back. Since the scheduler coalesces on the key and the LRU is looked up by it,
  `annotationKey()` in `document.ts` appends `:noannots`; without it, asking for a page
  with annotations off is silently served the bitmap that still has them drawn on.
- **Tile rendering is blocked upstream, and would cost N× rather than save.**
  `hayro::render` is ~50 lines and every piece it uses is public *except* `Renderer`
  (`mod renderer;` is private, `Renderer::new` is `pub(crate)`), so it cannot be
  reimplemented with an offset transform from outside the crate; the upstream fix is an
  `Affine::translate` composed into `initial_transform`. Even then: Addendum 10 measured
  that hayro does **no viewport culling** — a 10%-area viewport cost 93.7ms against
  104.6ms for the whole page — so N tiles is roughly N full renders. Tiles buy bounded
  memory and a way past both the 100 MP cap and hayro's `u16` 65535px-per-side ceiling.
  They do not buy speed.
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
- **A structure element's mcids belong to it, not to the last node pushed.** `/K` mixes
  children and content in one array, so `/K [ <</S /Span>> 3 ]` pushes the span before
  the bare `3` that belongs to the *parent*. `struct_tree.rs` threads an owner index
  through the walk rather than appending to `nodes.last_mut()`, and there is a test
  named for the regression.
- **`/RoleMap` is not optional decoration.** A tagged PDF may name its heading
  `/Heading1` and map it to `/H1`; Word, InDesign and Excel all emit such files — the
  corpus's own `160F-2019.pdf` maps `/Workbook` and `/Worksheet`. Matching on the raw
  tag misses those documents entirely, so `role` is post-`/RoleMap` and `raw_role`
  keeps the original. The mapping is followed as a chain, with a visited set: a
  `/RoleMap` naming two tags for each other is malformed and would otherwise spin.
- **`TextLine.mcid` is the line's *first* glyph, and lines are still grouped by
  geometry.** Tagging deliberately does not change line grouping — breaking a line
  where a `/Span` starts would fragment "the **bold** word" into three and regress
  search, which is a shipped feature. So a line that switches element mid-way is filed
  under the element that starts it. That is sound for ordering and wrong as "every
  character here is in that element".
- **Anything walking the PDF object graph needs a cycle guard, not a depth cap.** Real
  files contain cyclic `/Next` and `/Kids` chains. A depth limit does not save a name
  tree whose two `/Kids` point back at it — that branches rather than repeats, so 32
  levels is four billion visits. `outline.rs` (siblings), `dest.rs` (the name tree),
  `info.rs` (the page-label number tree) and `struct_tree.rs` (`/K`, and `/RoleMap`)
  all use a visited set for exactly this.
- **PDF text strings are not Latin-1.** They are UTF-16 or UTF-8 with a BOM, else
  PDFDocEncoding, which differs from Latin-1 precisely in `0x80..=0x9F` — where the em
  and en dashes live. `decode_text_string` in `strings.rs` is the one place this is
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
- **A typed error crosses the napi boundary as a message tag.** napi-rs gives every
  error it throws the same `code`, so `map_err` in the bindings prefixes password
  failures with `papyra/password-required` or `papyra/incorrect-password` and
  `errors.ts` strips the tag before rethrowing a typed error. The two ends have to
  move together; a caller never sees the tag. hayro itself cannot tell a missing
  password from a wrong one — both are `DecryptionError::PasswordProtected` — so the
  distinction comes from whether *we* passed one.
- **`Document.fingerprint` is a content hash, not `/ID`.** hayro exposes `root_id()`
  and `get()` on `XRef` but no trailer accessor, so the identifier the spec defines is
  unreachable. `fingerprint.ts` samples the head, the tail and the length instead —
  the tail matters, because it is where the trailer and therefore `/ID` live. The
  consequence to know: an incremental save changes this where `/ID` would have
  survived.
- **`indexText()` must stay native-only on the rayon path.** It has the same wasm hazard
  as `renderPages`, and falls back to per-page extraction through the scheduler on wasm.
- **Rust coverage comes mostly from the TypeScript tests, not `cargo test`.**
  `packages/bindings` has no `#[test]` in it and the render path is only reachable
  across the napi boundary, so `cargo test --workspace` reports that crate at a flat
  0% and the workspace at 71.24%. `bun run coverage` instead builds the addon with
  LLVM instrumentation, runs every suite against it, and unions the counters — 93.44%,
  with bindings at 89.46%. `scripts/coverage.ts` carries the details. Two things there
  are load-bearing and both fail *silently*, producing a lower but entirely plausible
  number: the addon must be passed to `llvm-cov` as an extra `--object` (which is why
  `cargo llvm-cov report` cannot finish the job — it has no flag for a cdylib), and
  `target/<host-triple>/coverage` must be cleared by hand, since `napi build` writes
  there and `cargo llvm-cov clean` does not look. The script asserts a non-zero
  `packages/bindings/src/lib.rs` at the end for exactly this reason; if that assertion
  fires, the pipeline broke, the tests did not.
- **Bun does not flush the addon's coverage counters on exit.** The instrumentation
  dumps them from an `atexit` handler registered when the addon is dlopened, and Bun
  on Linux leaves the process without running it — the wrapper test stage contributed
  532 covered lines on macOS and 0 in CI, reporting `outline()` and the text paths as
  dead code while their own integration tests passed in that same job. `%c`
  (continuous mode) is the documented fix and needs `-runtime-counter-relocation` on
  Linux plus a `__llvm_prf_cnts` alignment flag at link time on macOS; tried without
  both it silently profiles nothing, which is how it presents. So
  `write_coverage_profile` in `packages/bindings/src/lib.rs`, behind
  `#[cfg(papyra_coverage)]` and absent from every shipped build, is called from
  `test/coverage-entry.ts`'s `afterAll`. That cfg is one `bun run coverage` sets
  itself: keyed on cargo-llvm-cov's own `--cfg=coverage` the hook compiled in locally
  and not in CI, which installs a different version of the tool, and a hook the
  preload cannot find is the same zero all over again — so it throws rather than
  skipping. `bun run coverage` fails if any stage contributes zero, because this
  cost seven points of the Rust total behind a green build.
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
