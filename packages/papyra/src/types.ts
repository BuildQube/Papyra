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
  /**
   * Draw the page's annotations — links, highlights, stamps, filled form fields.
   *
   * On by default, which is what a PDF viewer is expected to show. Turn it off when
   * you are drawing them yourself: a viewer that paints its own link or highlight
   * layer over the bitmap otherwise shows every annotation twice, once from the
   * document's appearance stream and once from its own.
   *
   * A boolean rather than pdf.js's four-way `annotationMode`, because that is the
   * whole of what the engine offers. The two modes this has no answer for —
   * `enableForms` and `enableStorage` — are about writing field values back, which
   * papyra does not do.
   *
   * Part of the cache key, so flipping it re-renders instead of returning the
   * previous answer.
   */
  annotations?: boolean;
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

/**
 * Options for {@link Document.renderSvg}. No `dpi` and no `fitWidth`: an SVG carries
 * the page's own point dimensions and rasterises at whatever size it is drawn.
 */
export interface SvgOptions {
  /** Scheduling order, exactly as in {@link RenderOptions.priority}. */
  priority?: number;
  /** Abort a request that has not started yet. */
  signal?: AbortSignal;
  /**
   * Defaults to `'white'`, matching how pages rasterise.
   *
   * Choose `'transparent'` when the SVG is going to be placed onto something else —
   * an opaque rectangle behind vector artwork is the one thing a consumer cannot
   * undo.
   */
  background?: 'white' | 'transparent';
  /**
   * Draw annotations, exactly as in {@link RenderOptions.annotations}. Defaults to on.
   *
   * Worth turning off more often here than for a raster page: an SVG is usually headed
   * somewhere that will lay its own interaction over the artwork, and a baked-in link
   * border is not removable afterwards.
   */
  annotations?: boolean;
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

/**
 * The document information dictionary — what the file says about itself.
 *
 * Every field is independently optional, and a field the document left blank reads as
 * `null` rather than an empty string. None of it is verified: a producer writes what
 * it likes, and `title` in particular is frequently a filename or absent entirely, so
 * a viewer showing a document name should fall back to its own.
 */
export interface DocumentMetadata {
  /** The document's own title, which is frequently a filename or absent. */
  readonly title: string | null;
  /** Who the document claims to be by. */
  readonly author: string | null;
  /** A one-line description. Rare outside of published documents. */
  readonly subject: string | null;
  /** Free text, and not reliably a delimited list — producers use commas or spaces. */
  readonly keywords: string | null;
  /** The application the document was authored in, e.g. `AutoCAD`. */
  readonly creator: string | null;
  /** The application that wrote the PDF, e.g. `Ghostscript`. */
  readonly producer: string | null;
  /**
   * When the document was created, as an ISO 8601 string — `new Date(created)` parses
   * it directly.
   *
   * A PDF date may be as short as a year, in which case the missing components read
   * as January 1st. It is also self-reported, and clocks lie.
   */
  readonly created: string | null;
  /** When the document was last modified, ISO 8601. */
  readonly modified: string | null;
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
