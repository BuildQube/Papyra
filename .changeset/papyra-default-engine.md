---
'@build-qube/papyra': minor
---

`defaultPdfEngine`, in `@build-qube/papyra/engine`: the one `PapyraEngine` that
`open()` goes through, and the one a viewer uses when the app names none. A document
belongs to the engine that opened it, so sharing this instance is what lets a
`Document` from `open()` be passed to an engine-driven viewer as it is.

`PapyraEngine.open` now resolves to a `Document`, so code holding a `PdfDoc` from
papyra's engine can reach `renderImage`, `renderSvg` or `cache` with an
`instanceof Document` check. Closing a document through the engine closes the
`Document` too, whichever name is used, and a stream over a document that closes
ends instead of throwing.
