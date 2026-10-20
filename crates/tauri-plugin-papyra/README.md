# tauri-plugin-papyra

papyra's PDF engine inside a Tauri 2 app, for the viewer's `TauriEngine`
(`@build-qube/papyra-tauri`). Documents are parsed and rendered on the host's cores,
so the WebView needs no cross-origin isolation and no wasm.

```rust
tauri::Builder::default().plugin(tauri_plugin_papyra::init())
```

and `"papyra:default"` in the app's capabilities.

- **Commands** — `open` (the file's bytes as the raw request body, a password in the
  `x-papyra-password` header), `close`, `page_text`, `outline`, `links`,
  `page_labels`, `attachments`, `attachment_data`, `struct_tree` — answer in the
  shapes papyra's napi bindings use, so the TypeScript side normalises them with
  papyra's own code.
- **Pages** come from `papyra://localhost/<id>/<page>?dpi=144&annots=1&format=png`
  (`http://papyra.localhost/…` on Android and Windows), as PNG or, with
  `format=rgba`, raw pixels with `X-Width` and `X-Height` headers.

This crate is its own Cargo workspace rather than a member of papyra's: compiling
Tauri on Linux needs webkit2gtk's development headers. CI checks it on macOS.
