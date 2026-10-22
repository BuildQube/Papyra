# @build-qube/papyra-tauri

## 0.6.0

### Minor Changes

- 4129b03: TIFF, spreadsheets, and Word and PowerPoint in a Tauri app's host process.
  `openTiff` and `openWorkbook` mirror papyra's own and resolve to its `TiffImage`
  and `Workbook`; `TauriOfficeEngine` stands in for `officeEngine`. They need
  `tauri-plugin-papyra`'s `tiff` and `tables` features and their `papyra:tiff` and
  `papyra:tables` permissions, and for office the git-only
  `tauri-plugin-papyra-office`. Requires `@build-qube/papyra` 0.6.

## 0.5.0

### Minor Changes

- 24ac39a: New package: `TauriEngine`, papyra's viewer inside a Tauri 2 app. Documents are
  parsed and rendered by the `tauri-plugin-papyra` crate in the app's host process, so
  an Android or iOS WebView — never cross-origin isolated — shows PDFs with papyra's
  own engine, on the device's cores and without wasm. Pages arrive over a `papyra://`
  protocol as PNG, or raw RGBA with `format: 'rgba'`; everything else papyra reads,
  including the structure tree, comes through the plugin's commands. The host frees a
  WebView's documents when it reloads, and `open_count` (opt-in, outside
  `papyra:default`) reports what is still open. `@build-qube/papyra` is a peer
  dependency.

### Patch Changes

- 64531eb: The engines and Tauri setup docs move to guide pages on the doc site,
  https://buildqube.github.io/Papyra/docs/guides/engines and
  https://buildqube.github.io/Papyra/docs/guides/tauri. The READMEs link there instead
  of repeating them; the `tauri-plugin-papyra` crate's README does the same.
