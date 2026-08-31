---
'@workspace/pdf-viewer': minor
---

Rotate the view, and switch the document's own annotations off.

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
