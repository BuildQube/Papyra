---
"@build-qube/papyra": minor
---

`TiffImage`, `Workbook` and `Sheet` are exported from `@build-qube/papyra/core`
and can be built over any host's source (`TiffSource`, `WorkbookSource`), which is
how `@build-qube/papyra-tauri` reads TIFFs and spreadsheets natively. Both gain
`close()` — a no-op for papyra's own, which the garbage collector frees.
`TiffImage` takes the page type it decodes to, defaulting to `RenderedPage`.
