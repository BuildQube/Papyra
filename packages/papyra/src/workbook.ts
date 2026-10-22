import { loadWorkbook } from '@build-qube/papyra-native';
import {
  openWorkbookWith,
  type Workbook,
  type WorkbookOptions,
} from './sheets.js';
import type { PdfSource } from './types.js';

/**
 * Open a spreadsheet: Excel (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`), OpenDocument
 * (`.ods`), or delimited text (`.csv`, `.tsv`).
 *
 * Parsing happens in Rust and off the JS thread, and only sheet names are read up
 * front: a sheet's cells are read the first time `Workbook.sheet` asks for it.
 *
 * @example
 * ```ts
 * const book = await openWorkbook(file);
 * const sheet = await book.sheet(0);
 * const cells = sheet.window({ rowStart: 0, rowEnd: 50 });
 * cells.text(0, 0); // 'Item'
 * ```
 *
 * @throws `EncryptedWorkbookError` when the workbook is password-protected.
 */
export function openWorkbook(
  source: PdfSource,
  options: WorkbookOptions = {},
): Promise<Workbook> {
  return openWorkbookWith(loadWorkbook, source, options);
}
