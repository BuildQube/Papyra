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
tauri-plugin-papyra = "0.6"

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

`@build-qube/papyra` (0.6.0 or later) and `@tauri-apps/api` are peer dependencies:
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
the readers it serves, and each has a permission set to grant beside
`papyra:default`.

| Format | Feature | Default | Permission | WebView side |
| --- | --- | --- | --- | --- |
| PDF | none: always built | yes | `papyra:default` | `TauriEngine` |
| TIFF | `tiff` | no | `papyra:tiff` | `openTiff` |
| Spreadsheets: xlsx, xlsm, xlsb, xls, ods, csv, tsv | `tables` | no | `papyra:tables` | `openWorkbook` |
| Word and PowerPoint: docx, pptx | none: a separate crate, from git | no | `papyra-office:default` | `TauriOfficeEngine` |

```toml
tauri-plugin-papyra = { version = "0.6", features = ["tiff", "tables"] }
```

```json
"permissions": ["core:default", "papyra:default", "papyra:tiff", "papyra:tables"]
```

Every format shares one document table and the `papyra://` protocol, so `close`
and the page fetch are the ones in `papyra:default`. A permission for a format whose
feature is off grants nothing: its command is not registered.

Each opener goes to its renderer in the file preview, in place of papyra's own; an
opener of its own skips the cross-origin isolation check papyra's wasm needs:

```tsx
import {
  openTiff,
  openWorkbook,
  TauriOfficeEngine,
} from '@build-qube/papyra-tauri';

const office = new TauriOfficeEngine();
const FilePreview = createFilePreview([
  pdfRenderer,
  tiffRenderer.with({ open: openTiff }),
  spreadsheetRenderer.with({ open: openWorkbook }),
  csvRenderer.with({ open: openWorkbook }),
  pptxRenderer.with({ engine: office }),
  docxPagedRenderer.with({ engine: office }),
]);
```

- **TIFF pages** travel like a PDF's, PNG by default — for a bilevel fax page a small
  fraction of its RGBA. `openTiff(file, { format: 'rgba' })` sends raw pixels.
- **Spreadsheets cost memory twice.** The grid reads cells synchronously, a window per
  frame, and IPC is not synchronous, so a sheet's cells come over **whole** when it is
  first shown and windows are cut from that copy in the WebView. That is about 19
  bytes a cell plus its text, held in the host and in the WebView. The copy counts
  the sheet's whole rectangle, empty cells included, so the host bounds it twice and
  marks a sheet cut by either `truncated`, showing its first whole rows:
  - at most a million cells — about 19 MB on each side, plus text up to 64 MB —
    however high `maxCells` is set;
  - at most sixteen times the cells the sheet actually holds, and no less than
    65,536. A ten-kilobyte file with one value in A1 and one in XFD1048576 is
    seventeen billion cells as a rectangle; this ships it as a megabyte.

  A lower `maxCells` lowers both the cells parsed and the first cap:

  ```tsx
  const open = (file: File) => openWorkbook(file, { maxCells: 250_000 });
  spreadsheetRenderer.with({ open });
  ```

- **Panics.** A page whose engine panics — a malformed file can do that to any of
  them — is answered with a 500 carrying the message, so the viewer shows an error
  rather than spinning. That needs unwinding: an app built with `panic = "abort"` in
  its release profile loses the whole process instead.

### Word and PowerPoint: depend on the repository

Word and PowerPoint are laid out by WordCraft and DeckCraft, which are not on
crates.io, and crates.io refuses a crate that depends on git — even behind an
optional feature. So they are not a feature of the published plugin but a second
plugin, `tauri-plugin-papyra-office`, that lives only in this repository. It opens
into the PDF plugin's document table, so it needs that plugin from the **same**
place: taking one from crates.io and the other from git gives Cargo two copies of
the plugin, which it refuses to link. Depend on both from git, at the release tag:

```toml
[dependencies]
tauri-plugin-papyra = { git = "https://github.com/BuildQube/papyra", tag = "@build-qube/papyra@0.6.0", features = ["tiff", "tables"] }
tauri-plugin-papyra-office = { git = "https://github.com/BuildQube/papyra", tag = "@build-qube/papyra@0.6.0" }
```

Register it after the PDF plugin, and allow `papyra-office:default`:

```rust
tauri::Builder::default()
  .plugin(tauri_plugin_papyra::init())
  .plugin(tauri_plugin_papyra_office::init())
```

Office pages are drawn by the host, where both engines also scan the system's fonts,
so a document can paginate differently from the browser build. `office.addFont(bytes)`
registers a metric-compatible font (Carlito for Calibri, say) in the host, and the
renderers' `fonts` option calls it for you.

## Rust crates

Six crates are published to crates.io, versioned with the npm packages: a papyra
release publishes all of them at its version. Only the plugin is meant to be used
directly; the other five are published because it depends on them.

- [tauri-plugin-papyra](https://docs.rs/tauri-plugin-papyra) — papyra inside a Tauri
  2 app, for `TauriEngine`, `openTiff` and `openWorkbook`.
- [papyra-core](https://docs.rs/papyra-core) — the engine-agnostic `Engine` and
  `Document` traits, `Bitmap` and the render options.
- [papyra-hayro](https://docs.rs/papyra-hayro) — the PDF engine itself, on hayro:
  render, text, outline, links, labels, attachments and structure tree.
- [papyra-encode](https://docs.rs/papyra-encode) — pure-Rust WebP, PNG and JPEG
  encoders for a `Bitmap`.
- [papyra-tables](https://docs.rs/papyra-tables) — Excel, OpenDocument, CSV and TSV
  readers, behind the plugin's `tables` feature.
- [papyra-tiff](https://docs.rs/papyra-tiff) — the TIFF reader, fax pages included,
  behind the plugin's `tiff` feature.

`tauri-plugin-papyra-office` is not among them; see above.
