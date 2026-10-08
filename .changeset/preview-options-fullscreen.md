---
'@workspace/pdf-viewer': minor
---

The file preview can go full screen, and its formats take options.

- `file-preview` has a full-screen button beside Download (`fullscreen={false}` to
  hide it). A PDF inside the preview no longer shows its own.
- Renderers take options for their view, as defaults with
  `pdfRenderer.with({ thumbnails: true })` or per preview with
  `options={{ pdf: { search: true } }}`. Both are typed from the renderers the preview
  was created with.
- `createFilePreview` takes optional defaults for every preview it makes: `allow`,
  `options`, `cache`, `fullscreen`, `displaySize` and `displayRenderTime`. Props
  on an instance override them; `options` merge per renderer, field by field.
- New `pdf-viewer-configurable` block: one viewer whose thumbnails, outline, tags,
  attachments, search, document-properties dialog and single-page/continuous view
  are each a prop. In the file preview, the properties dialog gets the file's name
  and size from the file, and shows the size regardless of `displaySize`.
  `file-preview-pdf` now shows it, as a continuous scrolling column by default
  (`view: 'page'` for one page at a time), so its options are that block's props.
- Render timings and the file size are hidden by default. Set `displayRenderTime`
  (on `FilePreview`, `PdfViewer`, `PdfViewerConfigurable`, `ViewerLayout`, `Sidebar`
  and the panels) or `displaySize` (on `FilePreview`) to show them.
- `Properties`' `name` and `byteLength` are optional, shown as a dash when absent.
- The zoom bar's "⌘/ctrl + scroll, pinch…" hint moved from the toolbar into a
  tooltip on the zoom select. The zoom bar now depends on shadcn's `tooltip`.
- New `use-fullscreen` hook, shared by the viewer layout and the preview.
