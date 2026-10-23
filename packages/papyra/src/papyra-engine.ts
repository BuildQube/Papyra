import type {
  PdfDocument as NativeDocument,
  DocumentInfo as NativeDocumentInfo,
} from '@build-qube/papyra-native';
import { type Attachment, toAttachment } from './attachments.js';
import type { Document } from './document.js';
import {
  type Availability,
  type BackendRenderOptions,
  type Capabilities,
  type PdfBackend,
  PdfEngine,
} from './engine.js';
import { rethrowLoadError } from './errors.js';
import { fingerprint } from './fingerprint.js';
import { type PageLink, toPageLink } from './links.js';
import { buildOutlineTree, type OutlineNode } from './outline.js';
import { toBytes } from './source.js';
import { buildStructTree, type StructNode } from './structure.js';
import { type PageText, toPageText } from './text.js';
import type {
  DocumentMetadata,
  OpenOptions,
  PageSize,
  PdfSource,
  RenderedPage,
  Tile,
} from './types.js';

const EVERYTHING: Capabilities = {
  text: true,
  outline: true,
  links: true,
  attachments: true,
  structure: true,
  pageLabels: true,
  annotationsToggle: true,
  tiles: true,
};

/** napi omits absent strings rather than nulling them; normalise to one shape. */
function toMetadata(info: NativeDocumentInfo): DocumentMetadata {
  return {
    title: info.title ?? null,
    author: info.author ?? null,
    subject: info.subject ?? null,
    keywords: info.keywords ?? null,
    creator: info.creator ?? null,
    producer: info.producer ?? null,
    created: info.created ?? null,
    modified: info.modified ?? null,
  };
}

type Addon = {
  native: typeof import('@build-qube/papyra-native');
  runtime: typeof import('./runtime.js');
  Document: typeof Document;
};

/** The addon once loaded. Process-wide, like the addon itself. */
let addon: Addon | undefined;

async function loadAddon(): Promise<Addon> {
  const [native, runtime, { Document }] = await Promise.all([
    import('@build-qube/papyra-native'),
    import('./runtime.js'),
    // With the addon, not before: `Document`'s export methods call it directly.
    import('./document.js'),
  ]);
  // Before any document loads: the wasm thread pool has to exist before rayon does.
  runtime.init();
  addon = { native, runtime, Document };
  return addon;
}

/**
 * papyra's own engine: hayro, compiled into the native addon in Node and into wasm in
 * a browser. Imported from `@build-qube/papyra/engine` (or the main entry), never from
 * `/core`, so an app that never names it ships none of its wasm.
 *
 * Constructing one loads nothing. The addon — in a browser, a wasm module of about
 * 2.5 MB — is fetched by the first {@link PagedEngine.open}, which is what lets a
 * bundle that names this engine as a default still cost nothing until a PDF opens.
 *
 * In a browser it needs a cross-origin-isolated page: the wasm build uses shared
 * memory, and so needs `SharedArrayBuffer`. {@link availability} says so.
 */
export class PapyraEngine extends PdfEngine {
  readonly id = 'papyra';

  availability(): Availability {
    // `undefined` outside a browser (Node, Bun), where the native addon needs nothing.
    if (globalThis.crossOriginIsolated !== false) return { ok: true };
    return {
      ok: false,
      title: 'This page is not cross-origin isolated',
      reason:
        'papyra renders in WebAssembly with shared memory, which needs ' +
        'SharedArrayBuffer. Serve this page with ' +
        'Cross-Origin-Opener-Policy: same-origin and ' +
        'Cross-Origin-Embedder-Policy: require-corp, then reload.',
    };
  }

  /**
   * Opens to a `Document`, which is a `PdfDoc` like any engine's handle and
   * also carries papyra's extras — `renderImage`, `renderSvg`, `cache` — so code that
   * knows it has papyra's engine can reach them with an `instanceof` check.
   */
  override async open(
    source: PdfSource,
    options: OpenOptions = {},
  ): Promise<Document> {
    const doc = await super.open(source, options);
    // Loaded by now: `super.open` went through `load`.
    const { Document } = addon ?? (await loadAddon());
    return new Document(doc, this);
  }

  protected async load(
    source: PdfSource,
    options: OpenOptions,
  ): Promise<PdfBackend> {
    // Only the first open waits on the import; after that `open` costs what it did
    // before engines existed (measured: two `import()`s per open were +6µs).
    const { native, runtime } = addon ?? (await loadAddon());
    const bytes = await toBytes(source);
    let inner: NativeDocument;
    try {
      inner =
        options.password === undefined
          ? native.PdfDocument.load(bytes)
          : native.PdfDocument.loadWithPassword(bytes, options.password);
    } catch (e) {
      rethrowLoadError(e);
    }
    return new PapyraBackend(
      inner,
      fingerprint(bytes),
      runtime.defaultConcurrency(),
      // One at a time on wasm, where four in flight finish later than one does —
      // the first of four lands at ~376ms against ~76ms alone (Addendum 13).
      runtime.currentRuntime() === 'wasm' ? 1 : undefined,
    );
  }
}

/**
 * The engine `open()` and `Document` go through, and the one a viewer falls back
 * to when the app names none. Being one instance is the point: a document belongs to
 * the engine that opened it, so a `Document` from `open()` and a viewer's default
 * engine have to be the same object for the viewer's commands to accept it.
 *
 * Costs nothing until a document opens, like any {@link PapyraEngine}.
 */
export const defaultPdfEngine: PapyraEngine =
  /* @__PURE__ */ new PapyraEngine();

/**
 * The addon's document, as a {@link PdfBackend}. Every napi shape is normalised
 * here, so nothing past this class sees one.
 *
 * @internal Exported for `Document`, whose export-only methods call the addon
 * directly.
 */
export class PapyraBackend implements PdfBackend {
  readonly capabilities = EVERYTHING;

  constructor(
    readonly native: NativeDocument,
    readonly fingerprint: string,
    readonly concurrency: number,
    readonly tileConcurrency?: number,
  ) {}

  get pageCount(): number {
    return this.native.pageCount;
  }

  pageSize(index: number): PageSize {
    return this.native.pageSize(index);
  }

  renderPage(
    index: number,
    options: BackendRenderOptions,
  ): Promise<RenderedPage> {
    return this.native.renderPageAsync(
      index,
      options.dpi,
      options.annotations,
    ) as Promise<RenderedPage>;
  }

  renderTile(
    index: number,
    { x, y, width, height }: Tile,
    options: BackendRenderOptions,
  ): Promise<RenderedPage> {
    return this.native.renderTileAsync(
      index,
      options.dpi,
      x,
      y,
      width,
      height,
      options.annotations,
    ) as Promise<RenderedPage>;
  }

  metadata(): DocumentMetadata {
    return toMetadata(this.native.info());
  }

  pdfVersion(): string | null {
    return this.native.pdfVersion ?? null;
  }

  async pageText(index: number): Promise<PageText> {
    return toPageText(index, await this.native.pageTextAsync(index));
  }

  outline(): Promise<OutlineNode[]> {
    return this.native.outline().then(buildOutlineTree);
  }

  links(index: number): Promise<readonly PageLink[]> {
    // `toPageLink` only returns null for a link with no resolvable target, which the
    // bindings do not emit — the filter is here so a future one cannot leak a null
    // into the array.
    return this.native
      .pageLinks(index)
      .then((native) =>
        native
          .map(toPageLink)
          .filter((link): link is PageLink => link !== null),
      );
  }

  pageLabels(): Promise<readonly string[]> {
    return this.native.pageLabels();
  }

  attachments(): Promise<readonly Attachment[]> {
    return this.native.attachments().then((files) => files.map(toAttachment));
  }

  attachmentData(index: number): Promise<Uint8Array> {
    return this.native.attachmentData(index);
  }

  structTree(): Promise<StructNode[]> {
    return this.native.structTree().then(buildStructTree);
  }
}
