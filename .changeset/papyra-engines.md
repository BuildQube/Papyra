---
'@build-qube/papyra': minor
---

Engines. `PagedEngine` and `PdfEngine` in `@build-qube/papyra/core` hold the
priority queue, the render and text caches, `fitWidth` and search, written once; an
engine supplies a loader and a backend and gets all of it. `PapyraEngine` is papyra's
own, and loads the addon on its first `open` rather than when imported, so naming it
as a default costs a bundle nothing until a PDF opens.

`Document` and `open()` are unchanged to call, and now go through `PapyraEngine`.
`Document` also gains `close()`, `engine` and `capabilities`, which makes it a
`PdfDoc` that any engine-driven viewer accepts. `paintToCanvas` takes an
`ImageBitmap` as well as a `RenderedPage`, for engines that rasterise elsewhere.
