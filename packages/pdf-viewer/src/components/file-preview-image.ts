import {
  defineRenderer,
  startsWith,
  startsWithAscii,
} from '@/lib/file-preview-core';

/** BITMAPINFOHEADER and its successors: the only DIB header sizes a BMP carries. */
const DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

/**
 * An SVG's root element, after whatever may legally precede it.
 *
 * Has to be found in the head rather than trusted from the name, because SVG is the
 * one image format that is text: a `.svg` that is really an HTML page would otherwise
 * be accepted by an `allow` list that only meant pictures.
 */
const SVG_ROOT =
  /^﻿?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i;

/** Recognise every format the renderer lists, by signature. */
export function sniffImage(head: Uint8Array): boolean {
  return (
    startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWith(head, [0xff, 0xd8, 0xff]) ||
    startsWithAscii(head, 'GIF87a') ||
    startsWithAscii(head, 'GIF89a') ||
    (startsWithAscii(head, 'RIFF') && startsWithAscii(head, 'WEBP', 8)) ||
    (startsWithAscii(head, 'ftyp', 4) &&
      (startsWithAscii(head, 'avif', 8) || startsWithAscii(head, 'avis', 8))) ||
    // "BM" alone is two printable letters, which plenty of text files begin with.
    (startsWithAscii(head, 'BM') && DIB_HEADER_SIZES.has(head[14] ?? 0)) ||
    // An icon directory: reserved zero, type 1, and at least one image.
    (startsWith(head, [0, 0, 1, 0]) && (head[4] ?? 0) + (head[5] ?? 0) > 0) ||
    SVG_ROOT.test(new TextDecoder().decode(head))
  );
}

/**
 * Raster images and SVG, drawn by the browser itself. No dependencies.
 *
 * SVG goes through `<img>`, never inline, and an SVG in an `<img>` runs no script and
 * loads nothing external — so a hostile one is a picture, not a page.
 */
export const imageRenderer = defineRenderer({
  id: 'image',
  label: 'Image',
  extensions: [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.avif',
    '.bmp',
    '.ico',
    '.svg',
  ],
  mimes: ['image/*'],
  sniff: sniffImage,
  load: () => import('./file-preview-image-view').then((m) => m.ImageFileView),
});
