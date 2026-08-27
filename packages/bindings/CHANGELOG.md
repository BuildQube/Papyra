# @build-qube/papyra-native

## 0.1.0

### Minor Changes

- ddcdd59: Add encoded image output: WebP, PNG and JPEG.
  
  `doc.renderImage(page, opts)` returns a `PageImage` that encodes on demand and never
  hands the raw bitmap to JS — for export, that buffer is pure overhead. `encode(page,
  opts)` encodes a `RenderedPage` you already hold. Both yield an `EncodedImage` with
  `bytes`, `toBlob()`, `toBlobUrl()` and `toDataUrl()`.
  
  Every encoder is pure Rust, so the browser build still needs no C toolchain. Lossless
  WebP is the default: across the test corpus it is ~3x smaller than PNG for about the
  same encode time. JPEG is the only lossy option and the only one that takes a `quality`.
  
  Raw RGBA output, `paintToCanvas` and the render cache are unchanged.
- ea8cca2: Add `Document.imageHandle()`, the handle-returning form of `renderImage`.
  
  `render()` has always returned a handle you can reprioritise, cancel, and read
  `timing` from, while `renderPage()` returns the promise. The export path only had the
  promise form, so a queued encode could not be reprioritised or cancelled by handle, and
  could not report how long it spent waiting versus rendering. `imageHandle()` closes
  that gap; `renderImage()` is now `imageHandle(...).promise`.
- 479fee5: Add text extraction and search: `doc.pageText()`, `doc.search()`, `doc.indexText()`.
  
  Extraction is built on `hayro_interpret::Device`, so encodings, `ToUnicode` cmaps, CID
  and Type3 fonts and the graphics-state transform all arrive resolved. Coordinates come
  from the same transform the renderer uses, so text lands in the same space as the
  pixels — page rotation and crop box included — and scaling to a render is one multiply.
  
  Glyphs are grouped into lines and word spaces are reconstructed from the gap between
  each glyph's end and the next glyph's start; PDF encodes a word break as a position
  change at least as often as it writes a space character.
  
  `search()` streams matches as each page is read, in whatever page order the caller
  gives — a viewer wants to search outward from the page on screen. Matching is case- and
  diacritic-insensitive by default, expands ligatures, collapses whitespace, and runs
  across line breaks, returning one quadrilateral per line a match covers. Geometry is
  stored along the baseline rather than as rectangles, so rotated text gets a highlight at
  its own angle.
  
  `PageText.undecodedGlyphs` reports glyphs no encoding could map back to Unicode, which
  separates "this page has no text" from "this page has text nothing can read".
  
  Also: `Scheduler` is no longer parameterised by payload, so renders and text extraction
  share one priority queue.
- 479fee5: Add `doc.outline()` — the document outline (bookmarks) as a tree.
  
  hayro defines the `/Outlines` key but never reads it, so papyra walks the object graph
  itself. Explicit destination arrays, name trees, the legacy `/Dests` catalog dictionary
  and `GoTo` actions all resolve to a page index plus the destination's view (`XYZ`,
  `FitH`, …); `GoToR` and `URI` point outside the document and surface as `dest: null`,
  as do containers that group children without a destination of their own. Both are kept
  rather than dropped, since removing a container would reparent its children.
  
  Cyclic `/Next` and `/Kids` chains — which real files do contain — terminate rather than
  hang. Titles are decoded from UTF-16, UTF-8 or PDFDocEncoding; the last of these
  matters because em and en dashes live exactly where PDFDocEncoding and Latin-1 disagree.
  
  The walk runs off the event loop and the result is memoised per document.

## 0.0.4

## 0.0.3

### Patch Changes

- 4fb8f70: Declare the wasm flavour as an optional dependency of the root binding package.
  
  napi omits it by default so Node consumers do not download a wasm binary they
  will never load. papyra publishes `browser.js`, which re-exports that package by
  name, so the default left browser bundlers with an unresolvable import.

## 0.0.2

### Patch Changes

- 25382b1: Bump emnapi to 2.0.0-alpha.4 so the wasm target links on current Rust.
  
  `@napi-rs/cli` 3.8.6 unconditionally passes `--export=emnapi_create_env` and
  `--export=emnapi_delete_env` to `wasm-ld`. Those symbols exist in emnapi 2.x but
  not in 1.11.x, and from Rust 1.98 the bundled `rust-lld` treats exporting an
  undefined symbol as an error rather than ignoring it, so the wasm build failed to
  link. 2.0.0-alpha.4 is within the peer range `@napi-rs/cli` declares.
- 619e420: Move the build toolchain to TypeScript 7.
  
  Build tooling only: the emitted `.js` and `.d.ts` are byte-identical to the previous
  TypeScript 5.9 output (only source map mappings differ), so there is no change to the
  published API or to runtime behaviour.
