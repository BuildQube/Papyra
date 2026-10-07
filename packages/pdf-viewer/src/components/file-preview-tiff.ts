import { defineRenderer, startsWith } from '@/lib/file-preview-core';

/** A TIFF header: `II*\0` or `MM\0*`, or BigTIFF's `II+\0` or `MM\0+`. */
export function sniffTiff(head: Uint8Array): boolean {
  return (
    startsWith(head, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(head, [0x4d, 0x4d, 0x00, 0x2a]) ||
    startsWith(head, [0x49, 0x49, 0x2b, 0x00]) ||
    startsWith(head, [0x4d, 0x4d, 0x00, 0x2b])
  );
}

/**
 * TIFF: scanned drawings and fax-era documents, one page or many.
 *
 * Its own renderer rather than part of `imageRenderer`, because no browser but
 * Safari draws a TIFF in an `<img>` — papyra decodes it, including the CCITT Group 4
 * compression nearly every scan uses, and reduces a sheet of hundreds of megapixels
 * to something a canvas holds while it decodes.
 *
 * As heavy as the PDF renderer, and for the same reason — papyra's wasm module — but
 * nothing is fetched until a TIFF is opened. Needs a cross-origin isolated page.
 */
export const tiffRenderer = defineRenderer({
  id: 'tiff',
  label: 'TIFF',
  extensions: ['.tif', '.tiff'],
  mimes: ['image/tiff', 'image/tiff-fx'],
  sniff: sniffTiff,
  load: () => import('./file-preview-tiff-view').then((m) => m.TiffFileView),
});
