---
title: Tauri
---

# Tauri

A Tauri app's WebView is never cross-origin isolated on Android or iOS, so papyra's
wasm build cannot run there. It does not need to: `tauri-plugin-papyra` runs papyra's
PDF engine in the app's host process, on the device's real cores, and the viewer's
`TauriEngine` (`@build-qube/papyra-tauri`) talks to it. The WebView only paints.

## The plugin

In `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-papyra = "0.5"

# Cargo takes profile settings only from the app's own manifest, never from a
# dependency. Without this, a debug build renders unoptimised.
[profile.dev.package."*"]
opt-level = 2
```

Register it on the builder:

```rust
tauri::Builder::default().plugin(tauri_plugin_papyra::init())
```

And allow it in a capability file, `src-tauri/capabilities/default.json`:

```json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": ["core:default", "papyra:default"]
}
```

- **Permissions.** `papyra:default` is everything the engine calls: opening, reading
  and closing documents. Pages travel over the `papyra://` protocol, which needs no
  permission. Add `papyra:allow-open-count` if you want `open_count`, a leak check
  that is deliberately not in the default set.
- **Rust version.** The crate is edition 2024 and needs Rust 1.92 or later, whatever
  the app's own `rust-version` says.
- **Debug builds.** Without the profile above, hayro runs unoptimised — measured at
  1.3–1.7 s a page on an iOS simulator. Benchmark with `--release` either way.
- **Content Security Policy.** If the app sets a CSP, `connect-src` must allow
  `papyra:` and `http://papyra.localhost`, which is the protocol's name on Android and
  Windows. Without them every page fetch is blocked, with no clearer error than a
  failed fetch.

## The engine

```bash
npm install @build-qube/papyra-tauri @build-qube/papyra @tauri-apps/api
```

`@build-qube/papyra` (0.5.0 or later) and `@tauri-apps/api` are peer dependencies:
the app owns them. Two copies of papyra would break `instanceof` across them — a
password error from one is not a `PasswordError` of the other, and the viewer's
password prompt never appears.

Linking an unreleased papyra (`file:` or `link:`) reports its checked-in version,
which can be below the peer range; bun then installs a second, published copy to
satisfy it. Force the linked one with an `overrides` entry for `@build-qube/papyra`.

Put the engine in the viewer's scope:

```tsx
import { TauriEngine } from '@build-qube/papyra-tauri';
import { PdfEngineProvider } from '@/components/pdf-engine';

<PdfEngineProvider engine={new TauriEngine()}>{app}</PdfEngineProvider>;
```

Every viewer below the provider opens and renders through the host. Everything
papyra's own engine reads, this one does — same parser, same text, outline, links,
labels, attachments and structure tree — because it is the same engine. How pages
travel and when documents are released is in the
[engine's README](https://github.com/BuildQube/Papyra/blob/main/packages/tauri/README.md).

## Keeping papyra's wasm out of the bundle

The viewer's no-provider default is papyra's own engine, and a bundler emits its
6 MB wasm as soon as anything names it, fetched or not. That default lives in one
registry file, `pdf-default-engine.ts`; alias it to your own and the wasm goes. The
same works for pdf.js, or any engine.

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

## Cargo features

PDF is always built. Other formats come as Cargo features, so an app compiles only
the readers it serves.

| Format | Feature | Default |
| --- | --- | --- |
| PDF | none: always built | yes |

## Rust crates

Four crates are published to crates.io, versioned with the npm packages: a papyra
release publishes all of them at its version. Only the plugin is meant to be used
directly; the other three are published because it depends on them.

- [tauri-plugin-papyra](https://docs.rs/tauri-plugin-papyra) — papyra's PDF engine
  inside a Tauri 2 app, for `TauriEngine`.
- [papyra-core](https://docs.rs/papyra-core) — the engine-agnostic `Engine` and
  `Document` traits, `Bitmap` and the render options.
- [papyra-hayro](https://docs.rs/papyra-hayro) — the engine itself, on hayro: render,
  text, outline, links, labels, attachments and structure tree.
- [papyra-encode](https://docs.rs/papyra-encode) — pure-Rust WebP, PNG and JPEG
  encoders for a `Bitmap`.
