import {
  loadTiff,
  type TiffImage as NativeTiffImage,
} from '@build-qube/papyra-native';
import { toBytes } from './source.js';
import type { PdfSource, RenderedPage } from './types.js';

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
 * Open a TIFF: single or multi-page, classic or BigTIFF.
 *
 * Reads fax-coded pages (CCITT Group 3 and Group 4, the usual case for a scanned
 * drawing), and uncompressed, LZW, Deflate, PackBits and JPEG pages in grey, RGB or
 * CMYK at 1 to 16 bits, in strips or tiles. Palette-colour and old-style JPEG pages
 * are listed but fail to render.
 *
 * Only the directory is read here. Each page is decoded by
 * {@link TiffImage.renderPage}, in Rust and off the JS thread, and straight to a
 * reduced size — a page is never held at full resolution, so a 600-dpi colour scan of
 * a sheet larger than the tab could allocate still opens.
 *
 * @example
 * ```ts
 * const tiff = await openTiff(file);
 * const page = await tiff.renderPage(0, { maxWidth: 1600 });
 * paintToCanvas(page, canvas);
 * ```
 */
export async function openTiff(source: PdfSource): Promise<TiffImage> {
  const bytes = await toBytes(source);
  return new TiffImage(await loadTiff(bytes));
}

/** An opened TIFF. Get one from {@link openTiff}. */
export class TiffImage {
  /**
   * Every page, in file order. A reduced-resolution copy of a page — a thumbnail, a
   * pyramid level — is not a page and is left out.
   */
  readonly pages: readonly TiffPage[];
  readonly #native: NativeTiffImage;

  /** @internal — construct via {@link openTiff}. */
  constructor(native: NativeTiffImage) {
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
  ): Promise<RenderedPage> {
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
    }) as Promise<RenderedPage>;
  }
}
