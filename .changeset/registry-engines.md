---
'@workspace/pdf-viewer': minor
---

The viewer runs on an engine, chosen by the app, so it can render where papyra's
wasm cannot — a mobile WebView that is never cross-origin isolated, say.

- New **`pdf-engine`** item: `PdfEngineProvider` (an engine, or a list to take the
  first available from), `usePdfEngine()`, and `PdfEngineGuard`, which explains in
  the engine's own words why it cannot run. With no provider, every viewer uses
  papyra's own engine, exactly as before.
- Commands go through the engine: `doc.render(…)` became
  `engine.render(doc, …)`, and so on for `stream`, `search`, `pageText`,
  `outline`, `links`, `pageLabels`, `attachments`, `attachmentData` and
  `structTree`. Changed files: `pdf-viewer`, `pdf-viewer-basic`,
  `pdf-viewer-configurable`, `pdf-page-preview`, `pdf-page-surface`,
  `pdf-thumbnails`, `pdf-find-bar`, `pdf-structure`, `pdf-links`, `pdf-outline`,
  `pdf-attachments`, `pdf-sidebar` and `use-pdf-page-labels`.
- Props take a `PdfDoc` rather than a `Document`. A `Document` is one, so existing
  callers compile unchanged. `pdf-page-canvas` and `pdf-page-view` paint any
  `PageBitmap`.
- The PDF blocks and `file-preview-pdf` guard with `PdfEngineGuard`.
  `PdfIsolationGuard` is unchanged, and still guards TIFF and spreadsheets.
- `pdf-viewer-store` opens through its `engine` option, which `PdfViewerProvider`
  fills from context. It closes the documents its `load` opened when they are
  replaced, never one handed to `setDocument`. `file-preview-pdf` closes what it
  opened when the file changes and on unmount.
- Panels hide when the engine cannot fill them: outline, tags and attachments by
  capability, search and the find bar without text, and the annotation switch
  when the engine cannot turn annotations off. The properties dialog gains an
  "Engine" row.
