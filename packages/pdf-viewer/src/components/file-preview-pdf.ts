import { defineRenderer, includesAscii } from '@/lib/file-preview-core';

/**
 * `%PDF-` anywhere in the head, not only at byte 0.
 *
 * The spec puts the header first, but Acrobat accepts it within the first kilobyte
 * and real files arrive with junk in front — a mail gateway's banner, a BOM.
 */
export function sniffPdf(head: Uint8Array): boolean {
  return includesAscii(head, '%PDF-');
}

/**
 * PDF, through papyra: the same one-page viewer as `pdf-viewer-basic`.
 *
 * The heaviest of the three by far — papyra's wasm module and the heap it reserves
 * on first load — and none of it is fetched until a PDF is actually opened. Needs a
 * cross-origin isolated page, as every papyra view does.
 */
export const pdfRenderer = defineRenderer({
  id: 'pdf',
  label: 'PDF',
  extensions: ['.pdf'],
  mimes: ['application/pdf'],
  sniff: sniffPdf,
  load: () => import('./file-preview-pdf-view').then((m) => m.PdfFileView),
});
