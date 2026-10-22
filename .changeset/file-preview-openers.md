---
"@workspace/pdf-viewer": minor
---

The TIFF, spreadsheet and CSV renderers take `open`, and the paged Word and
PowerPoint renderers `engine`, so a Tauri app can hand them
`@build-qube/papyra-tauri`'s: `tiffRenderer.with({ open: openTiff })`. An opener of
the app's own skips the cross-origin isolation check. The TIFF and sheet items now
need `@build-qube/papyra` 0.6.
