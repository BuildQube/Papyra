---
'@workspace/pdf-viewer': patch
---

Every item now needs `@build-qube/papyra@^0.5.0`, and the items that only draw
import from `@build-qube/papyra/core`, which loads no wasm. The ones that open a
file (`file-preview-pdf`, `file-preview-tiff`, `file-preview-sheet` and
`pdf-viewer-store`) still import `@build-qube/papyra`.

A vendored copy can take this by hand: in `pdf-viewer`, `pdf-viewer-basic`,
`pdf-viewer-configurable`, `pdf-page-canvas`, `pdf-page-view`, `pdf-page-surface`,
`pdf-continuous-pages`, `pdf-highlights`, `pdf-links`, `pdf-structure` and
`pdf-attachments`, replace `'@build-qube/papyra'` with `'@build-qube/papyra/core'`.
Nothing else in those files changed.
