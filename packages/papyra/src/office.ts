import type { OfficeDocument as NativeOfficeDocument } from '@build-qube/papyra-office-native';
import {
  type Availability,
  type BackendRenderOptions,
  type PagedBackend,
  type PagedDoc,
  PagedEngine,
  RENDER_ONLY,
} from './engine.js';
import { toBytes } from './source.js';
import type {
  OpenOptions,
  PageSize,
  PdfSource,
  RenderedPage,
} from './types.js';

/** What an office file is: a Word document, or a PowerPoint deck. */
export type OfficeKind = 'word' | 'slides';

/** An open Word document or PowerPoint deck. Get one from {@link OfficeEngine.open}. */
export interface OfficeDoc extends PagedDoc {
  /** `'word'` or `'slides'`. Pages in a document, slides in a deck — hidden ones too. */
  readonly kind: OfficeKind;
}

/**
 * Renders in flight at once. napi-rs runs an addon's async work on a pool of four in
 * the browser, so more only queues inside the glue, where priority cannot reach it.
 */
const CONCURRENCY = 4;

type Native = typeof import('@build-qube/papyra-office-native');

/** The addon once loaded. Process-wide, like the addon itself. */
let native: Promise<Native> | undefined;

function loadNative(): Promise<Native> {
  native ??= import('@build-qube/papyra-office-native');
  return native;
}

/**
 * Make a TrueType or OpenType font available to the Word and PowerPoint engines.
 *
 * **Call it before opening a document.** A document names fonts like Calibri that
 * cannot be shipped, so each engine substitutes — and a substitute with different
 * widths moves every line break after it. Carlito, Caladea and Liberation Sans/Serif
 * are metric-compatible with Calibri, Cambria and Arial/Times New Roman, and both
 * engines already prefer them by name. A browser has no system fonts at all, so
 * without this, Word text falls back to Source Sans and slide text to Ubuntu Light.
 *
 * Returns how many faces were read; 0 means the bytes were not a font.
 */
export async function addOfficeFont(source: PdfSource): Promise<number> {
  const [{ addFont }, bytes] = await Promise.all([
    loadNative(),
    toBytes(source),
  ]);
  return addFont(bytes);
}

/** The addon's document, as a {@link PagedBackend}. */
class OfficeBackend implements PagedBackend {
  readonly kind: OfficeKind;
  readonly pageCount: number;
  readonly capabilities = RENDER_ONLY;
  readonly concurrency = CONCURRENCY;
  readonly #native: NativeOfficeDocument;
  /** Sizes are fixed once laid out, and a scrolling column asks for every one. */
  readonly #sizes: (PageSize | undefined)[] = [];

  constructor(native: NativeOfficeDocument) {
    this.#native = native;
    this.kind = native.kind as OfficeKind;
    this.pageCount = native.pageCount;
  }

  /**
   * Page size in points (1/72 inch). Every slide in a deck shares one size; a Word
   * document's sections may each set their own.
   */
  pageSize(index: number): PageSize {
    if (!Number.isInteger(index) || index < 0 || index >= this.pageCount) {
      throw new RangeError(`papyra: no page ${JSON.stringify(index)}`);
    }
    let size = this.#sizes[index];
    if (!size) {
      size = this.#native.pageSize(index);
      this.#sizes[index] = size;
    }
    return size;
  }

  /** `annotations` does not apply: an office page has none to switch off. */
  renderPage(
    index: number,
    { dpi }: BackendRenderOptions,
  ): Promise<RenderedPage> {
    return this.#native.renderPage(index, dpi / 72) as Promise<RenderedPage>;
  }
}

/**
 * Word documents (`.docx`, `.docm`, `.dotx`, `.dotm`) and PowerPoint decks (`.pptx`,
 * `.potx`, `.ppsx` and their macro-enabled twins), laid out and drawn by papyra in
 * Rust over WordCraft and DeckCraft.
 *
 * A {@link PagedEngine}, so renders get the same priority queue, coalescing,
 * byte-bounded cache and `fitWidth` sizing a PDF's do, and a page column written for
 * PDFs shows these unchanged. Pages only: no text, links or outline.
 *
 * A file is recognised by its declared main part, not its name, so a renamed
 * workbook or plain zip is refused. A Word document is paginated once, while
 * opening. The office addon is its own wasm module — about 5.7 MB gzipped — fetched
 * by the first open, so naming this engine costs nothing until then.
 *
 * Experimental: the engines are young, and a real-world file may lay out differently
 * from Office.
 *
 * @example
 * ```ts
 * await addOfficeFont(await (await fetch('/fonts/Carlito-Regular.ttf')).bytes());
 * const doc = await officeEngine.open(file);
 * paintToCanvas(await officeEngine.render(doc, 0, { fitWidth: 1200 }).promise, canvas);
 * ```
 */
export class OfficeEngine extends PagedEngine<OfficeDoc, OfficeBackend> {
  readonly id = 'papyra-office';

  availability(): Availability {
    // `undefined` outside a browser (Node, Bun), where the native addon needs nothing.
    if (globalThis.crossOriginIsolated !== false) return { ok: true };
    return {
      ok: false,
      title: 'This page is not cross-origin isolated',
      reason:
        'papyra renders Word and PowerPoint in WebAssembly with shared memory, ' +
        'which needs SharedArrayBuffer. Serve this page with ' +
        'Cross-Origin-Opener-Policy: same-origin and ' +
        'Cross-Origin-Embedder-Policy: require-corp, then reload.',
    };
  }

  protected async load(
    source: PdfSource,
    _options: OpenOptions,
  ): Promise<OfficeBackend> {
    const [{ loadOffice }, bytes] = await Promise.all([
      loadNative(),
      toBytes(source),
    ]);
    return new OfficeBackend(await loadOffice(bytes));
  }

  protected handle(backend: OfficeBackend): OfficeDoc {
    return {
      engine: this.id,
      kind: backend.kind,
      pageCount: backend.pageCount,
      pageSize: (index) => backend.pageSize(index),
      capabilities: backend.capabilities,
    };
  }
}

/** The office engine, shared so every view opens into one queue per document. */
export const officeEngine: OfficeEngine = /* @__PURE__ */ new OfficeEngine();
