# papyra

Fast PDF rendering for Node **and** the browser, from one Rust core. The engine
([hayro](https://github.com/LaurenzV/hayro)) is compiled in — there are no pdfium
binaries to ship and nothing to install alongside it.

## Install

```bash
npm install @build-qube/papyra
```

The native addon and the browser wasm build ship as optional dependencies; your
package manager picks the right one.

## Render a page

```ts
import { open, paintToCanvas } from '@build-qube/papyra';

const doc = await open(file); // Uint8Array | ArrayBuffer | Blob | File
const page = await doc.renderPage(0, { fitWidth: 1600 });

paintToCanvas(page, canvas);
```

`renderPage` never blocks the event loop. `page` is tightly packed RGBA8, so
`paintToCanvas` is a convenience rather than the only route — `toImageData`, the
encoders, or your own buffer handling all work from the same bytes.

## Thumbnails

`stream` yields pages as they finish, with concurrency bounded for you:

```ts
for await (const { page, bitmap } of doc.stream({ fitWidth: 160 })) {
  paint(page, bitmap);
}
```

## Say what is urgent

papyra does not guess which page matters — a viewer knows what is on screen and the
library does not. Attach a priority and the queue honours it. **Lower runs first**,
and the default is the most urgent tier, so callers who do not care can ignore this
entirely.

```ts
const doc = await open(file, { concurrency: 4 }); // viewers want a narrow pool

// Thumbnails yield to whatever is on screen.
for await (const t of doc.stream({ fitWidth: 160, priority: 2 })) { /* … */ }

// Reprioritise on scroll instead of cancelling and resubmitting.
const job = doc.render(12, { fitWidth: 1600, priority: 2 });
onScroll(() => job.setPriority(isVisible(12) ? 0 : 3));
```

Requests for the same page at the same size coalesce into one render. Pending work
reorders freely; work already running is never interrupted.

## Export, text, and outlines

```ts
const image = await doc.renderImage(0, { fitWidth: 2000 });
await writeFile('page-0.webp', (await image.toWebp()).bytes);

for await (const hit of doc.search('site plan')) {
  highlight(hit.page, hit.rects);
}

for (const node of await doc.outline()) {
  if (node.page !== null) goTo(node.page);
}
```

`renderImage` keeps the pixels in Rust and encodes on demand, so nothing but the
finished file crosses into JS. For output that has to survive being scaled there is
`doc.renderSvg(0)`, which returns vector markup instead of pixels and so takes no
size and no quality.

## Two things that will bite you

**Size with `fitWidth`, not `dpi`.** Page areas vary by two orders of magnitude. At a
fixed 36 DPI, US Letter is a 216x279 thumbnail while a 42x30in drawing is a 1512x1080,
6.5 MB image. Sizing by output width keeps cost proportional to what you actually
display; renders above 100 MP are refused outright.

**The browser build needs cross-origin isolation.** It uses shared wasm memory, so
`SharedArrayBuffer` must be available. Serve your page with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## More

The [full API reference](https://buildqube.github.io/Papyra/docs) is generated from
these sources, so it never drifts from them. The
[project README](https://github.com/BuildQube/Papyra) covers architecture, benchmarks
against pdf.js, and the measurements behind these defaults.

MIT.
