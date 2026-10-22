import { loadTiff } from '@build-qube/papyra-native';
import { toBytes } from './source.js';
import { TiffImage, type TiffSource } from './tiff-image.js';
import type { PdfSource } from './types.js';

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
  // The addon's `RenderedPage` is papyra's, typed by napi as a looser object.
  return new TiffImage((await loadTiff(bytes)) as TiffSource);
}
