import type { Attachment } from './attachments.js';
import { type CacheStats, RenderCache } from './cache.js';
import type { PageLink } from './links.js';
import type { OutlineNode } from './outline.js';
import { DEFAULT_PRIORITY, type JobHandle, Scheduler } from './scheduler.js';
import { type SearchMatch, searchPageText } from './search.js';
import type { StructNode } from './structure.js';
import { type PageText, pageTextBytes } from './text.js';
import type {
  DocumentMetadata,
  OpenOptions,
  PageBitmap,
  PageSize,
  PdfSource,
  RenderHandle,
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
 * Bytes of page links to keep.
 *
 * Not an option, unlike the render and text budgets: links are two orders of
 * magnitude smaller again — a page of a linked table of contents is a few hundred
 * bytes — so 4 MB holds tens of thousands of them and there is nothing to tune.
 */
const LINK_CACHE_BYTES = 4 * 1024 * 1024;

/** Rough bytes per cached link: two objects, a rect, and a short string. */
const LINK_BYTES = 96;

/** Used when neither the caller nor the backend names a concurrency. */
const FALLBACK_CONCURRENCY = 4;

/**
 * Where text extraction sits in the queue by default.
 *
 * Behind rendering: a search that stalls the page the user is looking at is worse
 * than one that takes another beat to fill in.
 */
export const DEFAULT_TEXT_PRIORITY = 3;

/**
 * What an engine can do beyond rendering pages.
 *
 * A viewer reads these to decide what to show at all — a find bar on an engine with
 * no text, or an outline tab on one that cannot read outlines, is a control that
 * silently does nothing. A command an engine lacks still resolves, to an empty
 * result, so code that ignores these flags degrades rather than throws.
 */
export interface Capabilities {
  /** Text extraction, and therefore search. */
  readonly text: boolean;
  /** The document outline. */
  readonly outline: boolean;
  /** Link regions and their targets. */
  readonly links: boolean;
  /** Embedded files. */
  readonly attachments: boolean;
  /** The structure tree of a tagged PDF. */
  readonly structure: boolean;
  /** Page labels. */
  readonly pageLabels: boolean;
  /** Whether {@link RenderOptions.annotations} is honoured. */
  readonly annotationsToggle: boolean;
}

/** No capabilities at all: an engine that only renders pages. */
export const RENDER_ONLY: Capabilities = {
  text: false,
  outline: false,
  links: false,
  attachments: false,
  structure: false,
  pageLabels: false,
  annotationsToggle: false,
};

/** Whether an engine can run here, and if not, what to tell the reader. */
export type Availability =
  | {
      /** It can. */
      readonly ok: true;
    }
  | {
      /** It cannot. */
      readonly ok: false;
      /** One line, for a heading. */
      readonly title: string;
      /** What is wrong and how to fix it, in plain text. */
      readonly reason: string;
    };

/**
 * An open document with pages: the facts a page view needs, and nothing that does
 * work. Every operation is a method on the engine that opened it, taking this as its
 * first argument — `engine.render(doc, 0)`.
 *
 * Only meaningful to that engine. Passing it to another throws rather than drawing
 * nothing.
 */
export interface PagedDoc {
  /** The `id` of the engine that opened it. */
  readonly engine: string;
  /** How many pages there are. Page indices are 0-based throughout. */
  readonly pageCount: number;
  /**
   * Page size in points (1/72 inch), before any view rotation.
   *
   * Synchronous, so a page column has its final geometry before anything
   * rasterises. An engine whose sizes live across an async boundary fetches them all
   * while opening.
   */
  pageSize(index: number): PageSize;
  /** What the engine can do with this document beyond rendering it. */
  readonly capabilities: Capabilities;
}

/** An open PDF. */
export interface PdfDoc extends PagedDoc {
  /**
   * A stable identifier for this document, for keying whatever you remember per
   * document. papyra's engine hashes the bytes; another engine may use the file's
   * own `/ID`. Stable per engine, not across engines.
   */
  readonly fingerprint: string;
  /** What the document says about itself. See {@link DocumentMetadata}. */
  readonly metadata: DocumentMetadata;
  /** The PDF version the file declares, e.g. `'1.7'`. */
  readonly pdfVersion: string | null;
}

/** How a backend is asked to render: everything sizing has already been resolved. */
export interface BackendRenderOptions {
  /**
   * Dots per inch. 72 is one pixel per point.
   *
   * Resolved from `fitWidth` or `dpi` by the engine, so a backend never sees either —
   * and handed over unconverted, because a page's pixel size is floored from it and a
   * round trip through another unit can move that by a pixel.
   */
  readonly dpi: number;
  /** Draw the document's own annotations. `undefined` means the backend's default. */
  readonly annotations: boolean | undefined;
}

/**
 * One open document, as an engine implementation sees it. Never handed to a viewer;
 * the engine wraps it in a {@link PagedDoc}.
 */
export interface PagedBackend {
  /** How many pages there are. */
  readonly pageCount: number;
  /** See {@link PagedDoc.pageSize}. */
  pageSize(index: number): PageSize;
  /** What this backend implements beyond {@link renderPage}. */
  readonly capabilities: Capabilities;
  /** Pages this backend can usefully render at once, when the caller does not say. */
  readonly concurrency?: number;
  /**
   * Rasterise one page.
   *
   * `signal` is the caller's, when it gave one. A backend that can stop a render
   * part-way may honour it; papyra's own cannot, since interpretation is not
   * preemptible.
   */
  renderPage(
    index: number,
    options: BackendRenderOptions,
    signal?: AbortSignal,
  ): Promise<PageBitmap>;
  /** Release whatever the backend holds outside the JS heap. */
  close?(): void;
}

/**
 * One open PDF, as an engine implementation sees it. The optional members match
 * {@link Capabilities}: a backend that leaves one out reports `false` for it.
 */
export interface PdfBackend extends PagedBackend {
  /** See {@link PdfDoc.fingerprint}. */
  readonly fingerprint: string;
  /** See {@link PdfDoc.metadata}. Called at most once. */
  metadata(): DocumentMetadata;
  /** See {@link PdfDoc.pdfVersion}. */
  pdfVersion(): string | null;
  /** One page's text, in 72-DPI top-left page space. */
  pageText?(index: number): Promise<PageText>;
  /** The outline, as a tree. */
  outline?(): Promise<OutlineNode[]>;
  /** One page's links. */
  links?(index: number): Promise<readonly PageLink[]>;
  /** One label per page, or none. */
  pageLabels?(): Promise<readonly string[]>;
  /** The embedded files, metadata only. */
  attachments?(): Promise<readonly Attachment[]>;
  /** One embedded file's bytes. */
  attachmentData?(index: number): Promise<Uint8Array>;
  /** The structure tree, flat and pre-order. */
  structTree?(): Promise<StructNode[]>;
}

/** @internal Everything an engine keeps per open document. */
export interface DocState<B extends PagedBackend = PagedBackend> {
  readonly engine: PagedEngine<PagedDoc, B>;
  readonly backend: B;
  // One queue for every kind of job: priority and concurrency are the point of this
  // library, and a bulk export must not starve the visible page.
  readonly scheduler: Scheduler;
  readonly limit: number;
  readonly cache: RenderCache<PageBitmap>;
  readonly text: RenderCache<PageText>;
  readonly links: RenderCache<readonly PageLink[]>;
  /** In-flight link reads, so two callers on one page share a single task. */
  readonly linksPending: Map<number, Promise<readonly PageLink[]>>;
  outline?: Promise<OutlineNode[]>;
  attachments?: Promise<readonly Attachment[]>;
  structure?: Promise<StructNode[]>;
  labels?: Promise<readonly string[]>;
  /** Set by `close`. A flag rather than only a delete, so every alias sees it. */
  closed?: boolean;
}

/**
 * Every live document, keyed by its handle.
 *
 * Module-level rather than per engine so that an alias — papyra's `Document`, which
 * is a handle in its own right — can share the state of the handle it wraps.
 */
const states = new WeakMap<object, DocState<never>>();

/** @internal The state behind a handle, checked against the engine asking. */
export function stateOf<B extends PagedBackend>(
  engine: PagedEngine<PagedDoc, B> | null,
  doc: object,
): DocState<B> {
  const state = states.get(doc) as DocState<B> | undefined;
  if (!state || state.closed) {
    throw new Error('papyra: this document is closed, or was never opened');
  }
  if (engine && state.engine !== engine) {
    throw new Error(
      `papyra: this document was opened by another engine (${state.engine.id})`,
    );
  }
  return state;
}

/** @internal Make `alias` stand for the same open document as `doc`. */
export function adopt(alias: object, doc: object): void {
  states.set(alias, stateOf(null, doc) as DocState<never>);
}

/** @internal Cache key of one page's extracted text. */
export function textKey(index: number): string {
  return `text:${index}`;
}

/**
 * Cache- and coalescing-key suffix for the annotation switch.
 *
 * Empty in the default case, so the ordinary key keeps the shape it has always had.
 * The suffix has to exist at all because the scheduler coalesces on this string and
 * the cache is looked up by it: without it, asking for a page with annotations off
 * would be served the bitmap that still has them drawn on.
 *
 * @internal
 */
export function annotationKey(options: {
  annotations?: boolean | undefined;
}): string {
  return options.annotations === false ? ':noannots' : '';
}

/**
 * Wire an `AbortSignal` to a queued job. Cancelling only drops work not yet started.
 *
 * @internal
 */
export function attachSignal(
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

/**
 * Turn `fitWidth`/`dpi` into a concrete DPI, and refuse absurd outputs.
 *
 * `fitWidth` exists because page sizes vary by two orders of magnitude in area: a
 * DPI that is sensible for US Letter produces a 113 MB bitmap for an ARCH-E drawing.
 *
 * @internal
 */
export function resolveDpi(
  backend: PagedBackend,
  index: number,
  options: RenderOptions,
): number {
  const { width, height } = backend.pageSize(index);
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

/** @internal `[start, end)` as an array. */
export function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

/** Bytes a cached page holds: exact for RGBA, the decoded size for a bitmap. */
function pageBytes(page: PageBitmap): number {
  return 'data' in page ? page.data.byteLength : page.width * page.height * 4;
}

/**
 * Opens documents with pages, and does everything to them.
 *
 * The queue, the caches and `fitWidth` live here, written once: an implementation
 * supplies {@link load} and {@link handle} and gets priority scheduling,
 * coalescing, a byte-bounded render cache and streaming for nothing. Constructing an
 * engine loads nothing — whatever it renders with is fetched by the first `open`.
 *
 * @typeParam D - The handle `open` returns.
 * @typeParam B - The backend `load` produces.
 */
export abstract class PagedEngine<
  D extends PagedDoc = PagedDoc,
  B extends PagedBackend = PagedBackend,
> {
  /** Stable name, for diagnostics and {@link PagedDoc.engine}. */
  abstract readonly id: string;

  /**
   * Whether this engine can run here. Synchronous and side-effect free — a guard
   * renders on it before anything is loaded.
   */
  abstract availability(): Availability;

  /**
   * Parse a document. Throws {@link PasswordRequiredError} or
   * {@link IncorrectPasswordError} for an encrypted one.
   */
  protected abstract load(source: PdfSource, options: OpenOptions): Promise<B>;

  /** Build the handle `open` returns for a freshly loaded backend. */
  protected abstract handle(backend: B): D;

  /**
   * Open a document. The handle is passed to this engine's other methods; see
   * {@link OpenOptions} for the queue and cache settings it is opened with.
   */
  async open(source: PdfSource, options: OpenOptions = {}): Promise<D> {
    const backend = await this.load(source, options);
    const limit = Math.max(
      1,
      options.concurrency ?? backend.concurrency ?? FALLBACK_CONCURRENCY,
    );
    const doc = this.handle(backend);
    const state: DocState<B> = {
      engine: this,
      backend,
      scheduler: new Scheduler(limit, { yieldToUrgent: options.yieldToUrgent }),
      limit,
      cache: new RenderCache<PageBitmap>(
        options.cacheBytes ?? DEFAULT_CACHE_BYTES,
        pageBytes,
      ),
      text: new RenderCache<PageText>(
        options.textCacheBytes ?? DEFAULT_TEXT_CACHE_BYTES,
        pageTextBytes,
      ),
      links: new RenderCache<readonly PageLink[]>(
        LINK_CACHE_BYTES,
        (links) => links.length * LINK_BYTES,
      ),
      linksPending: new Map(),
    };
    states.set(doc, state as DocState<never>);
    return doc;
  }

  /**
   * Release a document: its caches, and whatever its backend holds. The handle, and
   * any alias of it, is unusable afterwards. Work already running finishes.
   */
  close(doc: PagedDoc): void {
    const state = stateOf(this, doc);
    state.closed = true;
    states.delete(doc);
    state.cache.clear();
    state.text.clear();
    state.links.clear();
    state.backend.close?.();
  }

  /**
   * Render a page, returning a handle you can reprioritise or drop.
   *
   * This is the viewer path: as the user scrolls, promote what came into view and
   * demote what left, without re-submitting or duplicating work. Requests for the
   * same page at the same size coalesce into one render, taking the most urgent
   * priority asked for, and finished pages are served from a byte-bounded cache.
   */
  render(
    doc: PagedDoc,
    index: number,
    options: RenderOptions = {},
  ): RenderHandle<PageBitmap> {
    const { backend, cache, scheduler } = stateOf(this, doc);
    const dpi = resolveDpi(backend, index, options);
    const key = `${index}@${dpi.toFixed(4)}${annotationKey(options)}`;

    const hit = cache.get(key);
    if (hit) return cachedHandle(key, hit);

    const handle = scheduler.submit<PageBitmap>({
      key,
      priority: options.priority ?? DEFAULT_PRIORITY,
      run: () =>
        backend
          .renderPage(index, { dpi, annotations: options.annotations })
          .then((page) => {
            cache.set(key, page);
            return page;
          }),
    });

    attachSignal(handle, options.signal);
    return liveHandle(handle);
  }

  /**
   * Render pages as an async iterable, yielding each as soon as it finishes.
   *
   * At most `concurrency` renders are in flight, so memory stays bounded. Breaking
   * out of the loop stops scheduling further work and drops what is still queued.
   */
  async *stream(
    doc: PagedDoc,
    options: StreamOptions = {},
  ): AsyncGenerator<StreamedPage<PageBitmap>> {
    const state = stateOf(this, doc);
    const { limit } = state;
    const pages = options.order ?? range(0, doc.pageCount);
    const window = Math.max(
      1,
      options.concurrency ?? Math.min(limit, pages.length || 1),
    );

    type Completion = { slot: number; page: number; bitmap: PageBitmap };
    const inflight = new Map<number, Promise<Completion>>();
    const handles = new Map<number, JobHandle<PageBitmap>>();
    let next = 0;

    const schedule = (slot: number): void => {
      const page = pages[slot];
      if (page === undefined) return;
      const handle = this.render(doc, page, options);
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
        // Closing a document ends its streams: a viewer swapping files closes the old
        // one while a thumbnail strip may still be iterating it.
        if (next < pages.length && !state.closed) schedule(next++);
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

  /** Rendered pages held for reuse, and how often that has paid off. */
  cacheStats(doc: PagedDoc): CacheStats {
    return stateOf(this, doc).cache.stats;
  }
}

/**
 * Opens PDFs. Adds text, search and the document's own structure — outline, links,
 * labels, attachments, tags — to {@link PagedEngine}, each memoised or cached here
 * so an implementation only has to read them.
 *
 * @typeParam B - The backend `load` produces.
 */
export abstract class PdfEngine<
  B extends PdfBackend = PdfBackend,
> extends PagedEngine<PdfDoc, B> {
  protected handle(backend: B): PdfDoc {
    let metadata: DocumentMetadata | undefined;
    return {
      engine: this.id,
      pageCount: backend.pageCount,
      pageSize: (index) => backend.pageSize(index),
      capabilities: backend.capabilities,
      fingerprint: backend.fingerprint,
      get metadata() {
        metadata ??= backend.metadata();
        return metadata;
      },
      get pdfVersion() {
        return backend.pdfVersion();
      },
    };
  }

  /**
   * Extract the text of one page.
   *
   * Scheduled like a render, but behind one by default: a search should not stall the
   * page the user is looking at. Results are cached, so searching the same document
   * repeatedly extracts each page once. A page reads as empty on an engine without
   * {@link Capabilities.text}.
   */
  async pageText(
    doc: PdfDoc,
    index: number,
    options: { priority?: number; signal?: AbortSignal } = {},
  ): Promise<PageText> {
    const { backend, text, scheduler } = stateOf(this, doc);
    const key = textKey(index);
    const hit = text.get(key);
    if (hit) return hit;

    if (!backend.pageText) {
      return { page: index, lines: [], undecodedGlyphs: 0 };
    }
    const extract = backend.pageText.bind(backend);

    // One queue for renders and text both, so priority means something across them.
    // Coalescing by key is what stops a search and a text selection extracting the
    // same page twice.
    const handle = scheduler.submit<PageText>({
      key,
      priority: options.priority ?? DEFAULT_TEXT_PRIORITY,
      run: async () => {
        const page = await extract(index);
        text.set(key, page);
        return page;
      },
    });

    attachSignal(handle, options.signal);
    return handle.promise;
  }

  /**
   * Find `query` in the document, yielding matches as each page is searched.
   *
   * Streaming rather than collected, because the first hit is usually the one the
   * user wants. Breaking out of the loop stops the search. `order` is the lever a
   * viewer wants: searching outward from the current page finds the nearest hit first.
   */
  async *search(
    doc: PdfDoc,
    query: string,
    options: SearchOptions = {},
  ): AsyncGenerator<SearchMatch> {
    if (query.trim() === '') return;

    const pages = options.order ?? range(0, doc.pageCount);
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    let found = 0;

    for (const page of pages) {
      if (options.signal?.aborted) return;
      const text = await this.pageText(doc, page, {
        priority: options.priority ?? DEFAULT_TEXT_PRIORITY,
        signal: options.signal,
      });

      for (const match of searchPageText(text, query, options)) {
        yield match;
        if (++found >= limit) return;
      }
    }
  }

  /** The outline as a tree, memoised. Empty when there is none. */
  outline(doc: PdfDoc): Promise<OutlineNode[]> {
    const state = stateOf(this, doc);
    const read = state.backend.outline;
    if (!read) return Promise.resolve([]);
    state.outline ??= read.call(state.backend).catch((e: unknown) => {
      // A failed walk must not be cached as a permanent empty outline.
      state.outline = undefined;
      throw e;
    });
    return state.outline;
  }

  /** One label per page, memoised. Empty when the document defines none. */
  pageLabels(doc: PdfDoc): Promise<readonly string[]> {
    const state = stateOf(this, doc);
    const read = state.backend.pageLabels;
    if (!read) return Promise.resolve([]);
    state.labels ??= read.call(state.backend).catch((e: unknown) => {
      // A failed walk must not be cached as a permanent absence of labels.
      state.labels = undefined;
      throw e;
    });
    return state.labels;
  }

  /** The structure tree, memoised. Empty for an untagged document. */
  structTree(doc: PdfDoc): Promise<StructNode[]> {
    const state = stateOf(this, doc);
    const read = state.backend.structTree;
    if (!read) return Promise.resolve([]);
    state.structure ??= read.call(state.backend).catch((e: unknown) => {
      // A failed walk must not be cached as a permanent absence of structure.
      state.structure = undefined;
      throw e;
    });
    return state.structure;
  }

  /** The embedded files, metadata only, memoised. Empty when there are none. */
  attachments(doc: PdfDoc): Promise<readonly Attachment[]> {
    const state = stateOf(this, doc);
    const read = state.backend.attachments;
    if (!read) return Promise.resolve([]);
    state.attachments ??= read.call(state.backend).catch((e: unknown) => {
      // A failed walk must not be cached as a permanent absence of attachments.
      state.attachments = undefined;
      throw e;
    });
    return state.attachments;
  }

  /** One embedded file's bytes, by {@link Attachment.index}. Not cached. */
  attachmentData(doc: PdfDoc, index: number): Promise<Uint8Array> {
    const { backend } = stateOf(this, doc);
    if (!backend.attachmentData) {
      return Promise.reject(
        new RangeError(`papyra: ${this.id} reads no attachments`),
      );
    }
    return backend.attachmentData(index);
  }

  /**
   * The links on one page. Not queued — an object-graph read is roughly a
   * thousandth of a render, and waiting behind renders would add latency for
   * nothing. Cached, and two calls for one page share one read.
   */
  links(doc: PdfDoc, index: number): Promise<readonly PageLink[]> {
    const { backend, links, linksPending } = stateOf(this, doc);
    if (!backend.links) return Promise.resolve([]);

    const key = `links:${index}`;
    const hit = links.get(key);
    if (hit) return Promise.resolve(hit);

    const pending = linksPending.get(index);
    if (pending) return pending;

    const read = backend
      .links(index)
      .then((found) => {
        links.set(key, found);
        return found;
      })
      .finally(() => {
        linksPending.delete(index);
      });

    linksPending.set(index, read);
    return read;
  }

  /** Extracted page text held for reuse, and how often that has paid off. */
  textCacheStats(doc: PdfDoc): CacheStats {
    return stateOf(this, doc).text.stats;
  }
}

/**
 * Wrap a scheduler handle as a {@link RenderHandle}.
 *
 * Delegates rather than spreading: `timing` is a getter that is null until the job
 * settles, and a spread would freeze it at null forever.
 */
function liveHandle<P extends PageBitmap>(
  handle: JobHandle<P>,
): RenderHandle<P> {
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
function cachedHandle<P extends PageBitmap>(
  key: string,
  page: P,
): RenderHandle<P> {
  return {
    key,
    cached: true,
    promise: Promise.resolve(page),
    timing: { waitMs: 0, runMs: 0 },
    setPriority: () => {},
    cancel: () => {},
  };
}
