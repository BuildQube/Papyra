import type { MatchOptions } from './search.js';

/** Anything we can turn into PDF bytes. `File` is a `Blob`, so it is covered. */
export type PdfSource = Uint8Array | ArrayBuffer | ArrayBufferView | Blob;

/** How to size a render, and where it sits in the queue. */
export interface RenderOptions {
  /**
   * Scheduling order. **Lower runs first**; the default, 0, is the most urgent tier.
   *
   * papyra does not infer urgency — a viewer knows what is on screen and the library
   * does not. Attach whatever scale suits you, e.g. 0 for the visible page, 1 for its
   * neighbours, 2 for thumbnails in view, 3 for prefetch.
   *
   * Pending work reorders freely; work already running is never interrupted.
   */
  priority?: number;
  /** Abort a request that has not started yet. */
  signal?: AbortSignal;
  /** Dots per inch. 72 is the PDF's natural size. Defaults to 72. */
  dpi?: number;
  /**
   * Target output width in pixels. Overrides `dpi`.
   *
   * Prefer this for thumbnails and for fitting a viewport. A fixed DPI silently
   * explodes on large-format pages: 36 DPI is a 216x279 thumbnail for US Letter but
   * a 1512x1080, 6.5 MB image for a 42x30in drawing. Sizing by output width keeps
   * cost proportional to what is actually displayed.
   */
  fitWidth?: number;
}

/** {@link RenderOptions}, plus the two dials that only apply to a stream. */
export interface StreamOptions extends RenderOptions {
  /**
   * How far ahead of consumption to queue. Defaults to the runtime's concurrency.
   *
   * This is backpressure, not a concurrency limit — the document-wide scheduler owns
   * that, so a high-priority page still preempts a stream that is mid-flight.
   */
  concurrency?: number;
  /**
   * Page indices to render, in priority order. Defaults to every page in order.
   * Results are yielded as they complete, not in this order.
   */
  order?: readonly number[];
}

/** A rendered page. `data` is tightly packed RGBA8, `height * stride` bytes. */
export interface RenderedPage {
  /** Output width in pixels, after `dpi` or `fitWidth` was applied. */
  readonly width: number;
  /** Output height in pixels. */
  readonly height: number;
  /**
   * Bytes per row. Always `width * 4` today, since the buffer is tightly packed —
   * read it rather than recomputing it, so a future padded layout does not silently
   * skew every row.
   */
  readonly stride: number;
  /** Always `'rgba8'`. Present so a second pixel layout could be added without a cast. */
  readonly format: 'rgba8';
  /**
   * The pixels, non-premultiplied RGBA.
   *
   * On wasm this view is backed by the module's shared linear memory, which is why
   * {@link toImageData} and `Blob` construction copy rather than borrow.
   */
  readonly data: Uint8Array;
}

/** One result from {@link Document.stream}, tagged with the page it came from. */
export interface StreamedPage {
  /** Index of the page in the document. */
  readonly page: number;
  /** The rendered pixels. */
  readonly bitmap: RenderedPage;
}

/** Page dimensions in PDF points (1/72 inch). */
export interface PageSize {
  /** Width in points, with rotation and the crop box already applied. */
  readonly width: number;
  /** Height in points, with rotation and the crop box already applied. */
  readonly height: number;
}

/** Everything fixed for the lifetime of a {@link Document}: its queue and its caches. */
export interface OpenOptions {
  /** Password for an encrypted document. */
  password?: string;
  /**
   * How many pages may render at once. Defaults to the runtime's concurrency.
   *
   * This is a responsiveness/throughput dial. Priority can only reorder work that has
   * not started, so a wide pool renders a batch faster but makes an urgent page wait
   * behind more in-flight work. Viewers usually want it narrow (2-4); batch jobs want
   * it wide.
   */
  concurrency?: number;
  /**
   * Hold back lower-priority renders while something more urgent is still running.
   *
   * Defaults to on, and is a no-op when every request shares a priority. Turn it off
   * to maximise throughput at the cost of making urgent work wait.
   */
  yieldToUrgent?: boolean;
  /**
   * Bytes of rendered pages to keep for reuse. Defaults to 128 MB; `0` disables it.
   *
   * A render is never cheap — on a large CAD drawing every page costs >=93ms however
   * small the output — and viewers re-render the same page constantly. Bounded by bytes
   * rather than entries because page bitmaps span three orders of magnitude.
   *
   * Only the single-page path is cached (`render`, `renderPage`, `stream`).
   * `renderPages` is a throughput API and would evict everything useful in one call.
   */
  cacheBytes?: number;
  /**
   * Bytes of extracted page text to keep. Defaults to 32 MB; `0` disables it.
   *
   * Text is three orders of magnitude smaller than the same page's pixels — a dense
   * page of a paper is ~80 KB against ~11 MB — so the default holds hundreds of pages
   * and a repeated search never re-extracts one.
   */
  textCacheBytes?: number;
}

/** Options for {@link Document.search}. */
export interface SearchOptions extends MatchOptions {
  /**
   * Pages to search, in order. Defaults to every page from the first.
   *
   * A viewer wants to search outward from the page on screen: the nearest hit is
   * almost never on page 1, and the first result is usually the one being looked for.
   */
  order?: readonly number[];
  /** Stop after this many matches. */
  limit?: number;
  /** Where text extraction sits in the render queue. Defaults to behind rendering. */
  priority?: number;
  /** Abort the search. Pages already being extracted are left to finish. */
  signal?: AbortSignal;
}
