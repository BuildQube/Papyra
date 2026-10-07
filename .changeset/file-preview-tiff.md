---
'@workspace/pdf-viewer': minor
---

File preview: TIFF, as a renderer item.

**`file-preview-tiff`** (`tiffRenderer`, id `tiff`) shows `.tif` and `.tiff` —
scanned drawings and faxes — recognised by their header (`II*\0`, `MM\0*`, and
BigTIFF's `II+\0`, `MM\0+`), never by name. papyra decodes each page off the main
thread, CCITT Group 4 included, reduced to at most 4096 × 4096 while it decodes.
A multi-page file gets the pager, and every page the image view's zoom, fit modes
and rotation. 100% is the sheet's physical size when the file states a resolution,
which also squares a fax's 204 × 196 dpi pixels. A page that will not decode says
so in place, and the pager still reaches the others.

Needs `@build-qube/papyra@^0.4.0` and a cross-origin isolated page, like the PDF
and spreadsheet renderers.
