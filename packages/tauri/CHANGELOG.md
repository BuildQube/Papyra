# @build-qube/papyra-tauri

## 0.7.0

### Minor Changes

- d62544f: `PagedEngine.renderTile(doc, index, tile, options)` renders one window of a page —
  the pixels the whole render would have there — so a page past the 100 MP cap can be
  shown in pieces at any zoom. The cap applies to the tile. Tiles are cached (apart
  from pages, so they never evict them) and coalesced, on their own queue; `doc.capabilities.tiles` says whether an
  engine has them. papyra's engine and `TauriEngine` do, through the addon's
  `renderTileAsync` and `x`/`y`/`width`/`height` on the `papyra://` page URL; papyra
  runs tiles one at a time in wasm, which measured faster than four. Backends opt in
  with `PagedBackend.renderTile` and may set `tileConcurrency`.
  
  `@build-qube/papyra-tauri` now needs `@build-qube/papyra@^0.7.0`.

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
