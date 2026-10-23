---
title: Engines
---

# Engines

`open()` renders through papyra's own engine. Three more cover what it cannot reach,
and the [viewer components](https://github.com/BuildQube/Papyra/blob/main/packages/pdf-viewer/README.md)
take whichever the app names. Each is a class with the same commands — `open`,
`render`, `stream`, `search`, `outline`, `links`, `close` and the rest — and the same
priority queue, render cache and `fitWidth` sizing.

| Engine | Import | Renders | Needs | Costs |
| --- | --- | --- | --- | --- |
| `PapyraEngine` | `@build-qube/papyra/engine` | PDF, natively in Node, in wasm in a browser | a cross-origin-isolated page | about 2.5 MB of wasm gzipped |
| `PdfjsEngine` | `@build-qube/papyra-pdfjs` | PDF, on pdf.js | `pdfjs-dist` | pdf.js's own text positions; no structure tree |
| `TauriEngine` | `@build-qube/papyra-tauri` | PDF, natively in a Tauri app's host process | `tauri-plugin-papyra` in the app | no wasm at all |
| `PapyraOfficeEngine` | `@build-qube/papyra/office` | Word and PowerPoint pages, experimentally | `@build-qube/papyra-office-native`, and isolation in a browser | a second wasm module, about 5.9 MB gzipped at the current engine pin |

## Picking one

- **You can set response headers.** Use papyra's, and serve the isolation headers
  (see [Three things that will bite you](https://github.com/BuildQube/Papyra#three-things-that-will-bite-you)).
  It has every feature here, reads text more exactly than pdf.js, and wins on batch
  work — thumbnails, prerendering, export. pdf.js is faster to a single page in a
  browser; see [Performance, honestly](https://github.com/BuildQube/Papyra#performance-honestly).
- **The page cannot be isolated** — a mobile WebView, an app embedding third-party
  content, a host whose headers you do not control. Use pdf.js. Name both engines
  and the viewer takes papyra's where the page allows it and pdf.js elsewhere.
- **A Tauri app.** Use `TauriEngine`: no wasm and no isolation, and the output and
  features are papyra's, because it is papyra in the app's Rust process. The
  [Tauri guide](https://buildqube.github.io/Papyra/docs/guides/tauri) wires it up.
- **Word and PowerPoint.** Add the office engine beside your PDF engine. It draws
  pages only — no text, links or outline. Register metric-compatible fonts (Carlito
  for Calibri, and so on) with `officeEngine.addFont`, or pagination drifts from
  Word's.

## Installing

papyra's engine and the office engine ship in `@build-qube/papyra`; the office addon
is an optional peer, so a PDF-only app never downloads it. The pdf.js and Tauri
engines are packages of their own: the
[pdf.js engine's README](https://github.com/BuildQube/Papyra/blob/main/packages/pdfjs/README.md)
and the [Tauri guide](https://buildqube.github.io/Papyra/docs/guides/tauri) have the
commands.

```bash
npm install @build-qube/papyra @build-qube/papyra-office-native
```

## Which entry to import

- `@build-qube/papyra` — everything but the office engine, plus `open()`. Loads
  papyra's addon when imported.
- `@build-qube/papyra/core` — everything that runs without an engine: painting,
  viewports, search, the error types, `PagedEngine` and `PdfEngine`. Nothing in it
  reaches papyra's wasm, so import from here whenever another engine opens the
  documents; a bundler emits the wasm as soon as its graph reaches it, fetched or not.
- `@build-qube/papyra/engine` (`PapyraEngine`, and `defaultPdfEngine`, the instance
  `open()` uses) and `@build-qube/papyra/office` (`PapyraOfficeEngine`,
  `officeEngine`) — each fetches its addon on the first open, not on import.

```ts
import { paintToCanvas } from '@build-qube/papyra/core';
import { PdfjsEngine } from '@build-qube/papyra-pdfjs';

const engine = new PdfjsEngine({ workerSrc });
const doc = await engine.open(file);
paintToCanvas(await engine.render(doc, 0, { fitWidth: 1200 }).promise, canvas);
await engine.close(doc);
```

A document belongs to the engine that opened it: hand it back to that engine and no
other. `doc.capabilities` says which commands the engine can answer for it — a viewer
hides the panels it cannot fill.

## Pages too large for one bitmap

A render past 100 MP is refused: an ARCH-E sheet at 400% is 105 MP, 420 MB of RGBA.
`renderTile` renders one window of the page instead — the pixels the whole render
would have there, at any DPI — and the cap applies to the window:

```ts
const tile = { x: 4096, y: 2048, width: 1024, height: 1024 };
const { promise } = engine.renderTile(doc, 0, tile, { dpi: 576 });
```

Tiles are cached and coalesced like pages, on a queue of their own so a screenful of
them never holds up a page. An engine that can do this says so in
`doc.capabilities.tiles`; papyra's and the Tauri engine can, pdf.js and the office
engine cannot, and `renderTile` throws on those. Each tile still costs about what
interpreting the whole page does, because the renderer culls nothing outside it, so
tiles pay only past the cap, not before it. papyra's engine runs them one at a time
in wasm, where four at once finish later than one does.

The viewer's page column switches to tiles on its own once a page outgrows its
24 MP bitmap: the bitmap stays underneath, stretched, until the tiles over it land.

## In the viewer

The `pdf-engine` registry item puts an engine in scope:

```tsx
import { defaultPdfEngine } from '@build-qube/papyra/engine';
import { PdfjsEngine } from '@build-qube/papyra-pdfjs';
import { PdfEngineProvider } from '@/components/pdf-engine';

const pdfjs = new PdfjsEngine({ workerSrc });

<PdfEngineProvider engine={[defaultPdfEngine, pdfjs]}>{app}</PdfEngineProvider>;
```

- `PdfEngineProvider` takes an engine, or a list to take the first available from.
  It chooses once, on mount. Without one, every viewer uses `defaultPdfEngine`, so a
  `Document` from `open()` works with no provider at all.
- `PdfEngineGuard` renders its children only when the engine in scope can run on this
  page, and otherwise says why — for papyra's, the missing headers. Every PDF block
  and `file-preview-pdf` already wrap themselves in it; wrap your own composition of
  the pieces the same way. `EngineGuard` is the same for an engine you pass in.
- `PageEngineScope` renders the page column below it through another engine, and
  `usePageEngine()` reads it; everything else keeps using `usePdfEngine()`. That is
  how a Word document shows in the PDF viewer's column.

```tsx
import { officeEngine } from '@build-qube/papyra/office';
import { EngineGuard, PageEngineScope } from '@/components/pdf-engine';

<EngineGuard engine={officeEngine}>
  <PageEngineScope engine={officeEngine}>{pages}</PageEngineScope>
</EngineGuard>;
```

The `file-preview-docx-paged` and `file-preview-pptx` items are this, inside the
file preview, with a `fonts` option for `addFont`.

An app that never runs papyra's PDF engine also aliases the viewer's default away, so
none of its wasm is bundled: see
[Keeping papyra's wasm out of the bundle](https://buildqube.github.io/Papyra/docs/guides/tauri#keeping-papyras-wasm-out-of-the-bundle),
which is the same for pdf.js.
