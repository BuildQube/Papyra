# tauri-plugin-papyra

papyra's PDF engine inside a Tauri 2 app, for the viewer's `TauriEngine`
(`@build-qube/papyra-tauri`). Documents are parsed and rendered on the host's cores,
so the WebView needs no cross-origin isolation and no wasm.

The Cargo, builder and capability setup, the debug-profile and CSP settings an app
needs, and the TypeScript side are in the [Tauri guide](https://buildqube.github.io/Papyra/docs/guides/tauri).

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
