import { PdfDocument as NativeDocument } from '@build-qube/papyra-native';
import {
  currentRuntime,
  hardwareConcurrency,
  init,
  MAX_WASM_CONCURRENCY,
} from './runtime.js';
import { DEFAULT_PRIORITY, type JobHandle, Scheduler } from './scheduler.js';
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
  return new Document(inner, options.concurrency);
}

export class Document {
  readonly #inner: NativeDocument;
  readonly #scheduler: Scheduler<RenderedPage>;
  readonly #limit: number;

  /** @internal — construct via {@link open}. */
  constructor(inner: NativeDocument, concurrency?: number) {
    this.#inner = inner;
    this.#limit = Math.max(1, concurrency ?? defaultConcurrency());
    this.#scheduler = new Scheduler<RenderedPage>(this.#limit);
  }

  /** Pages queued but not yet started, and pages currently rendering. */
  get queued(): { pending: number; running: number } {
    return {
      pending: this.#scheduler.pendingCount,
      running: this.#scheduler.runningCount,
    };
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
    return this.render(index, options).promise;
  }

  /**
   * Render a page, returning a handle you can reprioritise or drop.
   *
   * This is the viewer path: as the user scrolls, promote what came into view and
   * demote what left, without re-submitting or duplicating work. Requests for the same
   * page at the same size coalesce into one render, taking the most urgent priority
   * asked for.
   *
   * @example
   * ```ts
   * const jobs = visible.map((p) => doc.render(p, { fitWidth: 1600, priority: 0 }));
   * onScroll(() => {
   *   for (const [i, job] of jobs.entries()) job.setPriority(distanceFromViewport(i));
   * });
   * ```
   */
  render(index: number, options: RenderOptions = {}): JobHandle<RenderedPage> {
    const dpi = this.#resolveDpi(index, options);
    const handle = this.#scheduler.submit({
      key: `${index}@${dpi.toFixed(4)}`,
      priority: options.priority ?? DEFAULT_PRIORITY,
      run: () =>
        this.#inner.renderPageAsync(index, dpi) as Promise<RenderedPage>,
    });

    const { signal } = options;
    if (signal) {
      if (signal.aborted) handle.cancel('signal aborted');
      else
        signal.addEventListener(
          'abort',
          () => handle.cancel('signal aborted'),
          {
            once: true,
          },
        );
    }
    return handle;
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
    const window = Math.max(
      1,
      options.concurrency ?? Math.min(this.#limit, pages.length || 1),
    );

    type Completion = { slot: number; page: number; bitmap: RenderedPage };
    const inflight = new Map<number, Promise<Completion>>();
    const handles = new Map<number, JobHandle<RenderedPage>>();
    let next = 0;

    const schedule = (slot: number): void => {
      const page = pages[slot];
      if (page === undefined) return;
      const handle = this.render(page, options);
      handles.set(slot, handle);
      inflight.set(
        slot,
        handle.promise.then((bitmap) => ({ slot, page, bitmap })),
      );
    };

    try {
      while (next < pages.length && inflight.size < window) schedule(next++);
      while (inflight.size > 0) {
        const { slot, page, bitmap } = await Promise.race(inflight.values());
        inflight.delete(slot);
        handles.delete(slot);
        if (next < pages.length) schedule(next++);
        yield { page, bitmap };
      }
    } finally {
      // Breaking out of the loop drops everything still queued, so "thumbnails for
      // the rows I can see" does not keep rendering the rows I cannot.
      for (const [slot, handle] of handles) {
        handle.cancel('stream ended');
        // The derived promise rejects once cancelled; nobody is listening any more.
        inflight.get(slot)?.catch(() => {});
      }
      inflight.clear();
      handles.clear();
    }
  }

  /** How many pages this document will render at once. */
  get concurrency(): number {
    return this.#limit;
  }
}

function defaultConcurrency(): number {
  return currentRuntime() === 'wasm'
    ? MAX_WASM_CONCURRENCY
    : hardwareConcurrency();
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}
