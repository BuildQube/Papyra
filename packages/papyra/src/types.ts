/** Anything we can turn into PDF bytes. `File` is a `Blob`, so it is covered. */
export type PdfSource = Uint8Array | ArrayBuffer | ArrayBufferView | Blob;

export interface RenderOptions {
  /** Dots per inch. 72 is the PDF's natural size. Defaults to 72. */
  dpi?: number;
}

export interface StreamOptions extends RenderOptions {
  /** How many renders to keep in flight. Defaults to the runtime's concurrency. */
  concurrency?: number;
  /**
   * Page indices to render, in priority order. Defaults to every page in order.
   * Results are yielded as they complete, not in this order.
   */
  order?: readonly number[];
  /** Abort in-flight and future work. */
  signal?: AbortSignal;
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
}
