# @build-qube/papyra-pdfjs

## 0.5.0

### Minor Changes

- 24ac39a: New package: `PdfjsEngine`, papyra's viewer on pdf.js, for pages that cannot be
  cross-origin isolated. Pass it to `PdfEngineProvider`, alone or after papyra's own
  engine as a fallback. It renders to `ImageBitmap`, reads text, search, outline,
  links, page labels and attachments through pdf.js, maps pdf.js's password errors to
  papyra's, and cancels a render nobody waits for any more. `pdfjs-dist` is a peer
  dependency, imported on the first `open`; so is `@build-qube/papyra`.
