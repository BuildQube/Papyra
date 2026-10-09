import {
  loadOffice,
  type OfficeDocument as NativeOfficeDocument,
  addFont as nativeAddFont,
} from '@build-qube/papyra-office-native';
import { RenderCache } from './cache.js';
import { DEFAULT_PRIORITY, Scheduler } from './scheduler.js';
import { toBytes } from './source.js';
import type {
  PageSize,
  PageSource,
  PdfSource,
  RenderedPage,
  RenderHandle,
  RenderOptions,
} from './types.js';

/** What an office file is: a Word document, or a PowerPoint deck. */
export type OfficeKind = 'word' | 'slides';

/** Size options for {@link OfficeDocument.renderPage}. */
export interface OfficeRenderOptions {
  /** Pixels per point. Defaults to 1, which puts a US Letter page at 612 px wide. */
  scale?: number;
  /** Target output width in pixels. Overrides `scale`. */
  fitWidth?: number;
}

/**
 * Same ceiling a PDF render has, for the same reason: 100 MP is ~400 MB of RGBA, and
 * past it a caller almost certainly meant `fitWidth`.
 */
const MAX_PIXELS = 100_000_000;

/** Rendered pages kept for reuse by default, as for a PDF. */
const DEFAULT_CACHE_BYTES = 128 * 1024 * 1024;

/**
 * Renders in flight at once. napi-rs runs an addon's async work on a pool of four in
 * the browser, so more only queues inside the glue, where priority cannot reach it.
 */
const DEFAULT_CONCURRENCY = 4;

/** Options for {@link openOffice}. */
export interface OfficeOpenOptions {
  /** Renders in flight at once. Defaults to 4. */
  concurrency?: number;
  /** Bytes of rendered pages to keep for reuse. Defaults to 128 MB; 0 disables. */
  cacheBytes?: number;
}

/**
 * Make a TrueType or OpenType font available to the Word and PowerPoint engines.
 *
 * **Call it before {@link openOffice}.** A document names fonts like Calibri that
 * cannot be shipped, so each engine substitutes — and a substitute with different
 * widths moves every line break after it. Carlito, Caladea and Liberation Sans/Serif
 * are metric-compatible with Calibri, Cambria and Arial/Times New Roman, and both
 * engines already prefer them by name. A browser has no system fonts at all, so
 * without this, Word text falls back to Source Sans and slide text to Ubuntu Light.
 *
 * Returns how many faces were read; 0 means the bytes were not a font.
 */
export async function addOfficeFont(source: PdfSource): Promise<number> {
  return nativeAddFont(await toBytes(source));
}

/**
 * Open a Word document (`.docx`, `.docm`, `.dotx`, `.dotm`) or PowerPoint deck
 * (`.pptx`, `.potx`, `.ppsx` and macro-enabled twins), and lay it out into pages.
 *
 * The file is recognised by its declared main part, not its name, so a renamed
 * workbook or plain zip is refused. Layout happens here, off the JS thread: a Word
 * document is paginated once, up front.
 *
 * Experimental. The engines are WordCraft and DeckCraft — clean-room, pure-Rust
 * reimplementations that are young enough that a real-world file may lay out
 * differently from Office.
 *
 * @example
 * ```ts
 * await addOfficeFont(await (await fetch('/fonts/Carlito-Regular.ttf')).bytes());
 * const doc = await openOffice(file);
 * const page = await doc.renderPage(0, { fitWidth: 1200 });
 * paintToCanvas(page, canvas);
 * ```
 */
export async function openOffice(
  source: PdfSource,
  options: OfficeOpenOptions = {},
): Promise<OfficeDocument> {
  const bytes = await toBytes(source);
  return new OfficeDocument(await loadOffice(bytes), options);
}

/**
 * An opened Word document or PowerPoint deck. Get one from {@link openOffice}.
 *
 * A `PageSource`, like a PDF `Document`: renders go through a priority queue that
 * coalesces repeats and a byte-bounded cache, so a page view written for PDFs —
 * continuous scroll included — shows one unchanged.
 */
export class OfficeDocument implements PageSource {
  /** `'word'` or `'slides'`. */
  readonly kind: OfficeKind;
  /** Pages in a document, slides in a deck — hidden slides included. */
  readonly pageCount: number;
  readonly #native: NativeOfficeDocument;
  readonly #scheduler: Scheduler;
  readonly #cache: RenderCache<RenderedPage>;
  /** Sizes are fixed once laid out, and a scrolling column asks for every one. */
  readonly #sizes: (PageSize | undefined)[] = [];

  /** @internal — construct via {@link openOffice}. */
  constructor(native: NativeOfficeDocument, options: OfficeOpenOptions = {}) {
    this.#native = native;
    this.#scheduler = new Scheduler(
      Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY),
    );
    this.#cache = new RenderCache<RenderedPage>(
      options.cacheBytes ?? DEFAULT_CACHE_BYTES,
      (page) => page.data.byteLength,
    );
    this.kind = native.kind as OfficeKind;
    this.pageCount = native.pageCount;
  }

  /**
   * Page size in points (1/72 inch). Every slide in a deck shares one size; a Word
   * document's sections may each set their own.
   */
  pageSize(index: number): PageSize {
    this.#check(index);
    let size = this.#sizes[index];
    if (!size) {
      size = this.#native.pageSize(index);
      this.#sizes[index] = size;
    }
    return size;
  }

  /**
   * Render a page on this document's queue, returning a handle to reprioritise or
   * drop — the viewer path, exactly as `Document.render`. Sized by `fitWidth`, else
   * `dpi` (72 is the page's natural size). `annotations` does not apply.
   */
  render(index: number, options: RenderOptions = {}): RenderHandle {
    const scale = this.#resolveScale(index, options);
    const key = `${index}@${scale.toFixed(5)}`;

    const hit = this.#cache.get(key);
    if (hit) {
      return {
        key,
        cached: true,
        promise: Promise.resolve(hit),
        timing: { waitMs: 0, runMs: 0 },
        setPriority: () => {},
        cancel: () => {},
      };
    }

    const handle = this.#scheduler.submit<RenderedPage>({
      key,
      priority: options.priority ?? DEFAULT_PRIORITY,
      run: () =>
        (this.#native.renderPage(index, scale) as Promise<RenderedPage>).then(
          (page) => {
            this.#cache.set(key, page);
            return page;
          },
        ),
    });
    const signal = options.signal;
    if (signal?.aborted) handle.cancel('signal aborted');
    else
      signal?.addEventListener('abort', () => handle.cancel('signal aborted'), {
        once: true,
      });
    return {
      key: handle.key,
      cached: false,
      promise: handle.promise,
      get timing() {
        return handle.timing;
      },
      setPriority: (priority: number) => handle.setPriority(priority),
      cancel: (reason?: string) => handle.cancel(reason),
    };
  }

  /**
   * Draw one page to RGBA, off the JS thread. Paint it with `paintToCanvas` or
   * encode it with `encode`, exactly as a rendered PDF page.
   */
  renderPage(
    index: number,
    options: OfficeRenderOptions = {},
  ): Promise<RenderedPage> {
    try {
      return this.render(index, {
        fitWidth: options.fitWidth,
        dpi: options.scale === undefined ? undefined : options.scale * 72,
      }).promise;
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** Pixels per point for `options`, refusing absurd outputs as a PDF render does. */
  #resolveScale(index: number, options: RenderOptions): number {
    const { width, height } = this.pageSize(index);
    const scale =
      options.fitWidth !== undefined && width > 0
        ? options.fitWidth / width
        : (options.dpi ?? 72) / 72;
    if (!(scale > 0) || !Number.isFinite(scale)) {
      throw new RangeError(`papyra: invalid scale ${JSON.stringify(scale)}`);
    }
    if (width * scale * (height * scale) > MAX_PIXELS) {
      throw new RangeError(
        `papyra: page ${index} at ${scale.toFixed(2)}x would be ` +
          `${Math.round(width * scale)}x${Math.round(height * scale)}; ` +
          'use { fitWidth } to size by output pixels instead.',
      );
    }
    return scale;
  }

  #check(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.pageCount) {
      throw new RangeError(`papyra: no page ${JSON.stringify(index)}`);
    }
  }
}
