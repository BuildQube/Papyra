# @build-qube/papyra-tauri

A Tauri engine for papyra's PDF viewer: documents are parsed and rendered by papyra in
the app's host process, through the `tauri-plugin-papyra` crate.

A Tauri app's WebView is never cross-origin isolated on Android or iOS, so papyra's
wasm build cannot run there. This engine does not need it: the Rust side renders on
the device's real cores, and the WebView only paints.

## Install

In the app's Rust crate, register the plugin:

```rust
tauri::Builder::default().plugin(tauri_plugin_papyra::init())
```

allow it in a capability file (`src-tauri/capabilities/default.json`):

```json
{ "permissions": ["papyra:default"] }
```

and in the web app:

```bash
npm install @build-qube/papyra-tauri @tauri-apps/api
```

## Use

```tsx
import { TauriEngine } from '@build-qube/papyra-tauri';
import { PdfEngineProvider } from '@/components/pdf-engine';

<PdfEngineProvider engine={new TauriEngine()}>{app}</PdfEngineProvider>;
```

Every viewer below the provider opens and renders through the host. Everything
papyra's own engine reads, this one does — same parser, same text, outline, links,
labels, attachments and structure tree — because it is the same engine.

Pages travel over a `papyra://` protocol, as PNG by default. `new TauriEngine({
format: 'rgba' })` sends raw pixels instead: no encode or decode, four times the
bytes. Which is faster depends on the device.

Documents stay in the host until closed. The viewer's store and file preview close
what they open; if you call the engine yourself, call `engine.close(doc)` too.
