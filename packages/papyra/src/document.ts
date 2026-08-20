import { PdfDocument as NativeDocument } from '@build-qube/papyra-native';
import {
  currentRuntime,
  hardwareConcurrency,
  init,
  MAX_WASM_CONCURRENCY,
} from './runtime.js';
import { toBytes } from './source.js';
import type {
  OpenOptions,
  PageSize,
  PdfSource,
  RenderedPage,
  RenderOptions,
  StreamedPage,
  StreamOptions,
} from './types.js';

const DEFAULT_DPI = 72;

/**
 * Refuse renders large enough to take down the tab.
 *
 * 100 MP is ~400 MB of RGBA — beyond this you almost certainly meant `fitWidth`.
 */
const MAX_PIXELS = 100_000_000;

/** Open a PDF from bytes, an `ArrayBuffer`, a `Blob`, or a `File`. */
export async function open(
  source: PdfSource,
  options: OpenOptions = {},
): Promise<Document> {
  init();
  const bytes = await toBytes(source);
  const inner =
    options.password === undefined
      ? NativeDocument.load(bytes)
      : NativeDocument.loadWithPassword(bytes, options.password);
  return new Document(inner);
}

export class Document {
  readonly #inner: NativeDocument;

  /** @internal — construct via {@link open}. */
  constructor(inner: NativeDocument) {
    this.#inner = inner;
  }

  get pageCount(): number {
    return this.#inner.pageCount;
  }

  /** Page dimensions in PDF points (1/72 inch). */
  pageSize(index: number): PageSize {
    return this.#inner.pageSize(index);
  }

  /** Render a single page. Never blocks the event loop. */
  async renderPage(
    index: number,
    options: RenderOptions = {},
  ): Promise<RenderedPage> {
    return (await this.#inner.renderPageAsync(
      index,
      this.#resolveDpi(index, options),
    )) as RenderedPage;
  }

  /**
   * Turn `fitWidth`/`dpi` into a concrete DPI, and refuse absurd outputs.
   *
   * `fitWidth` exists because page sizes vary by two orders of magnitude in area: a
   * DPI that is sensible for US Letter produces a 113 MB bitmap for an ARCH-E drawing.
   */
  #resolveDpi(index: number, options: RenderOptions): number {
    const { width, height } = this.pageSize(index);
    const dpi =
      options.fitWidth !== undefined && width > 0
        ? (options.fitWidth / width) * 72
        : (options.dpi ?? DEFAULT_DPI);

    const pixels = ((width * dpi) / 72) * ((height * dpi) / 72);
    if (pixels > MAX_PIXELS) {
      const mb = Math.round((pixels * 4) / 1e6);
      throw new RangeError(
        `papyra: page ${index} at ${dpi.toFixed(1)} DPI would be ` +
          `${Math.round((width * dpi) / 72)}x${Math.round((height * dpi) / 72)} ` +
          `(${mb} MB). The page is ${(width / 72).toFixed(1)}x${(height / 72).toFixed(1)}in — ` +
          'use { fitWidth } to size by output pixels instead of DPI.',
      );
    }
    return dpi;
  }

  /**
   * Render `[start, end)`.
   *
   * The concurrency strategy differs by runtime, for reasons measured in
   * `docs/spike-results.md`:
   *
   * - **native** — one async task with rayon inside. Fastest, and independent of
   *   `UV_THREADPOOL_SIZE`, which we cannot set from inside an addon.
   * - **wasm** — per-page async tasks. rayon's workers there are Web Workers that the
   *   JS event loop has to create, so a rayon batch cannot be driven from a blocked
   *   thread; per-page tasks map onto the runtime's own worker pool instead.
   */
  async renderPages(
    start: number,
    end: number,
    options: RenderOptions = {},
  ): Promise<RenderedPage[]> {
    if (currentRuntime() === 'native' && options.fitWidth === undefined) {
      // One DPI for the whole batch, so every page in range has to pass the guard —
      // a document can mix a letter-size cover sheet with ARCH-E drawings.
      let dpi = DEFAULT_DPI;
      for (let i = start; i < end; i++) dpi = this.#resolveDpi(i, options);
      return (await this.#inner.renderPagesAsync(
        start,
        end,
        dpi,
      )) as RenderedPage[];
    }
    const out: RenderedPage[] = [];
    for await (const { page, bitmap } of this.stream({
      ...options,
      order: range(start, end),
    })) {
      out[page - start] = bitmap;
    }
    return out;
  }

  /**
   * Render pages as an async iterable, yielding each as soon as it finishes.
   *
   * At most `concurrency` renders are in flight, so memory stays bounded — 23 letter
   * pages at 150 DPI is ~193 MB of RGBA if you hold them all. Breaking out of the loop
   * stops scheduling further work, which makes "thumbnails for the visible rows only"
   * cheap.
   *
   * @example
   * ```ts
   * for await (const { page, bitmap } of doc.stream({ dpi: 48, order: visible })) {
   *   paint(page, bitmap);
   * }
   * ```
   */
  async *stream(options: StreamOptions = {}): AsyncGenerator<StreamedPage> {
    const pages = options.order ?? range(0, this.pageCount);
    // napi-rs fixes the browser async-work pool at 4, so oversubscribing it just
    // holds more pixel buffers in memory for nothing: measured 6.1 ms/page flat from
    // concurrency 4 through 16 on an 18-core machine. See docs/spike-results.md.
    const ceiling =
      currentRuntime() === 'wasm'
        ? MAX_WASM_CONCURRENCY
        : hardwareConcurrency();
    const limit = Math.max(
      1,
      options.concurrency ?? Math.min(ceiling, pages.length || 1),
    );

    const inflight = new Map<
      number,
      Promise<StreamedPage & { slot: number }>
    >();
    let next = 0;

    const schedule = (slot: number): void => {
      const page = pages[slot];
      if (page === undefined) return;
      inflight.set(
        slot,
        this.renderPage(page, options).then((bitmap) => ({
          slot,
          page,
          bitmap,
        })),
      );
    };

    try {
      while (next < pages.length && inflight.size < limit) schedule(next++);
      while (inflight.size > 0) {
        options.signal?.throwIfAborted();
        const { slot, page, bitmap } = await Promise.race(inflight.values());
        inflight.delete(slot);
        if (next < pages.length) schedule(next++);
        yield { page, bitmap };
      }
    } finally {
      // Nothing to cancel: in-flight renders are already running on worker threads
      // and their results are simply dropped. We just stop scheduling new ones.
      inflight.clear();
    }
  }
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}
