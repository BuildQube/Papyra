---
'@workspace/pdf-viewer': minor
---

File preview: a block for a list of mixed files, with each format a separate item, so a format you do not install costs no dependency.

**Block.** New `file-preview` item. `createFilePreview([pdfRenderer, imageRenderer,
codeRenderer])` returns a component whose `allow` prop accepts exactly the ids in
that list: `allow={['docx']}` is a type error unless a `docx` renderer was passed,
and two renderers sharing an id is one too. It shows one file at a time with a
pager (← / → while focus is inside), a download button, and a card for a file no
renderer recognises, a format `allow` leaves out, or a view that throws.

**Renderers.** `file-preview-pdf` (papyra, with the password prompt),
`file-preview-image` (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG, zoomed
with the page viewer's own controls) and `file-preview-code` (shiki, on its JavaScript regex engine).
Each is a small descriptor plus a view loaded by `import()`, so an installed
format's dependency is still not fetched until a file of that type is shown.

**Detection.** `file-preview-core` recognises a file by its bytes first. A PNG
named `notes.txt` is an image, and an HTML page named `photo.png` is not one, so
an `allow` list cannot be passed by renaming a file. Formats with no signature,
such as source code, match by extension or MIME type, and are refused when the
file's head contains a NUL byte. `acceptOf()` builds a file input's `accept` from
the same list.

**Zoom without the engine, renamed.** `pdf-zoom`, `use-pdf-zoom` and
`pdf-zoom-bar` are now `viewer-zoom`, `use-viewer-zoom` and `viewer-zoom-bar`,
since images use them too. Their exports are unchanged, but their install
URLs are not, so anything installed under the old names should be re-added.
They no longer depend on `@build-qube/papyra`. They imported only its
`PageSize` and `Rotation` types, which `viewer-zoom` now declares itself as
`Size` and `Rotation`, and papyra's values still fit.

**Images** get the page viewer's zoom (⌘/ctrl-scroll, pinch, the keyboard, the
fit modes). They open at 100% when they fit and at "Image fit"
when they do not. An SVG is sized from its own `width`/`height` or `viewBox`,
not the browser's 150px default.

`ZoomBar`'s `page`, `pageCount`, `label` and `onPage` are now optional. Leave
out `onPage` and the pager is not rendered. `subject` renames the fit modes,
so "Page fit" can read "Image fit".
