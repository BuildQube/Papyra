# papyra

[![CI](https://github.com/BuildQube/Papyra/actions/workflows/CI.yml/badge.svg)](https://github.com/BuildQube/Papyra/actions/workflows/CI.yml)
[![coverage](https://raw.githubusercontent.com/BuildQube/Papyra/badges/coverage.svg)](https://github.com/BuildQube/Papyra/actions/workflows/CI.yml)
[![rust coverage](https://raw.githubusercontent.com/BuildQube/Papyra/badges/coverage-rust.svg)](https://github.com/BuildQube/Papyra/actions/workflows/CI.yml)
[![typescript coverage](https://raw.githubusercontent.com/BuildQube/Papyra/badges/coverage-ts.svg)](https://github.com/BuildQube/Papyra/actions/workflows/CI.yml)

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

## Engines

`open()` renders through papyra's own engine. Three more cover what it cannot reach,
and the [viewer components](packages/pdf-viewer/README.md) take whichever the app
names. Each is a class with the same commands — `open`, `render`, `stream`, `search`,
`outline`, `links`, `close` and the rest — and the same priority queue, render cache
and `fitWidth` sizing.

| Engine | Import | Renders | Needs | Costs |
| --- | --- | --- | --- | --- |
| `PapyraEngine` | `@build-qube/papyra/engine` | PDF, natively in Node, in wasm in a browser | a cross-origin-isolated page | about 2.5 MB of wasm gzipped |
| `PdfjsEngine` | [`@build-qube/papyra-pdfjs`](packages/pdfjs/README.md) | PDF, on pdf.js | `pdfjs-dist` | pdf.js's own text positions; no structure tree |
| `TauriEngine` | [`@build-qube/papyra-tauri`](packages/tauri/README.md) | PDF, natively in a Tauri app's host process | [`tauri-plugin-papyra`](crates/tauri-plugin-papyra/README.md) in the app | no wasm at all |
| `PapyraOfficeEngine` | `@build-qube/papyra/office` | Word and PowerPoint pages, experimentally | [`@build-qube/papyra-office-native`](packages/office-bindings/README.md), and isolation in a browser | a second wasm module, about 5.9 MB gzipped at the current engine pin |

**Picking one.**

- **You can set response headers.** Use papyra's, and serve the isolation headers
  (see [Three things that will bite you](#three-things-that-will-bite-you)). It has
  every feature here, reads text more exactly than pdf.js, and wins on batch work —
  thumbnails, prerendering, export. pdf.js is faster to a single page in a browser;
  see [Performance, honestly](#performance-honestly).
- **The page cannot be isolated** — a mobile WebView, an app embedding third-party
  content, a host whose headers you do not control. Use pdf.js. Name both engines
  and the viewer takes papyra's where the page allows it and pdf.js elsewhere.
- **A Tauri app.** Use `TauriEngine`: no wasm and no isolation, and the output and
  features are papyra's, because it is papyra in the app's Rust process.
- **Word and PowerPoint.** Add the office engine beside your PDF engine. It draws
  pages only — no text, links or outline. Register metric-compatible fonts (Carlito
  for Calibri, and so on) with `officeEngine.addFont`, or pagination drifts from
  Word's.

**Installing.** papyra's engine and the office engine ship in `@build-qube/papyra`;
the office addon is an optional peer, so a PDF-only app never downloads it. The pdf.js
and Tauri engines are packages of their own — their READMEs, linked above, have the
commands.

```bash
npm install @build-qube/papyra @build-qube/papyra-office-native
```

**Which entry to import.**

- `@build-qube/papyra` — everything but the office engine, plus `open()`. Loads
  papyra's addon when imported.
- `@build-qube/papyra/core` — everything that runs without an engine: painting,
  viewports, search, the error types, `PagedEngine` and `PdfEngine`. Nothing in it
  reaches papyra's wasm, so import from here whenever another engine opens the
  documents; a bundler emits the wasm as soon as its graph reaches it, fetched or not.
- `@build-qube/papyra/engine` (`PapyraEngine`, and `defaultPdfEngine`, the instance
  `open()` uses) and `@build-qube/papyra/office` (`PapyraOfficeEngine`,
  `officeEngine`) — each fetches its addon on the first open, not on import.

```ts
import { paintToCanvas } from '@build-qube/papyra/core';
import { PdfjsEngine } from '@build-qube/papyra-pdfjs';

const engine = new PdfjsEngine({ workerSrc });
const doc = await engine.open(file);
paintToCanvas(await engine.render(doc, 0, { fitWidth: 1200 }).promise, canvas);
await engine.close(doc);
```

A document belongs to the engine that opened it: hand it back to that engine and no
other. `doc.capabilities` says which commands the engine can answer for it — a viewer
hides the panels it cannot fill.

**In the viewer.** The `pdf-engine` registry item puts an engine in scope:

```tsx
import { defaultPdfEngine } from '@build-qube/papyra/engine';
import { PdfjsEngine } from '@build-qube/papyra-pdfjs';
import { PdfEngineProvider } from '@/components/pdf-engine';

const pdfjs = new PdfjsEngine({ workerSrc });

<PdfEngineProvider engine={[defaultPdfEngine, pdfjs]}>{app}</PdfEngineProvider>;
```

- `PdfEngineProvider` takes an engine, or a list to take the first available from.
  It chooses once, on mount. Without one, every viewer uses `defaultPdfEngine`, so a
  `Document` from `open()` works with no provider at all.
- `PdfEngineGuard` renders its children only when the engine in scope can run on this
  page, and otherwise says why — for papyra's, the missing headers. Every PDF block
  and `file-preview-pdf` already wrap themselves in it; wrap your own composition of
  the pieces the same way. `EngineGuard` is the same for an engine you pass in.
- `PageEngineScope` renders the page column below it through another engine, and
  `usePageEngine()` reads it; everything else keeps using `usePdfEngine()`. That is
  how a Word document shows in the PDF viewer's column:

  ```tsx
  import { officeEngine } from '@build-qube/papyra/office';
  import { EngineGuard, PageEngineScope } from '@/components/pdf-engine';

  <EngineGuard engine={officeEngine}>
    <PageEngineScope engine={officeEngine}>{pages}</PageEngineScope>
  </EngineGuard>;
  ```

  The `file-preview-docx-paged` and `file-preview-pptx` items are this, inside the
  file preview, with a `fonts` option for `addFont`.

An app that never runs papyra's PDF engine also aliases the viewer's default away, so
none of its wasm is bundled: see
[Keeping papyra's wasm out of the bundle](packages/tauri/README.md#keeping-papyras-wasm-out-of-the-bundle),
which is the same for pdf.js.

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

## Links

```ts
const scale = rendered.width / doc.pageSize(index).width;

for (const link of await doc.links(index)) {
  const { x, y, width, height } = scaleRect(link.rect, scale);
  if (link.target.kind === 'uri') openExternally(link.target.uri);
  else goTo(link.target.dest.page);
}
```

hayro *draws* annotations, so a link's border already lands in the bitmap — but nothing
told you where it was or where it went, which is the difference between showing a link
and having one. `doc.links(index)` closes that: a rectangle, a target, and the
annotation's tooltip as `alt`.

Rectangles are in the **same space as the extracted text** — pixels from the top-left at
72 DPI, rotation and crop box applied — because both go through the transform the
renderer uses. That is what makes a hit region land on its own glyphs on a rotated
sheet. `scaleRect` takes it to any render.

Targets are a discriminated union, so `kind` narrows to the payload with no non-null
assertion. Only links that resolve to something actionable are reported: a `/Link`
pointing at a page the document does not contain, or carrying `GoToR`, `Launch` or
`JavaScript`, is dropped rather than handed over as a region that swallows clicks.
Hidden annotations are skipped too.

Reading links never interprets a content stream — it is an object-graph walk, roughly a
thousandth the cost of rendering the page — so unlike text extraction it does **not**
go through the priority queue. Making a link layer wait behind renders would add
latency you can feel, for work that costs nothing. Results are cached and concurrent
reads of one page share a single task.

## Rotation

papyra renders pages unrotated — hayro has no transform knob, and turning a bitmap is a
copy nobody needs when a canvas can do it in the draw call. A rotate button is therefore
a viewer-side construction, and `viewport()` is where that construction is written down:

```ts
const vp = viewport(doc.pageSize(index), { fitWidth: 1600, rotation: 90 });

const page = await doc.renderPage(index, { dpi: vp.dpi });
paintToCanvas(page, canvas, { rotation: vp.rotation });

for (const link of await doc.links(index)) {
  place(hitbox, viewportRect(link.rect, vp));
}
```

`fitWidth` is the reason to size through a viewport rather than passing it to `render`
directly: at 90° the width on screen is the page's *height*, so the two mean different
things the moment the page is turned. The viewport resolves that and hands back the
`dpi` the unrotated render needs — and floors its dimensions the way the renderer floors
its pixmap, so `vp.width` is the bitmap's width and not a pixel more.

`viewportRect` and `viewportQuad` supersede `scaleRect` and `scaleQuad` for anything
drawn over a rotated view — the same scale, plus the turn — so a link region and a text
highlight cannot disagree with the pixels about which way is up. Quarter turns keep a
rect axis-aligned and keep a quad's corner order, since rotating the page rotates the
text with it.

Outside a browser there is `rotatePage`, which shuffles the buffer. Prefer the canvas
where you have one: `paintToCanvas` rotates in the draw call, while `rotatePage` copies
7 MB for a 1600px ARCH-E sheet.

## Annotations

Renders draw annotations — links, highlights, stamps, filled form fields — because that
is what a viewer is expected to show. Turn them off when you are drawing them yourself:

```ts
const page = await doc.renderPage(index, { fitWidth: 1600, annotations: false });
```

A viewer painting its own link or highlight layer over the bitmap otherwise shows every
annotation twice, once from the document's appearance stream and once from its own. The
switch reaches every raster path — `render`, `renderPage`, `renderPages`, `stream`,
`renderImage` — and `renderSvg`, where it matters more, since a baked-in link border is
not removable from vector output afterwards. It is part of the cache key, so flipping it
re-renders rather than handing back the page you already had.

A boolean rather than pdf.js's four-way `annotationMode`: that is the whole of what the
engine offers, and the two modes it has no answer for are about writing form values
back, which papyra does not do.

## Metadata, page labels and identity

```ts
doc.metadata.title;              // null when the document never said
doc.metadata.created;            // ISO 8601 — `new Date(...)` parses it
doc.pdfVersion;                  // '1.7'
doc.fingerprint;                 // stable key for what you remember per document

const labels = await doc.pageLabels();
const shown = labels[index] || String(index + 1);
```

`metadata` is synchronous, because the engine reads the information dictionary while
loading. Every field is independently `null`, and none of it is verified — `title` is
frequently a filename or missing, so fall back to your own.

`pdfVersion` is deliberately not one of `metadata`'s fields: those are what the
producer chose to say about the document, while the version is a structural property of
the file. It comes from the header, or from the catalog where that overrides it — so an
incrementally saved file reports the version it was last written as. Treat `'1.0'` with
suspicion: genuine PDF 1.0 files are close to extinct, and it is also what a file with
an unreadable header reports.

`pageLabels()` is the number *printed on the page*, which is not the index: a document
with front matter numbers its first pages i, ii, iii, and a viewer that says "page 4 of
300" when the sheet reads "A101" is describing a document nobody else can see. It
resolves to an **empty array** when the document defines no labels, which is the signal
to number by index yourself — a document that defines labels but says nothing about one
page gives that page an empty string, which is a different answer.

`fingerprint` is sixteen hex characters for keying per-document state — the page it was
left on, a zoom, a set of highlights. It is a hash of the file rather than the PDF's own
`/ID`, which hayro exposes no way to reach; the practical difference is that an
incremental save changes it. It samples the tail as well as the head, so a file that
does carry an `/ID` still feeds it in, since `/ID` lives in the trailer.

## Encrypted documents

```ts
try {
  doc = await open(file, { password });
} catch (e) {
  if (e instanceof PasswordError) showDialog({ retry: e.retry });
  else throw e;
}
```

`PasswordRequiredError` and `IncorrectPasswordError` are separate because a viewer
responds differently — one asks, the other says the last answer was wrong — and both
extend `PasswordError` because the dialog is the same one either way. The underlying
engine reports a single "password-protected" for both; papyra can tell them apart
because it knows whether a password was passed.

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
packages/office-bindings  Word and PowerPoint addon -> @build-qube/papyra-office-native
packages/pdfjs         pdf.js engine     -> @build-qube/papyra-pdfjs
packages/tauri         Tauri engine      -> @build-qube/papyra-tauri
packages/pdf-viewer    the viewer, as a shadcn registry
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

## Three things that will bite you

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

**A panic in the browser build is fatal to that module.** Natively, a Rust panic on a
malformed file becomes a rejected promise. The wasm build cannot unwind: a panic
aborts the instance, and every later call into that module fails until the page
reloads. The PDF and office addons are separate instances, so one going down leaves
the other working. There is no recovering in place: offer a reload, not a retry.

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
