import {
  loadWorkbook,
  type Sheet as NativeSheet,
  type Workbook as NativeWorkbook,
} from '@build-qube/papyra-native';
import { CellWindow, type MergedRange, toMergedRanges } from './cells.js';
import { rethrowLoadError } from './errors.js';
import { toBytes } from './source.js';
import type { PdfSource } from './types.js';

/**
 * The container a workbook was read from.
 *
 * Macro-enabled and template variants read as their base format: an `.xlsm` is
 * `'xlsx'` here, because to a reader that is what it is.
 */
export type WorkbookFormat = 'xlsx' | 'xlsb' | 'xls' | 'ods' | 'csv' | 'tsv';

/** How to read a workbook. Everything is sniffed when left out. */
export interface WorkbookOptions {
  /**
   * Skip sniffing. Only needed to read a file as TSV that was not named `.tsv` —
   * the binary formats identify themselves, and text is sniffed for its delimiter.
   * `'xlsm'` is accepted and reads as `'xlsx'`.
   */
  format?: WorkbookFormat | 'xlsm';
  /** CSV and TSV only: the delimiter, a single ASCII character such as `';'`. */
  delimiter?: string;
  /**
   * CSV and TSV only: a WHATWG encoding label, e.g. `'windows-1252'` or
   * `'shift_jis'`. Without one, a byte-order mark decides, then valid UTF-8, then a
   * statistical guess.
   */
  encoding?: string;
}

/** Whether a sheet shows in the application's tab bar. */
export type SheetVisibility = 'visible' | 'hidden' | 'veryHidden';

/** What a sheet holds. Only worksheets have cells worth showing. */
export type SheetKind = 'worksheet' | 'chartsheet' | 'dialog' | 'macro' | 'vba';

/** A sheet's entry in the workbook, known without reading its cells. */
export interface SheetInfo {
  /** The name on the sheet's tab. CSV and TSV have one sheet, named `Sheet1`. */
  name: string;
  /** What the sheet holds. */
  kind: SheetKind;
  /**
   * `'hidden'` sheets can be unhidden by the user; `'veryHidden'` ones only by a
   * macro. A viewer usually lists the first and omits the second.
   */
  visibility: SheetVisibility;
}

/** Rows and columns to read, half-open like `Array.prototype.slice`. */
export interface WindowRange {
  /** First row, 0-based. */
  rowStart: number;
  /** One past the last row. Clamped to the sheet. */
  rowEnd: number;
  /** First column. Defaults to 0. */
  colStart?: number;
  /** One past the last column. Defaults to every column. */
  colEnd?: number;
}

/**
 * Open a spreadsheet: Excel (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`), OpenDocument
 * (`.ods`), or delimited text (`.csv`, `.tsv`).
 *
 * Parsing happens in Rust and off the JS thread, and only sheet names are read up
 * front: a sheet's cells are read the first time {@link Workbook.sheet} asks for it.
 *
 * @example
 * ```ts
 * const book = await openWorkbook(file);
 * const sheet = await book.sheet(0);
 * const cells = sheet.window({ rowStart: 0, rowEnd: 50 });
 * cells.text(0, 0); // 'Item'
 * ```
 *
 * @throws {@link EncryptedWorkbookError} when the workbook is password-protected.
 */
export async function openWorkbook(
  source: PdfSource,
  options: WorkbookOptions = {},
): Promise<Workbook> {
  const bytes = await toBytes(source);
  const format = options.format ?? formatFromName(source);
  try {
    const native = await loadWorkbook(bytes, { ...options, format });
    return new Workbook(native);
  } catch (error) {
    rethrowLoadError(error);
  }
}

/**
 * A `File` named `.tsv` is TSV whatever its contents sniff as.
 *
 * Only that one extension is trusted. The binary formats announce themselves in
 * their first bytes, and a `.xls` downloaded from a web app is as often an HTML
 * table or a CSV as it is BIFF — believing the name would refuse a readable file.
 */
function formatFromName(source: PdfSource): WorkbookFormat | undefined {
  const name = (source as { name?: unknown }).name;
  return typeof name === 'string' && /\.(tsv|tab)$/i.test(name)
    ? 'tsv'
    : undefined;
}

/** An opened spreadsheet. Get one from {@link openWorkbook}. */
export class Workbook {
  /** The container actually read. */
  readonly format: WorkbookFormat;
  /** Every sheet in tab order, hidden ones included. */
  readonly sheets: readonly SheetInfo[];
  /**
   * CSV and TSV only: the encoding the text was decoded from, e.g.
   * `'windows-1252'`. Worth showing when it was guessed — a wrong guess reads as
   * mojibake, and {@link WorkbookOptions.encoding} is the fix.
   */
  readonly encoding: string | undefined;
  /** CSV and TSV only: the delimiter, given or sniffed. */
  readonly delimiter: string | undefined;
  readonly #native: NativeWorkbook;
  readonly #sheets = new Map<number, Promise<Sheet>>();

  /** @internal — construct via {@link openWorkbook}. */
  constructor(native: NativeWorkbook) {
    this.#native = native;
    this.format = native.format as WorkbookFormat;
    this.sheets = native.sheets.map((s) => ({
      name: s.name,
      kind: s.kind as SheetKind,
      visibility: s.visibility as SheetVisibility,
    }));
    this.encoding = native.encoding ?? undefined;
    this.delimiter = native.delimiter ?? undefined;
  }

  /**
   * Read one sheet, by index or by name.
   *
   * The first call parses the sheet, off the JS thread; later calls for the same
   * sheet share that result.
   */
  sheet(which: number | string): Promise<Sheet> {
    const index =
      typeof which === 'number'
        ? which
        : this.sheets.findIndex((s) => s.name === which);
    if (!Number.isInteger(index) || index < 0 || index >= this.sheets.length) {
      return Promise.reject(
        new RangeError(`papyra: no sheet ${JSON.stringify(which)}`),
      );
    }
    let sheet = this.#sheets.get(index);
    if (!sheet) {
      sheet = this.#native.sheet(index).then((native) => new Sheet(native));
      // A failed read is not cached, so a retry gets a fresh attempt.
      sheet.catch(() => this.#sheets.delete(index));
      this.#sheets.set(index, sheet);
    }
    return sheet;
  }
}

/**
 * One sheet, parsed and held in Rust. Read it a window at a time.
 *
 * Coordinates are the sheet's own and 0-based: row 0 is the row Excel labels 1, and
 * a sheet whose data starts at F10 still reports ten rows and six columns, so a grid
 * draws the data where its author put it.
 */
export class Sheet {
  /** The name on the sheet's tab. */
  readonly name: string;
  /** One past the last row holding a value or covered by a merge. */
  readonly rows: number;
  /** One past the last column holding a value or covered by a merge. */
  readonly cols: number;
  /**
   * Merged regions. The value lives in each one's top-left cell; the others are
   * empty. Always empty for `.xlsb` and `.ods`, which calamine does not read
   * merges from.
   */
  readonly merges: readonly MergedRange[];
  readonly #native: NativeSheet;

  /** @internal — construct via {@link Workbook.sheet}. */
  constructor(native: NativeSheet) {
    this.#native = native;
    this.name = native.name;
    this.rows = native.rows;
    this.cols = native.cols;
    this.merges = toMergedRanges(native.merges);
  }

  /**
   * Read a rectangle of cells, clamped to the sheet.
   *
   * Synchronous, because the sheet is already parsed and the cost is the size of
   * the window. Ask for what is on screen plus some overscan, not the whole sheet:
   * a screenful is a few thousand cells and well under a millisecond.
   */
  window(range: WindowRange): CellWindow {
    // The bindings take u32s, which a negative overscan would wrap rather than clamp.
    const at = (n: number) => Math.max(0, Math.floor(n));
    return new CellWindow(
      this.#native.window(
        at(range.rowStart),
        at(range.rowEnd),
        at(range.colStart ?? 0),
        at(range.colEnd ?? this.cols),
      ),
    );
  }
}
