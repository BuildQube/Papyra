import {
  PdfDocument as NativeDocument,
  type PageImage as NativePageImage,
} from '@build-qube/papyra-native';
import { type CacheStats, RenderCache } from './cache.js';
import { PageImage } from './encode.js';
import { buildOutlineTree, type OutlineNode } from './outline.js';
import {
  currentRuntime,
  hardwareConcurrency,
  init,
  MAX_WASM_CONCURRENCY,
} from './runtime.js';
import { DEFAULT_PRIORITY, type JobHandle, Scheduler } from './scheduler.js';
import { type SearchMatch, searchPageText } from './search.js';
import { toBytes } from './source.js';
import { type PageText, pageTextBytes, toPageText } from './text.js';
import type {
  OpenOptions,
  PageSize,
  PdfSource,
  RenderedPage,
  RenderOptions,
  SearchOptions,
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

/** Default bytes of rendered pages to keep. Roughly eleven 2000px ARCH-E sheets. */
const DEFAULT_CACHE_BYTES = 128 * 1024 * 1024;

/**
 * Default bytes of extracted text to keep.
 *
 * Text is three orders of magnitude smaller than the pixels of the same page — a
 * dense page of a paper is ~80 KB against ~11 MB — so this holds hundreds of pages
 * and a repeated search never re-extracts.
 */
const DEFAULT_TEXT_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * Where text extraction sits in the queue by default.
 *
 * Behind rendering: a search that stalls the page the user is looking at is worse
 * than one that takes another beat to fill in.
 */
const DEFAULT_TEXT_PRIORITY = 3;

/** A queued render, plus whether it was served from cache without rendering at all. */
export interface RenderHandle extends JobHandle<RenderedPage> {
  readonly cached: boolean;
}

/**
 * A queued export render. No `cached` flag: unlike {@link RenderHandle} the image path
 * never comes from the cache, which is keyed by page and size with no format dimension.
 */
export type ImageHandle = JobHandle<PageImage>;

/** Wire an `AbortSignal` to a queued job. Cancelling only drops work not yet started. */
function attachSignal(
  handle: JobHandle<unknown>,
  signal: AbortSignal | undefined,
): void {
  if (!signal) return;
  if (signal.aborted) {
    handle.cancel('signal aborted');
    return;
  }
  signal.addEventListener('abort', () => handle.cancel('signal aborted'), {
    once: true,
  });
}

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
  return new Document(inner, options);
}

export class Document {
  readonly #inner: NativeDocument;
  // One queue for every kind of job, `renderImage` included: priority and concurrency
  // are the point of this library, and a bulk export must not starve the visible page.
  readonly #scheduler: Scheduler;
  readonly #limit: number;
  readonly #cache: RenderCache<RenderedPage>;
  readonly #text: RenderCache<PageText>;
  /** Memoised by {@link outline}; the outline cannot change under us. */
  #outline: Promise<OutlineNode[]> | undefined;
  /** Memoised by {@link indexText}. */
  #indexed: Promise<void> | undefined;

  /** @internal — construct via {@link open}. */
  constructor(inner: NativeDocument, options: OpenOptions = {}) {
    this.#inner = inner;
    this.#limit = Math.max(1, options.concurrency ?? defaultConcurrency());
    this.#scheduler = new Scheduler(this.#limit, {
      yieldToUrgent: options.yieldToUrgent,
    });
    this.#cache = new RenderCache<RenderedPage>(
      options.cacheBytes ?? DEFAULT_CACHE_BYTES,
      (page) => page.data.byteLength,
    );
    this.#text = new RenderCache<PageText>(
      options.textCacheBytes ?? DEFAULT_TEXT_CACHE_BYTES,
      pageTextBytes,
    );
  }

  /** Rendered pages held for reuse, and how often that has paid off. */
  get cache(): CacheStats {
    return this.#cache.stats;
  }

  /** Drop every cached page. */
  clearCache(): void {
    this.#cache.clear();
  }

  /** Pages queued but not yet started, pages rendering, and the longest wait so far. */
  get queued(): { pending: number; running: number; oldestWaitMs: number } {
    return {
      pending: this.#scheduler.pendingCount,
      running: this.#scheduler.runningCount,
      oldestWaitMs: this.#scheduler.oldestWaitMs,
    };
  }

  get pageCount(): number {
    return this.#inner.pageCount;
  }

  /**
   * The document outline — bookmarks, the table of contents — as a tree.
   *
   * Resolves to an empty array when the document has no outline, which is the common
   * case. The walk runs off the event loop and the result is memoised, so calling
   * this on every render of a sidebar costs nothing after the first.
   *
   * Entries that point outside the document (a URL, another file) and containers that
   * group children without a destination of their own both have a `dest` of `null`;
   * they are kept because a viewer still lists them.
   *
   * @example
   * ```ts
   * for (const node of await doc.outline()) {
   *   if (node.page !== null) void doc.render(node.page, { fitWidth: 1600 });
   * }
   * ```
   */
  async outline(): Promise<OutlineNode[]> {
    this.#outline ??= this.#inner
      .outline()
      .then(buildOutlineTree)
      // A failed walk must not be cached as a permanent empty outline.
      .catch((e: unknown) => {
        this.#outline = undefined;
        throw e;
      });
    return this.#outline;
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
   * Render a page for export, keeping the pixels in Rust.
   *
   * The returned {@link PageImage} encodes on demand — `toWebp()`, `toPng()`,
   * `toJpeg()`, `toDataUrl()` — and never hands the raw bitmap to JS. A 42x30in
   * drawing at 150 DPI is 6.5 MB raw and a fraction of that encoded, so for anything
   * leaving the process that buffer is pure overhead.
   *
   * Use `renderPage` when you want to paint to a canvas, and `encode()` when you want
   * both the pixels and a file.
   *
   * Shares the scheduler with every other render, so priority and concurrency behave
   * exactly as they do for `render`. **Not cached** — the cache is keyed by page and
   * size with no format dimension, and it measures raw bytes.
   *
   * @example
   * ```ts
   * const img = await doc.renderImage(0, { fitWidth: 2000 });
   * await writeFile('page-0.webp', (await img.toWebp()).bytes);
   * ```
   */
  async renderImage(
    index: number,
    options: RenderOptions = {},
  ): Promise<PageImage> {
    return this.imageHandle(index, options).promise;
  }

  /**
   * As {@link renderImage}, but returns the handle so the job can be reprioritised,
   * cancelled, or timed — the same relationship `render` has to `renderPage`.
   *
   * `timing` is where the export path becomes measurable: it separates queue wait from
   * render time, which end-to-end timing around the promise cannot.
   */
  imageHandle(index: number, options: RenderOptions = {}): ImageHandle {
    const dpi = this.#resolveDpi(index, options);

    // A distinct key space from `render`, so an image request never coalesces onto a
    // pending raw render (different return type) or vice versa.
    const handle = this.#scheduler.submit({
      key: `image:${index}@${dpi.toFixed(4)}`,
      priority: options.priority ?? DEFAULT_PRIORITY,
      run: () =>
        (
          this.#inner.renderPageImageAsync(
            index,
            dpi,
            options.signal,
          ) as Promise<NativePageImage>
        ).then((img) => new PageImage(img)),
    });

    attachSignal(handle, options.signal);
    return handle;
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
  render(index: number, options: RenderOptions = {}): RenderHandle {
    const dpi = this.#resolveDpi(index, options);
    const key = `${index}@${dpi.toFixed(4)}`;

    const hit = this.#cache.get(key);
    if (hit) return cachedHandle(key, hit);

    const handle = this.#scheduler.submit<RenderedPage>({
      key,
      priority: options.priority ?? DEFAULT_PRIORITY,
      run: () =>
        (this.#inner.renderPageAsync(index, dpi) as Promise<RenderedPage>).then(
          (page) => {
            this.#cache.set(key, page);
            return page;
          },
        ),
    });

    attachSignal(handle, options.signal);
    return liveHandle(handle);
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

  /**
   * Extract the text of one page.
   *
   * Scheduled like a render, but behind one by default: a search should not stall the
   * page the user is looking at. Results are cached, so searching the same document
   * repeatedly extracts each page once.
   *
   * Extraction is interpretation without rasterisation, which makes it roughly a
   * hundredth the cost of rendering the same page — about 1ms for a dense page of a
   * paper. It is cheap enough to do speculatively.
   */
  async pageText(
    index: number,
    options: { priority?: number; signal?: AbortSignal } = {},
  ): Promise<PageText> {
    const key = `text:${index}`;
    const hit = this.#text.get(key);
    if (hit) return hit;

    // One queue for renders and text both, so priority means something across them.
    // Coalescing by key is what stops a search and a text selection extracting the
    // same page twice.
    const handle = this.#scheduler.submit<PageText>({
      key,
      priority: options.priority ?? DEFAULT_TEXT_PRIORITY,
      run: async () => {
        const text = toPageText(index, await this.#inner.pageTextAsync(index));
        this.#text.set(key, text);
        return text;
      },
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

    return handle.promise;
  }

  /**
   * Extract every page's text up front, so a later search is immediate.
   *
   * Worth calling on a long document: on native this fans out across rayon rather
   * than the JS thread pool, which an addon cannot resize past four threads —
   * measured 15ms for a 14-page paper against ~1ms per page one at a time.
   *
   * On wasm it walks the pages through the scheduler instead. The rayon batch is a
   * native-only path for the same reason `renderPages` is: rayon's wasm workers are
   * Web Workers the JS event loop has to create, and driving a batch from a blocked
   * thread traps (`docs/spike-results.md`, "wasm parallel rendering is UNSTABLE").
   *
   * Idempotent, and never necessary — {@link search} extracts what it needs as it
   * goes. This only trades a pause now for instant results later.
   */
  async indexText(options: { priority?: number } = {}): Promise<void> {
    this.#indexed ??= this.#index(options).catch((e: unknown) => {
      // A failed pass must not be remembered as a completed one.
      this.#indexed = undefined;
      throw e;
    });
    return this.#indexed;
  }

  async #index(options: { priority?: number }): Promise<void> {
    if (currentRuntime() === 'native') {
      const all = await this.#inner.pageTextsAsync(0, this.pageCount);
      for (const [i, native] of all.entries()) {
        this.#text.set(`text:${i}`, toPageText(i, native));
      }
      return;
    }
    // The scheduler bounds how many run at once, so this stays within the four
    // in-flight tasks napi-rs's browser glue allows.
    await Promise.all(
      range(0, this.pageCount).map((i) => this.pageText(i, options)),
    );
  }

  /**
   * Find `query` in the document, yielding matches as each page is searched.
   *
   * Streaming rather than collected, because the first hit is usually the one the user
   * wants and a long document should not make them wait for the last. Breaking out of
   * the loop stops the search.
   *
   * `order` is the lever a viewer wants: searching outward from the current page finds
   * the nearest hit first, which is almost never page 1.
   *
   * @example
   * ```ts
   * for await (const hit of doc.search('site plan', { order: outward(current) })) {
   *   show(hit.page, hit.rects);
   *   break;
   * }
   * ```
   */
  async *search(
    query: string,
    options: SearchOptions = {},
  ): AsyncGenerator<SearchMatch> {
    if (query.trim() === '') return;

    const pages = options.order ?? range(0, this.pageCount);
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    let found = 0;

    for (const page of pages) {
      if (options.signal?.aborted) return;
      const text = await this.pageText(page, {
        priority: options.priority ?? DEFAULT_TEXT_PRIORITY,
        signal: options.signal,
      });

      for (const match of searchPageText(text, query, options)) {
        yield match;
        if (++found >= limit) return;
      }
    }
  }

  /** Extracted page text held for reuse, and how often that has paid off. */
  get textCache(): CacheStats {
    return this.#text.stats;
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

/**
 * Wrap a scheduler handle as a {@link RenderHandle}.
 *
 * Delegates rather than spreading: `timing` is a getter that is null until the job
 * settles, and a spread would freeze it at null forever.
 */
function liveHandle(handle: JobHandle<RenderedPage>): RenderHandle {
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

/** A handle for work that never had to happen. */
function cachedHandle(key: string, page: RenderedPage): RenderHandle {
  return {
    key,
    cached: true,
    promise: Promise.resolve(page),
    timing: { waitMs: 0, runMs: 0 },
    setPriority: () => {},
    cancel: () => {},
  };
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}
