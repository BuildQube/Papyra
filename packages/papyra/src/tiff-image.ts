import type {
  TiffPageInfo,
  TiffRenderOptions as NativeTiffRenderOptions,
} from '@build-qube/papyra-native';
import type { PageBitmap, RenderedPage } from './types.js';

/**
 * How a TIFF page's pixels are stored.
 *
 * The three `ccitt-*` values are fax coding — `ccitt-g4` is what nearly every scanned
 * drawing uses. `old-jpeg` is listed so a page can say what it is, but cannot be
 * rendered.
 */
export type TiffCompression =
  | 'none'
  | 'ccitt-rle'
  | 'ccitt-g3'
  | 'ccitt-g4'
  | 'lzw'
  | 'old-jpeg'
  | 'jpeg'
  | 'deflate'
  | 'packbits'
  | 'other';

/** One page of a TIFF, as it is shown: the file's `Orientation` is already applied. */
export interface TiffPage {
  /** Width in pixels, at full resolution. */
  readonly width: number;
  /** Height in pixels, at full resolution. */
  readonly height: number;
  /**
   * Resolution in dots per inch, when the file states one. Fax pages are typically
   * 204 by 196, so the two can differ.
   */
  readonly dpi:
    | {
        /** Horizontal dots per inch. */
        readonly x: number;
        /** Vertical dots per inch. */
        readonly y: number;
      }
    | undefined;
  /** How the pixels are stored. */
  readonly compression: TiffCompression;
  /** Bits per sample: 1 for a bilevel scan, 8 for most others. */
  readonly bitsPerSample: number;
  /** Samples per pixel: 1 for grey, 3 for RGB, 4 with alpha or for CMYK. */
  readonly samplesPerPixel: number;
  /** TIFF `Orientation`, 1–8. 1 is upright; 6 and 8 are a quarter turn. */
  readonly orientation: number;
}

/**
 * Size limits for {@link TiffImage.renderPage}. The page keeps its aspect ratio and
 * is never enlarged.
 */
export interface TiffRenderOptions {
  /** The most pixels the result may have. Defaults to {@link TIFF_MAX_PIXELS}. */
  maxPixels?: number;
  /** The widest the result may be, in pixels. */
  maxWidth?: number;
}

/**
 * The default {@link TiffRenderOptions.maxPixels}: 4096 × 4096.
 *
 * It is iOS Safari's canvas limit, and 64 MB of RGBA. A 300-dpi E-size sheet comes out
 * at about 100 dpi under it — readable, with hairlines in grey.
 */
export const TIFF_MAX_PIXELS = 4096 * 4096;

/**
 * What a {@link TiffImage} reads: papyra's own addon, or another host holding the
 * file — a Tauri app's, through `@build-qube/papyra-tauri`.
 */
export interface TiffSource<P extends PageBitmap = RenderedPage> {
  /** Every page, in the addon's shape. */
  readonly pages: readonly TiffPageInfo[];
  /** Decode one page at no more than the given size. */
  renderPage(index: number, options?: NativeTiffRenderOptions): Promise<P>;
  /** Free the file where it is held. Absent where the garbage collector does. */
  close?(): Promise<void>;
}

/**
 * An opened TIFF. Get one from `openTiff`.
 *
 * `P` is what a page decodes to: RGBA from papyra's own addon, and an `ImageBitmap`
 * too from a host that sends pages as PNG.
 */
export class TiffImage<P extends PageBitmap = RenderedPage> {
  /**
   * Every page, in file order. A reduced-resolution copy of a page — a thumbnail, a
   * pyramid level — is not a page and is left out.
   */
  readonly pages: readonly TiffPage[];
  readonly #native: TiffSource<P>;

  /** @internal — construct via `openTiff`. */
  constructor(native: TiffSource<P>) {
    this.#native = native;
    this.pages = native.pages.map((p) => ({
      width: p.width,
      height: p.height,
      dpi: p.xDpi != null ? { x: p.xDpi, y: p.yDpi ?? p.xDpi } : undefined,
      compression: p.compression as TiffCompression,
      bitsPerSample: p.bitsPerSample,
      samplesPerPixel: p.samplesPerPixel,
      orientation: p.orientation,
    }));
  }

  /** How many pages there are. */
  get pageCount(): number {
    return this.pages.length;
  }

  /**
   * Decode one page to RGBA, upright, at no more than `options` allows.
   *
   * Paint the result with `paintToCanvas`, or encode it with `encode`, exactly as a
   * rendered PDF page. Each call decodes the page again; keep the result if it will
   * be shown again.
   */
  renderPage(
    index: number,
    options: TiffRenderOptions = {},
  ): Promise<P> {
    if (!Number.isInteger(index) || index < 0 || index >= this.pages.length) {
      return Promise.reject(
        new RangeError(`papyra: no TIFF page ${JSON.stringify(index)}`),
      );
    }
    return this.#native.renderPage(index, {
      maxPixels: options.maxPixels,
      maxWidth:
        options.maxWidth === undefined
          ? undefined
          : Math.max(1, Math.floor(options.maxWidth)),
    });
  }

  /**
   * Free the file. A no-op for papyra's own, which the garbage collector frees; a
   * host holding it — a Tauri app's — frees it now, and would otherwise keep it until
   * the page reloads.
   */
  async close(): Promise<void> {
    await this.#native.close?.();
  }
}
