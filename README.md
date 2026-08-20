# papyra

Fast PDF rendering for Node **and** the browser, from one Rust core.

- **One toolchain.** `napi build` produces both the native addon and the browser wasm
  bundle. No wasm-pack, no emscripten, no pdfium binaries to ship.
- **Nothing to install.** The rendering engine ([hayro](https://github.com/LaurenzV/hayro),
  pure Rust) is compiled in.
- **Concurrent by default.** Rendering is parallelised in Rust and never blocks the
  event loop.

```ts
import { open, paintToCanvas } from '@build-qube/papyra';

const doc = await open(file);                    // Uint8Array | Blob | File
const page = await doc.renderPage(0, { dpi: 150 });
paintToCanvas(page, canvas);

// stream thumbnails, bounded concurrency, yields as they finish
for await (const { page, bitmap } of doc.stream({ dpi: 48 })) {
  paint(page, bitmap);
}
```

## Layout

```
crates/papyra-core     engine-agnostic traits and types
crates/papyra-hayro    hayro-backed engine
packages/bindings      napi-rs bindings  -> @build-qube/papyra-native
packages/papyra        TypeScript wrapper -> @build-qube/papyra
apps/demo              Vite + React viewer with an in-browser benchmark
apps/bench             Node benchmark vs pdf.js
docs/spike-results.md  measurements and the two wasm bugs behind the design
```

The `papyra-core` trait boundary exists so the engine can be swapped or supplemented
(a native-only pdfium backend is a plausible future addition) without a rewrite.

## Getting started

```bash
bun install
bun run corpus          # fetch test PDFs from the pdf.js suite (gitignored)
bun run build           # native addon + TypeScript
bun run --filter @build-qube/papyra-native build:wasm
bun run --filter papyra-bench smoke
bun run --filter papyra-bench bench
bun run --filter papyra-demo dev
```

## Two things that will bite you

**The browser build needs cross-origin isolation.** napi-rs generates shared wasm
memory, so `SharedArrayBuffer` must be available. Serve with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`apps/demo/vite.config.ts` sets these; the wrapper warns if `crossOriginIsolated` is
false.

**Concurrency works differently per runtime**, and the wrapper handles it for you:
native uses one async task with rayon inside, wasm uses per-page async tasks. See
`docs/spike-results.md` for why — including a memory-growth race and a rayon deadlock
that shaped the design.

## Licence

MIT. Bundles no third-party binaries; see `NOTICE` for linked Rust crates
(hayro is Apache-2.0).
