# Pluggable engines for the viewer — design

Status: **proposal, not implemented.** Nothing here ships until it is approved.

## As built (PR 1–6) — where this supersedes the text below

Measured or decided while implementing; the sections below are kept as written.

- **`pageSize(index)` on the handle, not a `pageSizes` array.** A native `pageSize`
  call costs ~0.3 µs, so eager-versus-lazy makes no difference to papyra's engine,
  and the accessor keeps today's `Document.pageSize` and every viewer call site as
  they are. A remote engine answers it from an array it fetched while opening.
- **Backends receive `dpi`, not `scale`.** hayro floors a page's pixel size from the
  DPI it is given; converting `dpi → scale → dpi` can move that by one pixel, which
  would break `viewport()`'s "same size as the bitmap" guarantee. The engine resolves
  `fitWidth` once and hands the DPI over untouched, so papyra's native calls and
  cache keys are byte-identical to before.
- **`PapyraEngine`, not `PapyraWasmEngine`** — it is the native addon in Node too.
  It caches the loaded addon after the first `open`; two `import()`s per open cost a
  measured 6 µs.
- **The running-job `AbortSignal` is the caller's**, passed through as `renderImage`
  already did. Aborting a *running* job from `handle.cancel()` needs scheduler work
  that only pdf.js and Tauri benefit from; it lands with the pdf.js engine.
- **Performance gate.** An A/B of HEAD against the refactor on the 14-document corpus
  (native, 15 interleaved rounds, minimum): cold render, open and search within the
  noise of the machine; cached renders ~17% and `pageSize` ~30% faster, because
  `pageCount` is now a field rather than a napi getter. Wasm, threaded, in a clean
  headless Chrome (fresh profile, no debugger) on `tracemonkey.pdf`, best of three
  alternating runs: open 0.13 / 0.13 ms, 14 pages streamed cold 93.9 / 93.8 ms, one
  page cold 15.6 / 15.6 ms, cached renders 2.26 / 2.29 ms, cold search 48.8 /
  49.1 ms — identical within noise. `PapyraEngine` from `/core` loaded the wasm
  through `import()` in the browser and produced pixels byte-identical to `Document`.
- **PR 3 moved 11 files, not every file.** The four that open a file
  (`file-preview-pdf-view`, `file-preview-tiff-view`, `file-preview-sheet`,
  `pdf-viewer-store`) call `open`, `openTiff` or `openWorkbook` and stay on the main
  entry until PR 4 (PDF) and PRs 7–8 (TIFF, sheets) route them through engines.
  Type-only imports stay too: `Document` is not in `/core`, and an erased import
  loads nothing either way. Every item's range is `^0.5.0`, the release `/core` ships
  in, so installing an item stops at `notarget` until that release is published —
  the honest failure the registry README asks for.
- **One default engine instance, `defaultPdfEngine`.** A handle carries its engine's
  *id*, not the engine, and the ownership check is by instance — so a viewer whose
  fallback was its own `new PapyraEngine()` would reject every `Document` from
  `open()`. `/core` exports the instance `open()` uses, and the context defaults to it.
- **`PapyraEngine.open` resolves to a `Document`** (`document.js` is imported with the
  addon, lazily). With the default engine, the store and the file preview therefore
  still hold `Document`s at runtime, and papyra-only code — the demo's export and
  queue readout — narrows with `instanceof Document` instead of breaking. `close` sets
  a flag on the shared state, so closing either name closes both.
- **`PdfIsolationGuard` is not an alias of `PdfEngineGuard`.** TIFF and spreadsheets
  use it too, and they call papyra's wasm directly whatever PDF engine is chosen; an
  engine-aware guard would wave them through under a Tauri provider. The PDF paths
  switched to `PdfEngineGuard`; the isolation guard is unchanged. The engine guard's
  default message is today's words, without the `<code>` spans.
- **The item lives at `components/pdf-engine.tsx`**, beside `pdf-viewer-provider`,
  since it renders (the guard's alert) and is a provider.
- **Closing has a timing rule.** `engine.stream` looks the document up per page, so
  closing under a live thumbnail strip used to throw from its loop; a stream now ends
  when its document closes. The file preview closes in its effect cleanup, which React
  runs after the viewer below has unmounted; the store, which React does not tell
  when subscribers have moved on, closes a replaced document on the next task. The
  find bar's unsearchable-page count checks its abort signal per page.
- **`?engine=` in the demo is deferred to PR 5**: with one engine there is nothing
  to switch to.
- **Performance.** Components call `engine.render(doc)` directly rather than through
  `Document`'s forwarder. Native A/B against PR 3 (14 documents, 15 rounds, min): open
  −0.7%, cold render +1.1%, cached render −0.7%, `pageSize` 0.0%, search +0.8% — noise.
  In headless Chrome the viewer, export and components routes render with no console
  errors, through four rapid file swaps in the viewer and eight in the file preview.
- **Aborting a running render is opt-in, per backend (`abortable`).** §5 had the base
  abort every running job's signal. For papyra that is a regression, not a no-op:
  an aborted job must leave the coalescing map, so a page the reader scrolls back to
  would render twice instead of joining the render already under way. Only a backend
  that can actually stop part-way declares it — pdf.js, through `renderTask.cancel()`.
  An aborted job keeps its concurrency slot until it settles.
- **pdf.js fingerprints with papyra's content hash**, not `fingerprints[0]`: a key
  that changes with the engine would lose what a viewer remembered per document.
  `fingerprint` and `toBytes` are exported from `/core` for this.
- **pdf.js page sizes, measured.** Reading every page's size up front cost 48 ms to
  open a 100-page file and 68 ms for 1,000 pages (headless Chrome, synthetic
  one-line pages) — about 20 ms per thousand pages. Not worth a lazy path.
- **Parity, measured.** `packages/pdfjs/test/integration` opens the corpus and the
  demo fixtures in both engines and compares page count and sizes, fingerprint,
  title, labels, outline, attachments, links and search. One real difference:
  `issue6204.pdf` names its link targets in a PDF 1.1 `/Dests` dictionary, which
  pdf.js reads and papyra's `dest.rs` does not — a papyra gap, not the adapter's.
- **The point of it, checked.** On a page served without COOP/COEP, a provider given
  `[defaultPdfEngine, PdfjsEngine]` chose pdf.js, the `PdfViewer` block rendered,
  and no wasm or papyra runtime file was fetched — `/core` doing its job.
- **Performance.** Native A/B against PR 4 (14 documents, 15 rounds, min): open
  +2.4%, cold render −3.4%, cached render −4.3%, `pageSize` −0.2%, search −0.2% —
  noise in both directions; `open` does not touch the changed scheduler.
- **PR 6 is in two halves; this repo's is done.** `crates/tauri-plugin-papyra` and
  `packages/tauri` are built and tested here; wiring them into aldoa's app and
  measuring on a phone is the other half.
- **The plugin answers in the napi bindings' shapes**, not papyra's public ones, so
  `TauriEngine` normalises with papyra's own `toPageText`, `toPageLink`,
  `toAttachment`, `buildOutlineTree` and `buildStructTree` — exported from `/core`
  for it. One normalisation, two hosts.
- **Its own Cargo workspace.** Tauri on Linux needs webkit2gtk's headers; as a root
  member every `cargo clippy --workspace` would need them. CI checks it in a
  `tauri-plugin` job on macOS, which needs nothing extra.
- **`TauriEngine` is not `abortable`**: aborting the page `fetch` leaves the Rust
  render running, so abandoning it would only render a revisited page twice.
- **Both page formats ship**, chosen by `new TauriEngine({ format })`: PNG (encode in
  Rust, `createImageBitmap` off the main thread) and raw RGBA (`X-Width`/`X-Height`,
  painted with `putImageData`). PNG is the default until a phone says otherwise.
- **The password rides in an `x-papyra-password` header**, percent-encoded, because
  the body is the file's bytes and headers are ASCII.
- **Tested through Tauri's real IPC dispatch** on the mock runtime (`tests/ipc.rs`,
  granting the commands an ACL the mock context lacks): raw-body `open`, the header,
  argument names, tagged password errors, `close` freeing the document. The
  protocol handler is tested on tracemonkey in both formats.
- **Fixes from wiring it into aldoa** (its agent's notes):
  - `@build-qube/papyra` is a **peer** of both engine packages (`^0.5.0`): as a
    dependency it installed a second papyra beside the app's, and `instanceof
    PasswordError` failed across the two, so the password prompt never showed.
    `.changeset/config.json` sets `onlyUpdatePeerDependentsWhenOutOfRange`, without
    which changesets would major-bump the fixed group over a peer; a dry run of
    `changeset version` puts all four packages at 0.5.0.
  - **`PapyraEngine` left `/core` for `@build-qube/papyra/engine`.** A bundler emits
    the wasm as soon as its graph reaches the loader — lazily or not, tree-shaken or
    not — so with the engine in `/core`, importing `rotateSize` shipped 6 MB. The
    purity test now forbids even a lazy edge. The registry's no-provider default
    moved into its own item, `pdf-default-engine`, the one file that names papyra's
    engine; aliasing it took a pdf.js-only viewer build from 22.5 MB to 15.9 MB, with
    no wasm and no loader.
  - The host **frees a WebView's documents when it loads a page** (`on_page_load`,
    by WebView label), since a reload strands every id the old page held.
  - **`open_count`**, outside `papyra:default`, for an app's leak check.
  - **`close` is awaitable**: `engine.close(doc)` returns a promise and a backend's
    `close` may be async, so a host that fails to free a document is heard. The
    handle still closes synchronously; the viewer logs a failed close.
  - Documented: an app must set `[profile.dev.package."*"] opt-level = 2` itself
    (Cargo ignores a dependency's profiles; hayro unoptimised was 1.3–1.7 s a page
    in a debug simulator build), the crate's Rust 1.92 floor, and the CSP
    `connect-src` entries the protocol needs.
  - Not done: `open` from a path or URL rather than bytes over IPC — later.
- **TIFF, spreadsheets and office on Tauri (0.6.0)** — the §7 table's Tauri row,
  built smaller than §7 drew it:
  - **No `TiffEngine` or `WorkbookEngine`.** Neither view uses an engine, so the
    Tauri side mirrors papyra's real API instead: `openTiff` and `openWorkbook`
    resolve to papyra's own `TiffImage` and `Workbook`, which moved into `/core` and
    take any native-shaped source (`TiffSource`, `WorkbookSource`). Office, which
    *is* a `PagedEngine`, gets `TauriOfficeEngine`.
  - **Injected through renderer options, not a format-keyed provider**:
    `tiffRenderer.with({ open })`, `spreadsheetRenderer`/`csvRenderer` likewise,
    `pptxRenderer`/`docxPagedRenderer.with({ engine })`. An injected opener skips
    `PdfIsolationGuard`, which the default path keeps.
  - **The grid stayed synchronous.** A Tauri sheet's cells come over whole, in one
    packed binary call, and windows are cut in the WebView — about 19 bytes a cell
    plus text, held twice. The async-window grid §7 called "the largest single
    piece of UI work" is deferred until a real phone needs it; the plugin's
    `window` command is already the shape it would call.
  - **One table, one protocol.** The host's documents are an enum (paged, TIFF,
    workbook); PDF commands use only `Document` trait methods, so office documents
    — a `Document` adapter in the office crate — share the table and `papyra://`.
  - **Office is git-only**: `tauri-plugin-papyra-office`, `publish = false`, a
    member of the plugin's workspace. It path-depends on the plugin, whose
    `links` key forbids two copies, so an app takes both from git at one tag.
  - **Permissions**: each feature has a set (`papyra:tiff`, `papyra:tables`). The
    commands' permission files are generated whatever the features, so they do not
    churn in git; the IPC tests resolve those files rather than a hand-built ACL.

## Why

aldoa-mono wants the viewer inside its Tauri 2 mobile app, and neither mobile WebView
will run papyra's browser build:

- Android WebView 149 receives COOP/COEP and is a secure context, yet reports
  `crossOriginIsolated === false`.
- iOS WKWebView on `tauri://localhost` reports `false` as well.

Without isolation there is no `SharedArrayBuffer`, so the threaded
`wasm32-wasip1-threads` build cannot run. The `wasm-no-shared-memory` spike showed
that a single-threaded `wasm32-wasip1` build works with no Rust changes, but it is
2.6–2.9x slower on full renders of large documents and runs on the main thread:
1.66 s per scanned page, 28 s of blocked main thread across a 90-page set. That is
not good enough to be *the* mobile answer.

So the registry's viewer should stop hard-wiring one engine. The app picks one; the
default stays exactly what ships today.

## Decisions in one place

1. **An engine is a class**, swapped by passing a different instance. Constructing one
   loads nothing. Engine modules may `import type` from `@build-qube/papyra-native`,
   never a value; the papyra engine reaches its wasm with a dynamic `import()` the
   first time a document is opened.
2. **The document is a handle; the engine holds the commands.** `engine.open()` returns
   a `PdfDoc` — plain, synchronous facts (page count, page sizes, metadata,
   capabilities). Everything that does work is a method on the engine taking that
   handle: `engine.render(doc, page, …)`, `engine.search(doc, query, …)`.
3. **The viewer pulls the engine from context.** `<PdfEngineProvider engine={…}>` at the
   app root; components call `usePdfEngine()` and apply its commands to the document in
   the store or their `doc` prop. No provider means today's wasm engine, so existing
   consumers need no config.
4. **Scheduling, caching and search are written once**, in an abstract base class.
   A concrete engine implements a handful of protected primitives (open, rasterise,
   extract text, …); the base turns those into the public commands with papyra's
   priority queue, byte-bounded caches, `fitWidth` resolution and search. Four engines
   get identical queueing and identical search.
5. **A page is `RenderedPage | ImageBitmap`.** Wasm hands back RGBA, as today; pdf.js and
   the Tauri engine hand back an `ImageBitmap`. `paintToCanvas` accepts both. URLs are
   an engine-internal transport.
6. **The guard asks the engine** (`engine.availability()`) instead of checking
   `crossOriginIsolated` itself. `PdfIsolationGuard` survives as an alias.
7. **Capabilities are flags on the handle**, and the UI hides what an engine lacks.
8. **Viewer code stops importing `@build-qube/papyra`'s main entry.** A new
   `@build-qube/papyra/core` subpath carries the engine classes and every pure helper,
   with no value import of the native package anywhere in its graph. It absorbs draft
   #50's `/view` entry, and #50's `PageSource` becomes `PagedDoc` + `PagedEngine` (§7.1).
9. **The pattern covers every papyra-backed format, in two families** (§7):
   `PagedEngine` for PDF, TIFF and (later) office documents, with PDF as the
   capability-rich subclass; `WorkbookEngine` for xlsx/xls/ods/csv/tsv. Renderers
   that already run anywhere (image, HEIC, video, audio, code, markdown, docx) get no
   engine.
10. **Engines 3 and 4 are separate npm packages** whose classes extend the base from
    `/core`. No registry item imports them.

## 1. The engine class

```
 registry components & hooks
   const engine = usePdfEngine()          ← from context
   engine.render(doc, page, opts)         ← doc from the store or a prop
            │
            ▼
 abstract class PdfEngine                  @build-qube/papyra/core — no wasm
   public commands: open · render · stream · search · pageText · outline · links
                    pageLabels · attachments · attachmentData · structTree · close
   owns per document: scheduler · render/text/link caches · memoised reads
            │  calls protected primitives:
            ▼
 ├─ PapyraEngine     @build-qube/papyra/core   import() of papyra-native on first open
 ├─ PapyraWorkerEngine   @build-qube/papyra/core   Worker hosting the wasip1 build (optional)
 ├─ PdfjsEngine          @build-qube/papyra-pdfjs  pdfjs-dist peer dependency
 └─ TauriEngine          @build-qube/papyra-tauri  commands + papyra:// protocol
```

### The handle

```ts
/** An open document. Data only; every operation is a method on its engine. */
export interface PdfDoc {
  /** Which engine opened it — `PdfEngine.id`. */
  readonly engine: string;
  readonly pageCount: number;
  /**
   * Every page's size in points, rotation and crop box applied, known at open.
   * Sync on purpose: the continuous view lays out all pages from frame one. An engine
   * whose sizes are async (pdf.js, Tauri) collects them all inside open().
   */
  readonly pageSizes: readonly PageSize[];
  readonly fingerprint: string;
  readonly metadata: DocumentMetadata;
  readonly pdfVersion: string | null;
  readonly capabilities: Capabilities;
}
```

A handle is only meaningful to the engine that issued it. The base class keeps each
document's state (backend, scheduler, caches) in a private `WeakMap<PdfDoc, …>`, so
handing engine B a handle from engine A throws "this document was opened by another
engine" instead of doing something strange. Dropping the handle lets the state be
collected; `close()` frees engine-side memory sooner.

### The base class

```ts
export abstract class PdfEngine {
  abstract readonly id: string;
  /** Whether this engine can run here. Sync, loads nothing — a guard renders on it. */
  abstract availability(): Availability;
  /** Defaults for the per-document scheduler and cache. */
  protected readonly defaults: { concurrency: number; cacheBytes: number };

  // ── public commands: implemented once, here ──────────────────────────────
  open(source: EngineSource, options?: OpenOptions): Promise<PdfDoc>;
  render(doc: PdfDoc, page: number, options?: RenderOptions): RenderHandle<PageBitmap>;
  stream(doc: PdfDoc, options?: StreamOptions): AsyncIterable<StreamedPage<PageBitmap>>;
  pageText(doc: PdfDoc, page: number, options?: TextOptions): Promise<PageText>;
  search(doc: PdfDoc, query: string, options?: SearchOptions): AsyncIterable<SearchMatch>;
  outline(doc: PdfDoc): Promise<OutlineNode[]>;
  links(doc: PdfDoc, page: number): Promise<readonly PageLink[]>;
  pageLabels(doc: PdfDoc): Promise<readonly string[]>;
  attachments(doc: PdfDoc): Promise<readonly Attachment[]>;
  attachmentData(doc: PdfDoc, index: number): Promise<Uint8Array>;
  structTree(doc: PdfDoc): Promise<StructNode[]>;
  close(doc: PdfDoc): void;

  // ── what a concrete engine implements ────────────────────────────────────
  /** Parse and collect the handle's facts. Throws papyra's password errors. */
  protected abstract load(source: EngineSource, options: LoadOptions): Promise<Backend>;
}

/** One open document, engine-side. Returned by `load`, never seen by the viewer. */
export interface Backend {
  readonly facts: Omit<PdfDoc, 'engine'>;
  /**
   * Rasterise at `scale` device pixels per point — the base turns fitWidth/dpi into
   * this, so engines never see either. `signal` aborts a *running* render where the
   * engine can; papyra's wasm ignores it, since interpretation is non-preemptible.
   */
  renderPage(page: number, o: { scale: number; annotations: boolean }, signal: AbortSignal): Promise<PageBitmap>;
  // Optional, matching `capabilities`. Absent ⇒ the command returns an empty result.
  pageText?(page: number, signal: AbortSignal): Promise<PageText>;
  outline?(): Promise<OutlineNode[]>;
  links?(page: number): Promise<readonly PageLink[]>;
  pageLabels?(): Promise<readonly string[]>;
  attachments?(): Promise<readonly Attachment[]>;
  attachmentData?(index: number): Promise<Uint8Array>;
  structTree?(): Promise<StructNode[]>;
  close?(): void;
}

export type Availability =
  | { readonly ok: true }
  | { readonly ok: false; readonly title: string; readonly reason: string };

/** Bytes as today, or a URL the engine may fetch itself (Tauri: a path read in Rust). */
export type EngineSource = PdfSource | { readonly url: string };

export interface Capabilities {
  text: boolean;              // find bar, results list, structure highlights
  outline: boolean;
  links: boolean;
  attachments: boolean;
  structure: boolean;
  pageLabels: boolean;
  annotationsToggle: boolean;
}

/** What the viewer paints. Both have width/height; paintToCanvas takes either. */
export type PageBitmap = RenderedPage | ImageBitmap;
```

Every primitive returns papyra's **public** shapes (`PageText`, `OutlineNode`,
`PageLink`, …). The normalisation `document.ts` does on napi's results today moves
into `PapyraEngine`'s backend, so no other engine ever sees a napi type.

The base's command bodies are today's `Document` methods, moved: `render` keeps its
cache key (including `annotationKey`), coalescing, `cached` flag, `setPriority` and
`cancel`; `search` keeps searching `pageText` outward in TypeScript. The render cache
sizes an `ImageBitmap` as `width * height * 4`, and **does not `close()` one on
eviction**: `PageCanvas` holds thumbnails in state and repaints them on rotation, so
eviction drops the reference and GC frees it — the lifetime `RenderedPage` has today.

### The papyra engine, without importing wasm

```ts
import type { PdfDocument as NativeDocument } from '@build-qube/papyra-native'; // erased

export class PapyraEngine extends PdfEngine {
  readonly id = 'papyra-wasm';
  availability() {
    return globalThis.crossOriginIsolated || typeof window === 'undefined'
      ? { ok: true }
      : { ok: false, title: 'This page is not cross-origin isolated', reason: '…today’s guard text…' };
  }
  protected async load(source, options) {
    const native = await import('@build-qube/papyra-native'); // the only way in
    native.init();                                            // thread pool, reserveMemory, as today
    // …NativeDocument.load / loadWithPassword, wrap as a Backend…
  }
}
```

The bundler puts the native package in its own chunk, fetched on the first `open()` —
what `pdfRenderer.load` already arranges for the whole PDF view today, now true even
when the view's own code has been loaded.

### Node, and today's `Document`

`@build-qube/papyra`'s main entry keeps `open()` and the `Document` class, so no Node
caller changes. `Document` becomes a thin façade: it holds a `PapyraEngine` and a
handle, forwards each method (`doc.render(i)` → `engine.render(handle, i)`), and keeps
the wasm-only extras — `renderImage`, `renderSvg`, `renderPages` (the rayon batch),
`indexText`'s rayon path, `clearCache`, `queued`. One implementation of the queue,
two ways to call it.

`Document` also *is* a valid `PdfDoc`: it has the handle's fields and is registered in
the default engine's `WeakMap`. So an app that today opens a `Document` and passes it to
`<PdfViewer doc={…}>` keeps working without changing a line.

## 2. Choosing the engine

```tsx
// Today, and still valid — no provider means new PapyraEngine():
<FilePreview file={f} />

// aldoa-mono's Tauri app, once, at the root:
import { TauriEngine } from '@build-qube/papyra-tauri';
const engine = new TauriEngine();
<PdfEngineProvider engine={engine}>…</PdfEngineProvider>

// A web app that wants a fallback where isolation is missing:
<PdfEngineProvider engine={[new PapyraEngine(), new PdfjsEngine({ workerSrc })]}>
```

- `engine` takes an instance or a list; with a list the provider keeps the **first whose
  `availability()` is ok**, chosen once on mount.
- `usePdfEngine()` returns it, or a module-level default `PapyraEngine` when there is
  no provider. Instantiating that default costs nothing, which is what makes it safe to
  have one.
- The store gets the engine too: `createPdfViewerStore({ engine })`, which
  `PdfViewerProvider` fills from context. Its `load()` calls `engine.open()`, and the
  document slice holds the `PdfDoc`.

How a component reaches a command:

```tsx
const engine = usePdfEngine();
const doc = usePdfDocument()?.doc;          // or the `doc` prop, as now
const handle = engine.render(doc, index, { fitWidth, priority, annotations });
```

A `usePdfCommands()` hook binding the engine to the store's current document was
considered and left out: the components that render pages (surface, thumbnails, page
preview) take `doc` as a prop and are used outside a store, so the two-name form
above is the one that works everywhere. It can be added later as sugar.

Rejected:

- **`createFilePreview` / `pdfRenderer.with({ engine })`.** The engine is app
  infrastructure; the blocks that take a `doc` never open anything and the store's
  `load()` is not under a renderer. Nesting a provider still allows a per-subtree
  override.
- **Methods on the document object (`doc.render`).** That is today's shape. It forces
  every engine to ship a document class, and it keeps the viewer coupled to whichever
  class the document happens to be; with the handle the only object the viewer
  depends on is the one in context.

## 3. What changes in the registry

The command call sites: **16 in 11 files** (`grep` for `doc.render|stream|search|…(`),
each becoming `engine.x(doc, …)`.

| File | Change |
|---|---|
| new `lib/pdf-engine.tsx` (item `pdf-engine`) | `PdfEngineProvider`, `usePdfEngine`, `PdfEngineGuard`. |
| `pdf-isolation-guard.tsx` | `PdfEngineGuard` re-exported under the old name. With the default engine its message is today's, word for word (the text moves into `PapyraEngine.availability()`). |
| `lib/pdf-viewer-store.ts` | `load()` opens through the store's engine; closes the previous document **only if the store opened it** (not one passed to `setDocument`). `doc: PdfDoc`. |
| `file-preview-pdf-view.tsx` | `open(file)` → `usePdfEngine().open(file)`; `engine.close(doc)` on unmount and when the file changes. |
| `pdf-page-surface.tsx`, `pdf-thumbnails.tsx`, `pdf-page-preview.tsx`, `pdf-viewer-basic.tsx`, `pdf-viewer-configurable.tsx` | `doc.render`/`doc.stream` → `engine.render(doc, …)`/`engine.stream(doc, …)`. `RenderedPage` → `PageBitmap` in types. `pdf-page-canvas.tsx`: type only. |
| `pdf-find-bar.tsx` | `engine.search(doc, …)`, `engine.pageText(doc, …)`; hidden when `!doc.capabilities.text`. |
| `pdf-sidebar.tsx`, `pdf-attachments.tsx`, `pdf-structure.tsx`, `pdf-links.tsx`, `use-pdf-page-labels.ts` | Commands via the engine. Tabs hidden by capability *before* the async read, so a tab never appears and vanishes. |
| `viewer-zoom-bar.tsx` / config | Annotation switch hidden when `!capabilities.annotationsToggle`. |
| `pdf-properties.tsx` | `doc.pageSize(i)` → `doc.pageSizes[i]`; adds an "Engine" row from `doc.engine`, useful in a bug report from a phone. |
| everything importing values from `@build-qube/papyra` | Imports `@build-qube/papyra/core` instead (`viewport`, `rotateSize`, `viewportQuad`, `viewportRect`, `lineQuad`, `readingOrder`, `paintToCanvas`, attachment helpers, error classes). |

Zoom, the continuous column and highlights need no engine logic: they read only
`pageSizes` (sync, kept) and render handles (same `cached`, `setPriority`, `cancel`).

Prop types on the public blocks change from `Document` to `PdfDoc`; since `Document`
satisfies `PdfDoc`, existing callers still compile.

## 4. Capabilities per engine

| | wasm (1) | wasip1 worker (2) | pdf.js (3) | Tauri (4) |
|---|---|---|---|---|
| render | RGBA | RGBA (transferred) | ImageBitmap | ImageBitmap |
| text / search | ✓ | ✓ | ✓ approx. geometry¹ | ✓ |
| outline, links, page labels, attachments | ✓ | ✓ | ✓ | ✓ |
| structure | ✓ | ✓ | ✗² | ✓ |
| annotation toggle | ✓ | ✓ | ✓ (`annotationMode`) | ✓ |
| needs isolation | yes | no | no | no (needs Tauri) |
| default concurrency | 4 (as today) | 1 | 2 | `hardwareConcurrency - 1` |

¹ pdf.js `getTextContent()` gives one width per text item, not per glyph, so the
adapter spreads it evenly across the item's characters for `offsets`. Highlights are
exact at item edges and approximate inside them. Coordinates go through
`page.getViewport({ scale: 1 }).transform` to land in papyra's space (top-left,
rotation applied), the same rule the hayro text path follows.
² pdf.js's `getStructTree()` has a different shape and no mcid→line join.

## 5. Cancellation and scheduling

Unchanged rule: **queued work reorders, running work is not preempted.** New: when a
running job's handle is cancelled, the base aborts the `AbortSignal` it passed to the
primitive.

- wasm (1): ignored, as today.
- worker (2): ignored for renders; a queued RPC is simply never posted.
- pdf.js (3): `renderTask.cancel()`, which pdf.js checks between operator chunks.
- Tauri (4): `fetch(url, { signal })` aborts the transfer; Rust may finish the render.

`yieldToUrgent` and per-surface `setPriority` work for every engine because they live
in the base class.

## 6. The four engines

### 1. `PapyraEngine` (default)

Today's code behind `load()`. Behaviour, cache key, concurrency and the
`reserveMemory` pre-grow are untouched — the acceptance test for PR 2 is that the demo
and every integration test pass unchanged.

### 2. `PapyraWorkerEngine` (optional)

The spike's `wasm32-wasip1` build (with `+simd128` for that target in
`.cargo/config.toml`) inside a dedicated Worker; the backend is an RPC proxy. Renders
come back as a transferred `ArrayBuffer` wrapped as a `RenderedPage`. This fixes the
spike's blocked main thread, not its 2.6–2.9x, which is why it comes last. One worker,
concurrency 1. Packaging: a second wasm target package and a worker script, both
reached only through `import()`. **To verify first:** napi's `wasip1-browser.js` loader
runs in a module Worker.

### 3. `PdfjsEngine` — `@build-qube/papyra-pdfjs`

Over `pdfjs-dist` (peer dependency). Renders into an `OffscreenCanvas` and returns
`transferToImageBitmap()`. Maps `PasswordException` codes onto papyra's two password
errors. `load()` reads every page's `view` for `pageSizes` — **to measure** on a
1,000-page file. Fingerprint: `fingerprints[0]`, which is `/ID` rather than papyra's
content hash; per-engine, and documented as such.

### 4. `TauriEngine` — `@build-qube/papyra-tauri` + crate `tauri-plugin-papyra`

Rust side, a Tauri 2 plugin depending on `papyra-hayro`:

- **Commands** (small JSON): `open(bytes | path, password) -> { id, facts }` (bytes as
  Tauri 2's raw binary IPC body), `page_text`, `outline`, `links`, `page_labels`,
  `attachments`, `attachment_data`, `struct_tree`, `close(id)`. All return papyra's
  public shapes.
- **Protocol** `register_asynchronous_uri_scheme_protocol("papyra", …)` serving
  `papyra://localhost/<id>/<page>?scale=2&annots=1`. Android and Windows expose custom
  schemes as `http://papyra.localhost/…`, so the URL is built per platform. Responses
  carry `Access-Control-Allow-Origin: *`, because the page's origin is `tauri://localhost`
  / `http://tauri.localhost` and the fetch is cross-origin. The JS side does
  `createImageBitmap(await res.blob())`, which decodes off the main thread.
- **Response format** is the plugin's private contract. Start with PNG as briefed
  (`papyra-encode` has it) and measure raw RGBA with `X-Width`/`X-Height` headers
  against it — no encode or decode, 4x the bytes over an in-process channel. Choose on
  numbers from a real phone.
- **Lifetime:** `Mutex<HashMap<u32, Arc<HayroDocument>>>` in plugin state, freed by
  `close`. This is why §3 adds `engine.close()` calls: without them every previewed file
  stays in the host until the app exits.
- Renders run on the host's rayon pool and real cores: no isolation, no wasm, no
  main-thread cost.

`availability()` checks `'__TAURI_INTERNALS__' in globalThis`. Peer dependency
`@tauri-apps/api@^2`.

## 7. Across the file preview

### Every renderer, by who does the work

| Renderer | Work done by | Runs without isolation? | Engine? |
|---|---|---|---|
| image | browser `<img>` | yes | no |
| HEIC (in flight, `skein/38`) | browser decode, probed once | yes (shows only where the WebView decodes HEIC) | no |
| video, audio | browser `<video>`/`<audio>` | yes | no |
| code | shiki, JS regex engine | yes | no |
| markdown | react-markdown | yes | no |
| docx | docx-preview + JSZip | yes | no |
| **pdf** | papyra wasm (`open`) | **no** | `PdfEngine` |
| **tiff** | papyra wasm (`openTiff`) | **no** | `PagedEngine` |
| **spreadsheet** | papyra wasm (`openWorkbook`) | **no** | `WorkbookEngine` |
| **csv / tsv** | papyra wasm (`openWorkbook`) | **no** | `WorkbookEngine` |
| office docx/pptx (draft #50) | separate papyra-office wasm | no (same threaded build) | `PagedEngine` |

The dividing line is not the format, it is **papyra's wasm**. Every renderer behind
it is blank in aldoa's mobile app today, CSV included — a plain-text format failing on
an isolation guard is the case that makes "PDF only" too narrow. Every renderer not
behind it already works in a WebView and gains nothing from an engine.

### The rule: same view → engine; different view → renderer

pdf.js, Tauri and wasm all feed the *same* page column, so they are engines. The
office spike's `docxRenderer.with({ engine: 'papyra' })` swaps docx-preview's HTML
for a paged canvas — a different view — so it is a **second renderer**
(`docxPagedRenderer`), chosen through `createFilePreview`'s list as every other
renderer is. That keeps "engine" meaning one thing.

### Two families, one pattern

Everything in §1 — a class that loads nothing until `open`, a data-only handle,
commands on the engine, the base class owning queue and caches, `availability()`,
context — applies to all of them. The command sets differ, because the shapes do:

- **`PagedEngine`** — `open → PagedDoc { pageCount, pageSizes, capabilities }`,
  `render`, `stream`, `close`. This is §1's base class with the PDF-specific commands
  taken off. **`PdfEngine extends PagedEngine`** adds text, search, outline, links,
  labels, attachments and structure. A TIFF engine is a `PagedEngine` with no extra
  capabilities: `TiffImage` already has `pageCount`, per-page sizes and an async
  `renderPage`, and today has no queue or cache — which it gains for free. Office
  documents are the same family; #50's `PageSource` is this interface arrived at
  independently; §7.1 reconciles the two.
- **`WorkbookEngine`** — `open → WorkbookDoc { format, sheets, encoding, delimiter }`,
  `sheet(doc, which) → SheetDoc { rows, cols, merges, styles, layout, truncated }`,
  `window(sheet, range) → Promise<CellWindow>`, `close`. A window is already four flat
  buffers, which is exactly what crosses a worker or Tauri IPC cheaply.

**The real cost is in the sheet view, not the engine.** `Sheet.window()` is
synchronous today, and `file-preview-sheet.tsx` calls it inside `useMemo` during
render (the visible window) and for column estimation and merges. Behind IPC it must
be async, so the grid needs a small window cache: draw from the last window that
covers the viewport, fetch the next with a margin, repaint on arrival. The wasm engine
can keep resolving synchronously-fast, so desktop behaviour does not change, but the
view has to be written for the async case. That is the largest single piece of UI
work anywhere in this design.

### Context across families

Keyed by **format**, not by family — the page column is shared by PDF, TIFF and office,
so "the paged engine" is not one engine:

```tsx
<PreviewEngineProvider engines={{ pdf: …, tiff: …, office: …, workbook: … }}>
```

`useEngine('pdf')` and so on; any key left out falls back to papyra's own wasm engine
for it. The Tauri package exports `tauriEngines()` returning every key bound to one
plugin instance, so aldoa writes one line. `PdfEngineProvider` from §2 is the
`{ pdf }` case of this.

Shared page components (§7.1 below) do not look an engine up by format. The view that
opened the document puts that engine in a **page scope** around them, and they read
`usePageEngine()`. Guards follow the engine the view actually uses.

## 7.1 Reconciling with #50 (`PageSource`, `/view`, `/office`)

Draft #50 (`spike/office-engines`) arrived at half of this design independently. What
it has, against current main:

- `PageSource { pageCount; pageSize(i); render(i, opts): RenderHandle }` in
  `types.ts`, implemented by `Document` and by a new `OfficeDocument`. `RenderHandle`
  moved from `document.ts` to `types.ts`.
- `@build-qube/papyra/view`: `paintToCanvas`, `toImageData`, the viewport helpers and
  their types — wasm-free. `pdf-continuous-pages`, `pdf-page-surface`,
  `pdf-highlights` and `pdf-links` import from it.
- `@build-qube/papyra/office`: `openOffice`, `addOfficeFont`, `OfficeDocument`, over an
  optional peer `@build-qube/papyra-office-native` (a second napi package, its own
  ~4.2 MB gz wasm).
- `PageSurface` takes a `PageSource`, and draws links only when
  `isPdf(doc)` — a structural check for a `links` method, because `instanceof Document`
  would load the PDF wasm.
- `docxRenderer.with({ engine: 'html' | 'papyra' })` choosing between docx-preview and
  the office page column.

### Where they agree

Both say a page view needs exactly: a page count, sizes up front (so the column has
its geometry before anything rasterises), and a render handle it can reprioritise and
drop. Both keep helpers in a wasm-free entry so a view for one format does not fetch
another's engine. Nothing in either contradicts the other on those points.

### Where they differ, and the resolution

| Topic | #50 | This design | Resolution |
|---|---|---|---|
| Who has the methods | the document (`doc.render`) | the engine (`engine.render(doc)`) | **The engine.** `PageSource`'s three members become `PagedDoc.pageCount`, `PagedDoc.pageSizes[i]`, and `PagedEngine.render(doc, i, o)`. `PageSource` is unreleased, so there is nothing to keep compatible. |
| Queue, cache, `fitWidth`, 100 MP guard | written twice — `OfficeDocument` repeats ~100 lines of `Document` | once, in `PagedEngine` | `OfficeEngine extends PagedEngine`, implementing only `load` and `renderPage(scale)`. The duplicate goes. |
| "Is this a PDF?" | `isPdf(doc)`, duck-typed on `links` | `doc.capabilities.links` | Capabilities. `isPdf` goes; so does the comment explaining why `instanceof` was impossible. |
| `pageSize(i)` lazy vs `pageSizes` eager | lazy, memoised per index (native call is sync) | eager array | **Eager.** A remote engine cannot answer synchronously; one `pageSizes` call at open is the only shape IPC can serve. The wasm engines fill it in `load()` — a loop of sync native calls, cheap. |
| Wasm-free entry | `/view` (helpers) | `/core` (helpers + base classes + papyra's own engine) | **One entry.** It is a superset of `/view`; name it once (open question). Everything in #50's `/view` keeps its export name. |
| Office engine location | `/office`, statically importing the office napi package | — | **Stays its own subpath, and becomes a class.** It cannot live in `/core`: even a dynamic `import('@build-qube/papyra-office-native')` fails a consumer's *build* when that optional peer is not installed, because bundlers resolve dynamic specifiers. `/office` exports `PapyraOfficeEngine`, which `import()`s the office wasm on first `open`, so importing `/office` itself costs nothing. |
| Fonts | `addOfficeFont(bytes)`, module-global | — | `officeEngine.addFont(bytes)`. Fonts belong to whatever runs the layout: the wasm module today, the Tauri host tomorrow — an engine method forwards to either. |
| docx: HTML vs paged | `docxRenderer.with({ engine })` | engines feed one view; different views are different renderers | **Two renderers.** `docxRenderer` (docx-preview, unchanged) and a paged one sharing the office view with `pptxRenderer`. Picked through `createFilePreview`'s list like any renderer. The word "engine" stays reserved for this design. |
| Guard in the office view | `PdfIsolationGuard` | `engine.availability()` | `EngineGuard` on the office engine. |

### Shared page components need a scope, not a format lookup

`ContinuousPages`, `PageSurface`, thumbnails and the zoom bar are used by PDF, office
and (§7) TIFF. They must call the engine that opened *their* document, and a lookup by
format cannot know which that is. So:

```tsx
// inside the office view, after useEngine('office').open(file):
<PageEngineScope engine={officeEngine}>
  <ContinuousPages doc={doc} … />
</PageEngineScope>
```

`usePageEngine()` reads the nearest scope. The PDF view and the PDF blocks set it from
`useEngine('pdf')`. Without a scope it falls back to the PDF default, so a consumer
rendering `<ContinuousPages doc={pdfDocument}>` today keeps working. A handle from
another engine still fails loudly through the `WeakMap` check rather than drawing
nothing.

### Order

This is not a later migration; it is folded into the first PRs:

- **PR 1** (`/core`) ships #50's `/view` contents under the agreed name, plus
  `RenderHandle` in `types.ts`.
- **PR 2** (base classes) introduces `PagedEngine` with `PdfEngine` on top, and is the
  PR that would have carried `PageSource`.
- **#50 rebases onto PR 2**: `OfficeDocument` becomes `PapyraOfficeEngine`, `isPdf`
  and the docx `engine` option go, the office view gains a page scope and a guard.
  That shrinks #50 rather than growing it.

### What each alternative engine covers

| | PDF | TIFF | workbook / CSV | office |
|---|---|---|---|---|
| papyra wasm (default) | ✓ | ✓ | ✓ | ✓ (#50) |
| wasip1 worker | ✓ | ✓ | ✓ | possible |
| pdf.js | ✓ | — | — | — |
| Tauri plugin | ✓ | ✓ (`papyra-tiff`) | ✓ (`papyra-tables`) | ✓ (`papyra-office`) |

Only Tauri covers the whole surface on mobile, which is a reason to build the plugin
around a shared document table and one protocol (`papyra://localhost/<id>/<page>` for
any paged doc) rather than as a PDF plugin that grows later. pdf.js stays PDF-only.

### Sequencing

Do not build all of it at once. The generalisation is in the **names and the base
class split** (`PagedEngine` ⊂ `PdfEngine`), which cost nothing extra in PRs 1–4. Then:
PDF on Tauri (as planned) → TIFF on Tauri (small: page-shaped already, and the view
swaps `tiff.renderPage` for `engine.render`) → workbook (the async-window grid) when
aldoa needs sheets on mobile → office when #50 lands.

## 8. Packaging, and paying nothing

| Engine | Ships as | Who pays |
|---|---|---|
| 1 wasm | class in `@build-qube/papyra/core`; wasm in `@build-qube/papyra-native` | only an app that opens a PDF with it, via `import()` |
| 2 wasip1 | class in `/core`; wasm in an extra target package | only an app that instantiates it, via `import()` |
| 3 pdf.js | `@build-qube/papyra-pdfjs` (peer `pdfjs-dist`) | only an app that installs it |
| 4 Tauri | `@build-qube/papyra-tauri` + `tauri-plugin-papyra` | only a Tauri app that installs both |

`/core` is the precondition. Today `index.ts` re-exports `document.ts`, which
value-imports `@build-qube/papyra-native`, whose browser loader instantiates the wasm
at module scope (`asyncInit`, top-level await). A bundler cannot drop a module with
top-level effects, so *any* value import from the main entry — `rotateSize` included —
pulls in the 2.4 MB gzipped wasm. Only five modules value-import the native package
(`document`, `encode`, `runtime`, `tiff`, `workbook`); `viewport`, `text`, `search`,
`outline`, `links`, `structure`, `attachments`, `canvas`, `scheduler`, `cache`,
`errors` and `fingerprint` already import it as types only. `/core` is those modules,
the base class and `PapyraEngine`. A unit test asserts that importing `/core` never
evaluates `@build-qube/papyra-native`, so the rule cannot erode. The main entry keeps
re-exporting everything, so no existing import breaks.

Engines 3 and 4 are npm packages rather than registry items: they are libraries with
tests, not UI a consumer edits. They join the changesets `fixed` group with
`@build-qube/papyra`, since they extend `/core`'s base class.

Registry items raise their `@build-qube/papyra` range to the release that adds `/core`
(they are already behind for sheet/TIFF, so this fixes that too).

## 9. Migration, in small PRs

Each PR leaves the default path the same in behaviour.

1. **`@build-qube/papyra/core`.** Subpath export of the pure modules, plus the
   "never evaluates the native package" test. No behaviour change.
2. **`PdfEngine` + `PapyraEngine`.** Move `Document`'s queue and cache logic into
   the base; `Document` becomes the façade. Adds capabilities, `close`, abort of running
   primitives, `PageBitmap` in `paintToCanvas`. Gate: every existing unit and
   integration test passes untouched. New `test/unit` coverage of the base over a fake
   engine returning `ImageBitmap`-like pages (no addon).
3. **Registry imports to `/core`.** Import lines only. Raise the papyra range.
4. **`pdf-engine` item, and the registry moves to `engine.x(doc)`.** Provider, hook,
   guard and its alias; the 16 call sites; store and file preview open and close
   through the engine; capability-driven hiding. The demo gets `?engine=` so every
   later engine is testable in a browser.
5. **`@build-qube/papyra-pdfjs`.** The universal fallback, testable in any browser and
   in CI without Tauri, and the first proof of the interface from outside papyra.
6. **`tauri-plugin-papyra` + `@build-qube/papyra-tauri`.** Built and measured in
   aldoa's app: PNG vs raw RGBA, open time, memory after closing 20 files.
7. **TIFF through `PagedEngine`**, wasm and Tauri.
8. **Workbook through `WorkbookEngine`**: async windows in the sheet grid, then Tauri
   commands over `papyra-tables`. When aldoa needs sheets or CSV on mobile.
9. *(optional)* **`PapyraWorkerEngine`**, only if pdf.js is inadequate somewhere Tauri is
   not available.

Office documents join `PagedEngine` when #50 rebases onto PR 2 (§7.1).

Decided since (2026-10-20):

- **Formats in the Tauri host are Cargo features of one plugin**, not separate
  plugins: `pdf` by default, `tiff`, `tables` and `office` (#50's renderers run in
  Rust) opt-in, with `build.rs` listing each feature's commands so its permissions
  follow it. One open-document map, one reload hook, one protocol, one capability.
  The JS side adds an engine class per format to `@build-qube/papyra-tauri`.
- **Download, share and open-with are not engine commands.** They are what a
  *platform* does with a file, not how a format is read, so they get their own
  context in the file preview. Coupling them to engines would make every format need
  an engine to get a share button. On an iOS simulator (aldoa, 2026-10-20) the Web
  Share API is the whole implementation: `navigator.canShare({ files })` is true in
  WKWebView and `share()` opens the system sheet (Save to Files, Print, other apps;
  cancel rejects with `AbortError`). `<a download>` does nothing there, and the opener
  plugin's `openPath` fails (2.5.5) and could only `UIApplication.open` a file anyway,
  which presents no sheet for the app's own sandbox. So a WKWebView host opts in with
  `<FileActionsProvider share>` — `share()` when `canShare` says yes, else the anchor
  download, with no Tauri plugin — and the default stays the anchor download: desktop Safari and Chrome report `canShare({ files })` true as
  well, and the macOS sheet has no save to disk, so sharing by default would take the
  plain download away from desktop. `share()` needs the tap's user activation, so the
  bytes must already be in hand when the button is pressed. Android is untested.
- **No WebP page format or image export through engines** until a viewer needs one;
  papyra's `renderImage`/`encode` already export WebP.
- The plugin follows the `tauri plugin new` layout (`commands.rs`, `models.rs`,
  `error.rs`, with a serialisable error enum), less the Android and iOS projects
  (no native code: hayro is Rust) and `guest-js` (the engine is its own package).
  schemars is for a global *scope* schema; it arrives with a path scope, if `open`
  ever reads files from disk.

### Vendored consumers (aldoa-mono)

aldoa installs items with `shadcn add` and carries local edits marked `aldoa:`.

- PRs 1–2 touch no registry file.
- PR 3 changes only import specifiers: `'@build-qube/papyra'` → `'@build-qube/papyra/core'`
  in files that import values. Re-add, or make the replacement by hand.
- PR 4 is the one that touches logic: 11 files, each a mechanical
  `doc.x(…)` → `engine.x(doc, …)` plus a `usePdfEngine()` line. The
  `@workspace/pdf-viewer` CHANGELOG entry lists exactly those files, since that changelog
  is the only record a URL-installed consumer has. Re-add into a branch, then restore
  the `aldoa:` hunks from `git diff`. A file aldoa leaves un-updated keeps compiling
  and keeps working on the default engine, because `Document` still has its methods and
  still satisfies `PdfDoc` — it simply will not follow a non-default engine.
- aldoa then wraps its mobile root in `<PdfEngineProvider engine={new TauriEngine()}>`
  and leaves its web root alone, or gives it `[new PapyraEngine(), new PdfjsEngine()]`.

## Open questions and things to verify

- Does the threaded loader *fail* at import in a non-isolated WebView, or only when a
  worker thread starts? It does not change the design (`/core` is needed either way,
  to avoid the download), but it decides whether PR 3 is a fix or an optimisation.
- pdf.js `load()` cost of eager page sizes on a 1,000-page file.
- Tauri: PNG vs raw RGBA on a mid-range Android phone; whether WKWebView delivers
  custom-scheme responses to `fetch` with the CORS header as expected.
- Whether the properties dialog should show `fingerprint` for engines whose fingerprint
  is `/ID`, or label which one it is.
- Names: `PagedEngine` / `PdfEngine` / `WorkbookEngine`, `PdfDoc` / `Backend`.
  (Decided: the wasm-free entry is `/core`; #50's `/view` imports move to it.)
- The paged docx renderer's id and label (`docx-paged`? `word`?), since both it and
  `docxRenderer` claim `.docx` and the allow list picks between them.
- Whether single-threaded wasm on the main thread is acceptable for workbooks only
  (parsing is one-shot, not per scroll) — measure a large xlsx before building the
  Tauri workbook path.
