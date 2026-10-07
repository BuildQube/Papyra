import { defineRenderer } from '@/lib/file-preview-core';

/**
 * Excel and OpenDocument spreadsheets, read by papyra and shown as a grid.
 *
 * Matched by name rather than bytes, deliberately. An `.xls` is an OLE compound file,
 * the same container as a `.doc` or an `.msg`, and an `.xlsx` is a zip like a `.docx`;
 * nothing in the first 512 bytes tells them apart. Claiming those signatures would
 * take every Word document too. A file that has the name and turns out to be
 * something else costs nothing, either: papyra sniffs the bytes again, so a `.xls`
 * that is really a CSV export still shows, and anything it cannot read goes to the
 * preview's error state.
 *
 * As heavy as the PDF renderer, and for the same reason — papyra's wasm module —
 * but nothing is fetched until a spreadsheet is opened. Needs a cross-origin isolated
 * page.
 */
export const spreadsheetRenderer = defineRenderer({
  id: 'spreadsheet',
  label: 'Spreadsheet',
  extensions: [
    '.xlsx',
    '.xlsm',
    '.xltx',
    '.xltm',
    '.xlsb',
    '.xls',
    '.xlt',
    '.ods',
    '.ots',
  ],
  mimes: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
    'application/vnd.ms-excel',
    'application/vnd.ms-excel.sheet.macroenabled.12',
    'application/vnd.ms-excel.sheet.binary.macroenabled.12',
    'application/vnd.oasis.opendocument.spreadsheet',
  ],
  load: () =>
    import('./file-preview-spreadsheet-view').then(
      (m) => m.SpreadsheetFileView,
    ),
});
