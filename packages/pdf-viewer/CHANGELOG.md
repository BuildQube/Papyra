# @workspace/pdf-viewer

## 0.2.0

### Minor Changes

- b0f053c: Rotate the view, and switch the document's own annotations off.
  
  The toolbar gains rotate-left/rotate-right buttons and an annotations toggle, both
  optional: omit `onRotate` or `onAnnotations` and the control is not rendered, on the
  same principle as the existing view-mode toggle. `PdfViewer` and `PdfViewerBasic` wire
  them up, and the store carries the rotation and the switch alongside the view mode.
  
  Rotating costs no render. Pages still rasterise upright; the column re-flows from
  `rotateSize`, `paintToCanvas` turns the bitmap in the draw call, and `PageSurface`'s
  re-submission is a cache hit rather than new work.
  
  `Links` and `Highlights` now take a `pageViewport` instead of a `scale`, so hit regions
  and search highlights follow the rotation with the pixels. **Breaking** for anyone who
  installed those two items directly: pass `viewport(pageSize, { fitWidth, rotation })`
  where you passed a scale. `Thumbnails` and `PageCanvas` take an optional `rotation`, and
  `PageViewHandle.paint` takes one as a second argument.
  
  The items now pin `@build-qube/papyra@^0.3.0` — they call `viewport()`, `rotateSize()`
  and `RenderOptions.annotations`, none of which exist in 0.2.0.
- 4350b67: Show a tagged PDF's structure, and the reading order it declares.
  
  A new `Structure` panel joins the sidebar as a fourth tab, in two views. **Tags** is
  the document's own account of itself — a collapsible tree of `H1`, `P`, `Table`, `TD`
  and the rest — and picking a node outlines that element's content on the page, through
  the same quad overlay search highlights use, so it stays correct on a rotated view.
  **Reading order** lists the current page's lines in the order the document declares,
  against the order the page draws them, and says how many move.
  
  That count is the reason the panel exists. `pageText` reports content-stream order,
  which a two-column page is free to interleave, and no line grouping recovers the
  author's intent from it. On the demo's own `160F-2019.pdf`, 103 of 112 lines move.
  
  - `Highlights` takes an optional `regions`, drawn outlined in the accent colour rather
    than filled, so a selected element reads as a selection rather than a third kind of
    search hit and stays legible over one.
  - The store carries the selection in a `structure` slice, lifted for the reason search
    is: the panel knows which element, and the page overlay is what draws it.
    `ContinuousPages` takes it as a prop and `usePdfStructure` reads it.
  - A tab whose panel is empty now dims its label instead of appending a marker. Four
    tabs plus two markers overflow the 240px column, and a document with neither an
    outline nor a structure tree shows both.
  
  The panel is empty for an untagged document, which is the common case and says so.
- 0eb1f29: Show a document's embedded files.
  
  `Attachments` lists what a PDF carries inside itself, with the declared type and size,
  the document's own description, an inline preview for text and XML, and a button to
  save each one. A hybrid invoice — ZUGFeRD, Factur-X — is called out with a badge,
  because the whole reason to surface attachments in a viewer is that someone reading
  the PDF should know the machine-readable half is already in the file.
  
  It renders **nothing** when a document embeds nothing, rather than an empty state every
  other document scrolls past, so `Properties` carries it unconditionally and looks
  exactly as it did for the documents that have none.

### Patch Changes

- Updated dependencies [0eb1f29]
- Updated dependencies [b0f053c]
- Updated dependencies [4350b67]
  - @build-qube/papyra@0.3.0

## 0.1.0

### Minor Changes

- a81edba: The registry is versioned from here on. It is never published to npm, but its items
  are installed by URL, so this changelog is the only record a consumer of them has of
  what changed under an item's name.
  
  The five blocks moved from `src/components` to `src/blocks`. Installed output is
  unaffected — `shadcn add` takes a file's directory from its `type`, so both land in
  the consumer's `components` alias under the same name — and the built items differ
  only in the `path` string they carry.

### Patch Changes

- Updated dependencies [0b71c9c]
- Updated dependencies [e9d30cc]
  - @build-qube/papyra@0.2.0
