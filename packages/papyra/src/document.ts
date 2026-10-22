import type { PageImage as NativePageImage } from '@build-qube/papyra-native';
import type { Attachment } from './attachments.js';
import type { CacheStats } from './cache.js';
import { PageImage, type SvgPage, svgPage } from './encode.js';
import {
  adopt,
  annotationKey,
  attachSignal,
  type Capabilities,
  type DocState,
  type PdfDoc,
  range,
  resolveDpi,
  stateOf,
  textKey,
} from './engine.js';
import type { PageLink } from './links.js';
import type { OutlineNode } from './outline.js';
import {
  defaultPdfEngine,
  type PapyraBackend,
  type PapyraEngine,
} from './papyra-engine.js';
import { currentRuntime } from './runtime.js';
import { DEFAULT_PRIORITY, type JobHandle } from './scheduler.js';
import type { SearchMatch } from './search.js';
import type { StructNode } from './structure.js';
import { type PageText, toPageText } from './text.js';
import type {
  DocumentMetadata,
  OpenOptions,
  PageSize,
  PdfSource,
  RenderedPage,
  RenderHandle,
  RenderOptions,
  SearchOptions,
  StreamedPage,
  StreamOptions,
  SvgOptions,
} from './types.js';

const DEFAULT_DPI = 72;

/**
 * A queued export render. No `cached` flag: unlike {@link RenderHandle} the image path
 * never comes from the cache, which is keyed by page and size with no format dimension.
 */
export type ImageHandle = JobHandle<PageImage>;

/**
 * A queued SVG conversion. Uncached for the same reason as {@link ImageHandle}, and
 * unsized: an SVG has no DPI to key on.
 */
export type SvgHandle = JobHandle<SvgPage>;

/**
 * Open a PDF from bytes, an `ArrayBuffer`, a `Blob`, or a `File`.
 *
 * Throws {@link PasswordRequiredError} when the document is encrypted and no
 * {@link OpenOptions.password} was given, and {@link IncorrectPasswordError} when one
 * was given and rejected. Both extend {@link PasswordError}, so a viewer that shows
 * one dialog for both can catch the base.
 */
export async function open(
  source: PdfSource,
  options: OpenOptions = {},
): Promise<Document> {
  return defaultPdfEngine.open(source, options);
}

/**
 * An open PDF, and the queue and caches that serve it.
 *
 * Every page-level call goes through one shared scheduler, so a thumbnail sweep can
 * never starve the page on screen — attach a {@link RenderOptions.priority} and the
 * queue reorders around it. Construct via {@link open}, not `new`.
 *
 * A {@link PdfDoc} in its own right: a viewer written against engines can be handed
 * one of these and will reach it through papyra's engine.
 */
export class Document implements PdfDoc {
  readonly #doc: PdfDoc;
  readonly #engine: PapyraEngine;
  /** Memoised by {@link indexText}. */
  #indexed: Promise<void> | undefined;

  /**
   * A stable identifier for this document's bytes.
   *
   * Sixteen hex characters, for keying whatever you remember per document — the page
   * it was left on, a zoom level, a set of highlights. Two `open` calls on the same
   * file always agree.
   *
   * It is a hash of the file, **not** the PDF's own `/ID`: the engine exposes no
   * trailer accessor, so that identifier is out of reach. The practical difference is
   * that saving an incremental update changes this while `/ID` would have survived.
   */
  readonly fingerprint: string;

  /** @internal — construct via {@link open}. */
  constructor(doc: PdfDoc, engine: PapyraEngine) {
    this.#doc = doc;
    this.#engine = engine;
    this.fingerprint = doc.fingerprint;
    adopt(this, doc);
  }

  /**
   * Looked up on every use, never held: `stateOf` is what throws once the document
   * is closed, including between the awaits of a call that was already running.
   */
  get #state(): DocState<PapyraBackend> {
    return stateOf(this.#engine, this.#doc) as DocState<PapyraBackend>;
  }

  /** The engine that opened this document: always papyra's own. */
  get engine(): string {
    return this.#doc.engine;
  }

  /** Everything: papyra's engine implements every optional capability. */
  get capabilities(): Capabilities {
    return this.#doc.capabilities;
  }

  /** Rendered pages held for reuse, and how often that has paid off. */
  get cache(): CacheStats {
    return this.#state.cache.stats;
  }

  /** Drop every cached page. */
  clearCache(): void {
    this.#state.cache.clear();
  }

  /**
   * Release this document: its caches, and its queue's claim on the engine. Every
   * method and getter that reaches the queue or a cache throws afterwards, the stats
   * and a second `close` included; what the handle was opened with — `pageCount`,
   * `fingerprint`, `engine`, `capabilities` — stays readable. Work already running
   * finishes, but nothing it produces is cached. Optional — an unreachable document
   * is collected — but it frees the caches at once rather than whenever the
   * collector gets to them.
   */
  close(): Promise<void> {
    return this.#engine.close(this.#doc);
  }

  /** Pages queued but not yet started, pages rendering, and the longest wait so far. */
  get queued(): {
    /** Submitted but not started. These are the ones priority can still reorder. */
    pending: number;
    /** Rendering now. Never preempted, so this is work you are committed to. */
    running: number;
    /**
     * How long the longest-waiting pending job has sat there.
     *
     * The number to watch in a viewer: if it climbs, the pool is too wide for the
     * work or a priority is wrong.
     */
    oldestWaitMs: number;
  } {
    return {
      pending: this.#state.scheduler.pendingCount,
      running: this.#state.scheduler.runningCount,
      oldestWaitMs: this.#state.scheduler.oldestWaitMs,
    };
  }

  /** How many pages the document has. Page indices are 0-based throughout. */
  get pageCount(): number {
    return this.#doc.pageCount;
  }

  /**
   * The PDF specification version the file declares, e.g. `'1.7'`.
   *
   * Deliberately not part of {@link Document.metadata}: that is what the producer
   * chose to say about the document, while this is a structural property read from
   * the file's header — and from the catalog, which overrides it for 1.4 and later,
   * so an incrementally saved file reports the version it was last written as.
   *
   * `'1.0'` is worth treating with suspicion. Genuine PDF 1.0 files are close to
   * extinct, and it is also what a file with an unreadable header reports.
   */
  get pdfVersion(): string | null {
    return this.#doc.pdfVersion;
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
    return this.#engine.outline(this.#doc);
  }

  /**
   * What the document says about itself: title, author, dates, the tool that wrote it.
   *
   * Synchronous — the engine reads the information dictionary while loading, so this
   * only decodes strings. Every field is independently `null`, and none of it is
   * verified; `title` in particular is often a filename or missing entirely.
   */
  get metadata(): DocumentMetadata {
    return this.#doc.metadata;
  }

  /**
   * The label printed on each page, one entry per page.
   *
   * Resolves to an **empty array** when the document defines no page labels, which is
   * the common case — that is the signal to number pages by index yourself. A
   * document that defines labels but says nothing about a particular page gives that
   * page an empty string, which is a different answer.
   *
   * Worth honouring wherever a page number is shown: a document with front matter
   * numbers its first pages i, ii, iii, and a viewer that says "page 4 of 300" when
   * the sheet reads "A101" is describing a document nobody else can see.
   *
   * The walk runs off the event loop and the result is memoised.
   *
   * @example
   * ```ts
   * const labels = await doc.pageLabels();
   * const shown = labels[index] || String(index + 1);
   * ```
   */
  async pageLabels(): Promise<readonly string[]> {
    return this.#engine.pageLabels(this.#doc);
  }

  /**
   * The document structure tree, if the document is tagged.
   *
   * Resolves to an **empty array** for an untagged document, which is the common
   * case — most PDFs carry no `/StructTreeRoot` at all. That emptiness is the signal
   * to fall back to {@link Document.pageText} on its own.
   *
   * What it buys, when it is there, is the thing extraction otherwise cannot get:
   * the reading order the author declared. {@link Document.pageText} reports lines in
   * content-stream order, and a two-column page is free to draw its columns
   * interleaved. Pass both to {@link readingOrder} to resolve it.
   *
   * The walk runs off the event loop and the result is memoised — it is one walk for
   * the whole document, not one per page.
   *
   * @example
   * ```ts
   * const [text, tree] = await Promise.all([
   *   doc.pageText(0),
   *   doc.structTree(),
   * ]);
   * for (const { line, node } of readingOrder(text, tree)) {
   *   console.log(node?.role ?? '-', line.text);
   * }
   * ```
   */
  async structTree(): Promise<StructNode[]> {
    return this.#engine.structTree(this.#doc);
  }

  /**
   * The files embedded in the document, in the order it files them.
   *
   * Resolves to an **empty array** when there are none, which is the common case.
   * Metadata only — {@link Document.attachmentData} fetches the bytes, so listing a
   * document's attachments never decompresses one.
   *
   * Worth honouring even in a viewer that has no use for the files themselves: a
   * ZUGFeRD or Factur-X invoice keeps its machine-readable half here, and a reader
   * that never mentions it leaves the user retyping data the document is carrying.
   * See {@link isInvoiceAttachment}.
   *
   * The walk runs off the event loop and the result is memoised.
   *
   * @example
   * ```ts
   * for (const file of await doc.attachments()) {
   *   const bytes = await doc.attachmentData(file.index);
   *   await write(file.name, bytes);
   * }
   * ```
   */
  async attachments(): Promise<readonly Attachment[]> {
    return this.#engine.attachments(this.#doc);
  }

  /**
   * Decompress one embedded file, by its {@link Attachment.index}.
   *
   * Not cached: the bytes are the caller's to keep or drop, and holding every
   * attachment a document was ever asked for is the cost {@link Document.attachments}
   * is shaped to avoid. Rejects if the index names no attachment, or if the stream
   * cannot be decoded.
   */
  async attachmentData(index: number): Promise<Uint8Array> {
    return this.#engine.attachmentData(this.#doc, index);
  }

  /**
   * The links on one page — where they are, and where they go.
   *
   * Rectangles are in the same 72-DPI top-left space as {@link Document.pageText} and
   * {@link Document.pageSize}, so placing them over a render is one multiply; see
   * {@link scaleRect}. Only links that resolve to something actionable are reported.
   *
   * Unlike text extraction this never interprets a content stream — it is an
   * object-graph read, roughly a thousandth the cost of rendering the page — so it
   * does **not** go through the priority queue. Making a link layer wait behind
   * renders would add latency a viewer can feel, for work that costs nothing.
   * Results are cached, and two calls for the same page share one read.
   *
   * @example
   * ```ts
   * const scale = rendered.width / doc.pageSize(index).width;
   * for (const link of await doc.links(index)) {
   *   const { x, y, width, height } = scaleRect(link.rect, scale);
   *   // ...position an anchor over the canvas
   * }
   * ```
   */
  async links(index: number): Promise<readonly PageLink[]> {
    return this.#engine.links(this.#doc, index);
  }

  /** Page dimensions in PDF points (1/72 inch). */
  pageSize(index: number): PageSize {
    return this.#state.backend.pageSize(index);
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
    const dpi = resolveDpi(this.#state.backend, index, options);

    // A distinct key space from `render`, so an image request never coalesces onto a
    // pending raw render (different return type) or vice versa.
    const handle = this.#state.scheduler.submit({
      key: `image:${index}@${dpi.toFixed(4)}${annotationKey(options)}`,
      priority: options.priority ?? DEFAULT_PRIORITY,
      run: () =>
        (
          this.#state.backend.native.renderPageImageAsync(
            index,
            dpi,
            options.annotations,
            options.signal,
          ) as Promise<NativePageImage>
        ).then((img) => new PageImage(img)),
    });

    attachSignal(handle, options.signal);
    return handle;
  }

  /**
   * Convert a page to SVG — vector output, not pixels.
   *
   * Paths stay paths and text stays glyph outlines, so the result scales to any size
   * and can be edited downstream. That is the trade: an SVG of a dense drawing is
   * larger than a WebP of the same page at screen size and slower for a browser to
   * paint, but it is the only output that survives being scaled up.
   *
   * Conversion is content-stream interpretation without rasterisation — roughly the
   * non-preemptible portion of a render — so it shares the scheduler with everything
   * else and honours {@link SvgOptions.priority}. **Not cached**, for the same reason
   * {@link renderImage} is not.
   *
   * @example
   * ```ts
   * const page = await doc.renderSvg(0, { background: 'transparent' });
   * await writeFile('page-0.svg', page.markup);
   * ```
   */
  async renderSvg(index: number, options: SvgOptions = {}): Promise<SvgPage> {
    return this.svgHandle(index, options).promise;
  }

  /**
   * As {@link renderSvg}, but returns the handle so the job can be reprioritised,
   * cancelled, or timed — the same relationship `imageHandle` has to `renderImage`.
   */
  svgHandle(index: number, options: SvgOptions = {}): SvgHandle {
    if (index < 0 || index >= this.pageCount) {
      throw new RangeError(
        `papyra: page ${index} is out of range (0..${this.pageCount - 1})`,
      );
    }

    const opaque = options.background !== 'transparent';

    const handle = this.#state.scheduler.submit<SvgPage>({
      // The background is part of the key: the scheduler coalesces same-key requests,
      // and an opaque and a transparent conversion of one page are different output.
      key: `svg:${index}${opaque ? '' : ':transparent'}${annotationKey(options)}`,
      priority: options.priority ?? DEFAULT_PRIORITY,
      run: () =>
        (
          this.#state.backend.native.renderPageSvgAsync(
            index,
            opaque,
            options.annotations,
            options.signal,
          ) as Promise<string>
        ).then(svgPage),
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
    // papyra's backend only ever produces RGBA, so the wider engine type narrows.
    return this.#engine.render(this.#doc, index, options) as RenderHandle;
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
      for (let i = start; i < end; i++)
        dpi = resolveDpi(this.#state.backend, i, options);
      return (await this.#state.backend.native.renderPagesAsync(
        start,
        end,
        dpi,
        options.annotations,
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
  stream(options: StreamOptions = {}): AsyncGenerator<StreamedPage> {
    // As for `render`: the bitmaps are RGBA.
    return this.#engine.stream(
      this.#doc,
      options,
    ) as AsyncGenerator<StreamedPage>;
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
    return this.#engine.pageText(this.#doc, index, options);
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
    // The memo would otherwise answer a closed document without reaching the guard.
    void this.#state;
    this.#indexed ??= this.#index(options).catch((e: unknown) => {
      // A failed pass must not be remembered as a completed one.
      this.#indexed = undefined;
      throw e;
    });
    return this.#indexed;
  }

  async #index(options: { priority?: number }): Promise<void> {
    if (currentRuntime() === 'native') {
      const all = await this.#state.backend.native.pageTextsAsync(
        0,
        this.pageCount,
      );
      for (const [i, native] of all.entries()) {
        this.#state.text.set(textKey(i), toPageText(i, native));
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
  search(
    query: string,
    options: SearchOptions = {},
  ): AsyncGenerator<SearchMatch> {
    return this.#engine.search(this.#doc, query, options);
  }

  /** Extracted page text held for reuse, and how often that has paid off. */
  get textCache(): CacheStats {
    return this.#state.text.stats;
  }

  /** How many pages this document will render at once. */
  get concurrency(): number {
    return this.#state.limit;
  }
}
