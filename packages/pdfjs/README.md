# @build-qube/papyra-pdfjs

A [pdf.js](https://mozilla.github.io/pdf.js/) engine for papyra's PDF viewer.

papyra's own engine renders in WebAssembly with shared memory, so its page has to be
cross-origin isolated. Some pages never are — an Android or iOS WebView, an app that
embeds third-party content, a host that cannot set headers. This engine runs the
same viewer on pdf.js there.

## Install

```bash
npm install @build-qube/papyra-pdfjs @build-qube/papyra pdfjs-dist
```

`@build-qube/papyra` (0.5.0 or later) and `pdfjs-dist` are peer dependencies, so the
app holds one copy of each; pdf.js is not loaded until the first document opens.

## Use

Name it in the viewer's engine provider. With a list, the first engine that can run
on the page wins — papyra's where the page is isolated, pdf.js everywhere else:

```tsx
import { defaultPdfEngine } from '@build-qube/papyra/engine';
import { PdfjsEngine } from '@build-qube/papyra-pdfjs';
import { PdfEngineProvider } from '@/components/pdf-engine';

const pdfjs = new PdfjsEngine({
  workerSrc: new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString(),
});

<PdfEngineProvider engine={[defaultPdfEngine, pdfjs]}>{app}</PdfEngineProvider>;
```

Or call it directly, like any papyra engine:

```ts
const doc = await pdfjs.open(file);
const page = await pdfjs.render(doc, 0, { fitWidth: 800 }).promise; // ImageBitmap
for await (const match of pdfjs.search(doc, 'invoice')) console.log(match.page);
```

`document` passes options to every `getDocument` — `standardFontDataUrl`, `cMapUrl`
and `wasmUrl` tell pdf.js where to find the fonts, character maps and decoders it
does not bundle. `pdfjs` swaps the module, for the legacy build.

## How it differs from papyra's engine

- Pages are `ImageBitmap`s rendered into an `OffscreenCanvas`; `paintToCanvas` takes
  them as they are.
- Text positions are exact at the edges of each pdf.js text item and evenly spread
  inside it, since pdf.js reports one width per item. Search and highlights work;
  a highlight in the middle of a word can be a little off.
- No structure tree (tagged-PDF reading order), so the viewer hides that panel.
  `undecodedGlyphs` is always 0: pdf.js does not report text it could not decode.
- A render nobody is waiting for any more is cancelled part-way through.
- `fingerprint` is papyra's content hash, so a document has the same key on both
  engines.
