import {
  type PageBitmap,
  type PdfSource,
  TiffImage,
  type TiffSource,
  toBytes,
} from '@build-qube/papyra/core';
import { invoke } from '@tauri-apps/api/core';
import type { TauriEngineOptions } from './engine.js';
import {
  closeDocument,
  command,
  fetchPage,
  pagesOf,
  type TauriPageFormat,
} from './host.js';

/** The widest page the protocol's `maxWidth` can name. */
const MAX_U32 = 0xffff_ffff;

/** The plugin's answer to `open_tiff`. */
interface Opened {
  id: number;
  pages: TiffSource['pages'];
}

/**
 * papyra's `openTiff`, read and decoded in the Tauri app's host process through
 * `tauri-plugin-papyra` with its `tiff` feature, and allowed by `papyra:tiff`.
 *
 * Resolves to papyra's own `TiffImage`, so `tiffRenderer.with({ open: openTiff })`
 * shows it unchanged. Pages come over the `papyra://` protocol as a PDF's do, in
 * the same `format` — PNG by default, which for a bilevel fax page is a fraction of
 * its RGBA — so `renderPage` resolves to an `ImageBitmap` unless `format` is
 * `'rgba'`. The file stays in the host until `close()`.
 */
export async function openTiff(
  source: PdfSource,
  options: TauriEngineOptions = {},
): Promise<TiffImage<PageBitmap>> {
  const format: TauriPageFormat = options.format ?? 'png';
  const opened = await invoke<Opened>(
    command('open_tiff'),
    await toBytes(source),
  );
  const pages = pagesOf(opened.id);
  return new TiffImage({
    pages: opened.pages,
    renderPage(index, { maxPixels, maxWidth } = {}) {
      // The host reads both as integers, so refuse here what it would answer with
      // a bare 400: `1e+21` is not one, and a cap below one pixel is no page.
      if (maxWidth !== undefined && !(maxWidth >= 1 && maxWidth <= MAX_U32)) {
        return Promise.reject(
          new RangeError(
            `papyra: maxWidth ${maxWidth} is not a width in pixels`,
          ),
        );
      }
      if (maxPixels !== undefined && !(maxPixels >= 1)) {
        return Promise.reject(
          new RangeError(`papyra: maxPixels ${maxPixels} is under one pixel`),
        );
      }
      const query = new URLSearchParams();
      if (maxWidth !== undefined) query.set('maxWidth', String(maxWidth));
      if (maxPixels !== undefined) {
        // Clamped as the host would, so a huge value is not written as `1e+21`.
        query.set('maxPixels', String(Math.floor(Math.min(maxPixels, 1e8))));
      }
      return fetchPage(`${pages}${index}?${query}`, format);
    },
    close: () => closeDocument(opened.id),
  });
}
