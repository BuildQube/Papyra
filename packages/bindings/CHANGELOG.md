# @build-qube/papyra-native

## 0.3.0

### Minor Changes

- 0eb1f29: Read the files a PDF embeds.
  
  - `doc.attachments()` lists them — `name`, `description`, `mediaType`, `size`,
    `created`, `modified` and `relationship` — in the order the document files them, and
    resolves to an empty array when there are none, which is the common case. Memoised,
    off the event loop.
  - `doc.attachmentData(index)` decompresses one, by its `Attachment.index`. Split from
    the list on purpose: an embedded file is as large as it is, and listing what a
    document carries is not a reason to decompress all of it.
  - `attachmentMediaType(file)` falls back to the filename's extension, since most
    documents declare no `/Subtype`, and to `application/octet-stream` when neither
    answers.
  - `isInvoiceAttachment(file)` recognises the hybrid-invoice payloads — ZUGFeRD,
    Factur-X, Order-X, XRechnung. Those PDFs are the same invoice twice over, one half
    for a person and one for an accounting system, and a reader that never mentions the
    XML leaves someone retyping figures the file already carries. Matched on the
    standardised filename rather than `relationship` alone, which producers get wrong
    often enough to miss real invoices.
  
  Two things worth knowing. `size` is `/Params /Size` — the document's claim, not a
  measurement, because measuring means decompressing. And `name` prefers `/UF` over `/F`
  over the name the file was filed under, which is the order the spec asks for.
- b0f053c: Add a rotated-view viewport and an annotation switch.
  
  - `viewport(pageSize, { fitWidth, dpi, rotation })` resolves scale and rotation
    together and hands back the `dpi` to render at. Pages still render unrotated — the
    engine has no transform knob, and a canvas turns a bitmap in the draw call for free —
    so `paintToCanvas(page, canvas, { rotation })` applies the turn while painting.
    `rotatePage` shuffles the buffer for the paths with no canvas, such as writing a
    rotated PNG from Node.
  - `viewportRect` and `viewportQuad` put link rectangles and text quads into the
    viewport's space, superseding `scaleRect` and `scaleQuad` for anything drawn over a
    rotated view. Quarter turns keep a rect axis-aligned and keep a quad's corner order,
    so a highlight on rotated text stays at the text's own angle.
    Size through the viewport rather than passing `fitWidth` to `render` directly: turned,
    the width on screen is the page's height, and the two otherwise disagree.
  - `rotateSize` gives a page's dimensions after a rotation, still in points. Separate
    from `viewport` because a layout needs it before a scale exists, and a viewport's
    pixel dimensions are floored to match the renderer's.
  - `RenderOptions.annotations` and `SvgOptions.annotations` turn off the drawing of
    annotation appearance streams — links, highlights, stamps, filled form fields — which
    a viewer painting its own link or highlight layer needs, or every annotation appears
    twice. On by default, honoured by every raster path and by `renderSvg`, and part of
    the render cache key so flipping it re-renders rather than returning the page you
    already had.
  
    A boolean rather than pdf.js's four-way `annotationMode`: that is the whole of what
    the engine exposes, and the modes it has no answer for concern writing form values
    back.
- 4350b67: Read the structure tree of a tagged PDF, and put text into declared reading order.
  
  - `doc.structTree()` walks `/StructTreeRoot` and resolves to a tree of `StructNode` —
    `role`, `content`, `alt`, `actualText`, `lang`, `title`, `children`. Empty for an
    untagged document, which is the common case and the signal to fall back to
    `pageText` alone. One walk per document, memoised, off the event loop.
    `buildStructTree` and `walkStructTree` are exported for the same reasons their
    outline counterparts are.
  - `role` is resolved through the document's `/RoleMap`, so a file that tags its
    headings `Heading1` and maps that onto `H1` reports `H1`. Word, InDesign and Excel
    all emit such files, and matching the raw tag misses them; `rawRole` keeps the
    original where the custom name carries meaning the standard role flattens away.
  - `TextLine.mcid` carries the marked-content id of a line's first glyph, which is what
    joins text to the tree. Absent on an untagged page, and for content the document
    left outside any marked-content sequence — running heads and page numbers, mostly.
  - `readingOrder(text, tree)` puts a page's lines into the order the document declares,
    each paired with the element that claims it, and `structuredPageString` is the
    string form. This is the one ordering extraction cannot otherwise recover: `lines`
    is content-stream order, and a two-column page is free to draw its columns
    interleaved. Lines no element claims go last rather than being dropped, and an
    untagged page comes back untouched.
  
    Lines are still grouped by geometry, deliberately. Breaking a line where a `Span`
    starts would fragment a sentence around its own bold word and regress search, so a
    line is placed by the element that *starts* it — sound for ordering, and not a claim
    that every character in it belongs to that element.

## 0.2.0

### Minor Changes

- 0b71c9c: Export pages as SVG.
  
  `doc.renderSvg(page)` returns vector output — paths stay paths and text stays glyph
  outlines — via hayro's own `hayro-svg` converter. It is not an encoding of a bitmap, so
  it takes no `dpi`, `fitWidth` or `quality`; the only option beyond scheduling is
  `background: 'white' | 'transparent'`. `doc.svgHandle()` gives the handle, for priority,
  cancellation and timing, exactly as `imageHandle` does for raster export.
  
  The returned `SvgPage` is an `EncodedImage` — `bytes`, `toBlob()`, `toBlobUrl()`,
  `toDataUrl()` — plus `markup`, since inlining an SVG is more common than handing a
  browser a URL.
  
  `EncodedFormat` now includes `'svg'`, and `EncodeOptions.format` narrows to the new
  `RasterFormat` (`'webp' | 'png' | 'jpeg'`): a `PageImage` holds pixels and can never
  produce an SVG, so the type now says that.
- e9d30cc: Add links, metadata, page labels, a document fingerprint, and typed password errors.
  
  - `doc.links(index)` reports link annotations — a rectangle, a target, and the
    annotation's tooltip. Rectangles are in the same 72-DPI top-left space as extracted
    text, so a hit region lands on its own glyphs even on a rotated page; `scaleRect`
    takes it to any render. Targets are a discriminated union of an internal destination
    and a URI, and links that resolve to nothing actionable are dropped rather than
    handed over as regions that swallow clicks. Reading them does not go through the
    priority queue.
  - `doc.metadata` reads the information dictionary synchronously, with dates converted
    to ISO 8601.
  - `doc.pageLabels()` resolves the number printed on each page — roman front matter,
    prefixes, letter sequences — and is empty when the document defines none, so a caller
    can tell that from a document asking for plain numbering.
  - `doc.pdfVersion` reports the specification version the file declares, resolving the
    catalog's `/Version` over the header the way the spec asks for.
  - `doc.fingerprint` is a stable sixteen-character key for per-document state. It hashes
    the file rather than reading `/ID`, which the engine exposes no way to reach.
  - `open()` now throws `PasswordRequiredError` when a document is encrypted and no
    password was given, and `IncorrectPasswordError` when one was given and rejected.
    Both extend `PasswordError`, which carries a `retry` flag. Previously both surfaced
    as an untyped parse failure.

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
