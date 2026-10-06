import { defineRenderer } from '@/lib/file-preview-core';

/**
 * CSV and TSV, read by papyra and shown as a grid.
 *
 * Text with no signature, so it matches by name or MIME type. Unlike `code` it does
 * not set `text`, whose test is "no NUL in the head": Excel's "Unicode Text" export
 * is UTF-16, where every other byte of ASCII is NUL, and papyra reads it. The
 * encoding and the delimiter are both sniffed, which is most of the work: a CSV
 * from Excel on Windows is windows-1252, and one from a decimal-comma locale is
 * split by semicolons.
 *
 * Shares papyra with the PDF and spreadsheet renderers, so it is heavy for a text
 * format — the price of the encoding detection, and of a grid that stays fast on a
 * million rows. Needs a cross-origin isolated page.
 */
export const csvRenderer = defineRenderer({
  id: 'csv',
  label: 'CSV',
  extensions: ['.csv', '.tsv', '.tab'],
  mimes: ['text/csv', 'text/tab-separated-values', 'application/csv'],
  load: () => import('./file-preview-csv-view').then((m) => m.CsvFileView),
});
