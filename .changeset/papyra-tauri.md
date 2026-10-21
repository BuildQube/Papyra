---
'@build-qube/papyra-tauri': minor
---

New package: `TauriEngine`, papyra's viewer inside a Tauri 2 app. Documents are
parsed and rendered by the `tauri-plugin-papyra` crate in the app's host process, so
an Android or iOS WebView — never cross-origin isolated — shows PDFs with papyra's
own engine, on the device's cores and without wasm. Pages arrive over a `papyra://`
protocol as PNG, or raw RGBA with `format: 'rgba'`; everything else papyra reads,
including the structure tree, comes through the plugin's commands. The host frees a
WebView's documents when it reloads, and `open_count` (opt-in, outside
`papyra:default`) reports what is still open. `@build-qube/papyra` is a peer
dependency.
