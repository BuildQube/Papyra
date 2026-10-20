# @build-qube/papyra-tauri

A Tauri engine for papyra's PDF viewer: documents are parsed and rendered by papyra in
the app's host process, through the `tauri-plugin-papyra` crate.

A Tauri app's WebView is never cross-origin isolated on Android or iOS, so papyra's
wasm build cannot run there. This engine does not need it: the Rust side renders on
the device's real cores, and the WebView only paints.

## Install

```bash
npm install @build-qube/papyra-tauri @build-qube/papyra @tauri-apps/api
```

`@build-qube/papyra` (0.5.0 or later) and `@tauri-apps/api` are peer dependencies:
the app owns them. Two copies of papyra would break `instanceof` across them — a
password error from one is not a `PasswordError` of the other, and the viewer's
password prompt never appears.

In the app's Rust crate:

```rust
tauri::Builder::default().plugin(tauri_plugin_papyra::init())
```

- **Capability.** Allow `papyra:default` in a capability file
  (`src-tauri/capabilities/default.json`). Add `papyra:allow-open-count` too if you
  want `open_count`, a leak check that is deliberately not in the default set.
- **Rust version.** The crate is edition 2024 and needs Rust 1.92 or later, whatever
  the app's own `rust-version` says.
- **Debug builds.** Cargo takes profile settings only from the app's own manifest,
  never from a dependency, so add this to `src-tauri/Cargo.toml`:

  ```toml
  [profile.dev.package."*"]
  opt-level = 2
  ```

  Without it, a debug build renders unoptimised — measured at 1.3–1.7 s a page on an
  iOS simulator. Benchmark with `--release` either way.
- **Content Security Policy.** If the app sets a CSP, `connect-src` must allow
  `papyra:` and `http://papyra.localhost`, which is the protocol's name on Android and
  Windows. Without them every page fetch is blocked, with no clearer error than a
  failed fetch.

## Use

```tsx
import { TauriEngine } from '@build-qube/papyra-tauri';
import { PdfEngineProvider } from '@/components/pdf-engine';

<PdfEngineProvider engine={new TauriEngine()}>{app}</PdfEngineProvider>;
```

Every viewer below the provider opens and renders through the host. Everything
papyra's own engine reads, this one does — same parser, same text, outline, links,
labels, attachments and structure tree — because it is the same engine.

### Keeping papyra's wasm out of the bundle

The viewer's no-provider default is papyra's own engine, and a bundler emits its
6 MB wasm as soon as anything names it, fetched or not. That default lives in one
registry file, `pdf-default-engine.ts`; alias it to your own and the wasm goes:

```ts
// vite.config.ts
resolve: {
  alias: [{ find: /.*\/pdf-default-engine$/, replacement: '/src/pdf-default-engine.ts' }],
}
```

```ts
// src/pdf-default-engine.ts
import { TauriEngine } from '@build-qube/papyra-tauri';
export const fallbackPdfEngine = new TauriEngine();
```

## Pages and lifetimes

Pages travel over a `papyra://` protocol, as PNG by default. `new TauriEngine({
format: 'rgba' })` sends raw pixels instead: no encode or decode, four times the
bytes. Which is faster depends on the device.

Documents stay in the host until closed. The viewer's store and file preview close
what they open; if you call the engine yourself, `await engine.close(doc)` — it
rejects if the host could not release the document. When a WebView loads a page —
a reload, HMR, the app restarting its UI — the host drops every document that
WebView had open, since nothing on the new page could close them.
