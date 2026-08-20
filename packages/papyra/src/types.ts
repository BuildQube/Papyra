/** Anything we can turn into PDF bytes. `File` is a `Blob`, so it is covered. */
export type PdfSource = Uint8Array | ArrayBuffer | ArrayBufferView | Blob;

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
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly format: 'rgba8';
  readonly data: Uint8Array;
}

export interface StreamedPage {
  /** Index of the page in the document. */
  readonly page: number;
  readonly bitmap: RenderedPage;
}

/** Page dimensions in PDF points (1/72 inch). */
export interface PageSize {
  readonly width: number;
  readonly height: number;
}

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
}
