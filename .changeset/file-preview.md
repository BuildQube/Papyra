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
`file-preview-image` (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG, no
dependencies) and `file-preview-code` (shiki, on its JavaScript regex engine).
Each is a small descriptor plus a view loaded by `import()`, so an installed
format's dependency is still not fetched until a file of that type is shown.

**Detection.** `file-preview-core` recognises a file by its bytes first. A PNG
named `notes.txt` is an image, and an HTML page named `photo.png` is not one, so
an `allow` list cannot be passed by renaming a file. Formats with no signature,
such as source code, match by extension or MIME type, and are refused when the
file's head contains a NUL byte. `acceptOf()` builds a file input's `accept` from
the same list.
