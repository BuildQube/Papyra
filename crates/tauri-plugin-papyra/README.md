# tauri-plugin-papyra

papyra's PDF engine inside a Tauri 2 app, for the viewer's `TauriEngine`
(`@build-qube/papyra-tauri`). Documents are parsed and rendered on the host's cores,
so the WebView needs no cross-origin isolation and no wasm.

```rust
tauri::Builder::default().plugin(tauri_plugin_papyra::init())
```

and `"papyra:default"` in the app's capabilities.

## Before you depend on it

- **Rust 1.92 or later.** The crate is edition 2024, which raises the floor for the
  app that uses it, whatever the app's own `rust-version` says.
- **Optimise dependencies in debug builds.** Cargo reads profiles only from the
  top-level manifest, so the app needs this itself:

  ```toml
  [profile.dev.package."*"]
  opt-level = 2
  ```

  Without it hayro runs unoptimised in a debug build: 1.3–1.7 s a page, measured on
  an iOS simulator.
- **Content Security Policy.** Pages are fetched from `papyra://localhost/…`, which
  is `http://papyra.localhost/…` on Android and Windows. A CSP needs both in
  `connect-src`, or every page fetch is blocked.

## What it serves

- **Commands** — `open` (the file's bytes as the raw request body, a password in the
  `x-papyra-password` header), `close`, `page_text`, `outline`, `links`,
  `page_labels`, `attachments`, `attachment_data`, `struct_tree` — answer in the
  shapes papyra's napi bindings use, so the TypeScript side normalises them with
  papyra's own code. All are in `papyra:default`.
- **`open_count`** — how many documents the host holds, for a leak check. Not in
  `papyra:default`; allow `papyra:allow-open-count` to use it.
- **Pages** come from `papyra://localhost/<id>/<page>?dpi=144&annots=1&format=png`
  (`http://papyra.localhost/…` on Android and Windows), as PNG or, with
  `format=rgba`, raw pixels with `X-Width` and `X-Height` headers.

A document lives until `close`, or until the WebView that opened it loads a page: a
reload leaves the old page's ids unreachable, so the plugin drops them then.

This crate is its own Cargo workspace rather than a member of papyra's: compiling
Tauri on Linux needs webkit2gtk's development headers. CI checks it on macOS.
