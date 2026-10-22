---
'@workspace/pdf-viewer': minor
---

Word and PowerPoint in the file preview (experimental), drawn by papyra's office
engine in the PDF viewer's continuous column, with its zoom bar.

- New **`file-preview-pptx`** item: `pptxRenderer`, for PowerPoint decks.
- New **`file-preview-docx-paged`** item: `docxPagedRenderer`, Word paginated as
  Word prints it. `docxRenderer` (docx-preview) is unchanged; both claim `.docx`, so
  list whichever should win first.
- New **`file-preview-office-view`** item: the view both share. Both renderers take
  `fonts`, URLs of fonts to register before the first document opens.
- `pdf-engine` gains `PageEngineScope` and `usePageEngine()`, which set and read the
  engine the page column renders through, falling back to the PDF engine; and
  `EngineGuard`, `PdfEngineGuard` for any engine.
- `pdf-page-surface` and `pdf-continuous-pages` take any `PagedDoc`, and draw links
  only when its capabilities include them. A `PdfDoc` is one, so existing callers
  compile unchanged.
