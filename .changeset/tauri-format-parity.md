---
"@build-qube/papyra-tauri": minor
---

TIFF, spreadsheets, and Word and PowerPoint in a Tauri app's host process.
`openTiff` and `openWorkbook` mirror papyra's own and resolve to its `TiffImage`
and `Workbook`; `TauriOfficeEngine` stands in for `officeEngine`. They need
`tauri-plugin-papyra`'s `tiff` and `tables` features and their `papyra:tiff` and
`papyra:tables` permissions, and for office the git-only
`tauri-plugin-papyra-office`. Requires `@build-qube/papyra` 0.6.
