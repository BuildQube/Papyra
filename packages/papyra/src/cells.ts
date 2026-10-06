import type { CellWindow as NativeCellWindow } from '@build-qube/papyra-native';

/** What a cell holds. A formula cell reports the result Excel last computed. */
export type CellKind =
  | 'empty'
  | 'number'
  | 'text'
  | 'bool'
  | 'date'
  | 'duration'
  | 'error';

/** Indexed by the tag byte the bindings write. Keep in step with `CellKind` in Rust. */
const KINDS: readonly CellKind[] = [
  'empty',
  'number',
  'text',
  'bool',
  'date',
  'duration',
  'error',
];

/** A cell with nothing in it, or outside the sheet's used range. */
export interface EmptyCell {
  /** Always `'empty'`. */
  kind: 'empty';
  /** Always `''`. */
  text: '';
}

/** A number, or in CSV a field that is unambiguously one. */
export interface NumberCell {
  /** Always `'number'`. */
  kind: 'number';
  /** The value. */
  value: number;
  /**
   * Excel's General rendering for a workbook. For CSV, the field exactly as
   * written: `2.50` stays `2.50`.
   */
  text: string;
}

/** A string. Every CSV field that is not a plain number is one. */
export interface TextCell {
  /** Always `'text'`. */
  kind: 'text';
  /** The string. */
  text: string;
}

/** A boolean. */
export interface BoolCell {
  /** Always `'bool'`. */
  kind: 'bool';
  /** The value. */
  value: boolean;
  /** Excel's spelling, which is also what a CSV export of the cell contains. */
  text: 'TRUE' | 'FALSE';
}

/** A date, a time, or both. */
export interface DateCell {
  /** Always `'date'`. */
  kind: 'date';
  /**
   * The Excel date serial: days since 1899-12-30, time as the fraction. NaN for
   * OpenDocument, which stores only the ISO form.
   */
  serial: number;
  /** `2024-03-15`, `2024-03-15T13:30:00`, or `13:30:00` for a time alone. */
  text: string;
}

/** A length of time. */
export interface DurationCell {
  /** Always `'duration'`. */
  kind: 'duration';
  /** Length in days. NaN for OpenDocument, which stores only the text form. */
  days: number;
  /** `[h]:mm:ss` — hours do not wrap at 24. */
  text: string;
}

/** An error a formula evaluated to. */
export interface ErrorCell {
  /** Always `'error'`. */
  kind: 'error';
  /** Excel's code for it, e.g. `#DIV/0!`. */
  text: string;
}

/**
 * One cell's value, discriminated on `kind`.
 *
 * `text` is always what to display. Number formats are not applied yet, so a
 * currency cell reads `1234.5` rather than `$1,234.50` and a date reads as ISO 8601
 * — the raw value is beside it for anything that needs to compute.
 */
export type Cell =
  | EmptyCell
  | NumberCell
  | TextCell
  | BoolCell
  | DateCell
  | DurationCell
  | ErrorCell;

/**
 * Cells merged into one, as a sheet reports them. Inclusive at both ends, like the
 * `A4:B4` Excel would write — hence `lastRow` rather than an exclusive `rowEnd`.
 */
export interface MergedRange {
  /** 0-based row of the top-left cell, which holds the value. */
  row: number;
  /** 0-based column of the top-left cell. */
  col: number;
  /** Last row covered, inclusive. */
  lastRow: number;
  /** Last column covered, inclusive. */
  lastCol: number;
}

/**
 * A rectangle of a sheet, read in one call and decoded on access.
 *
 * Cells cross from Rust as four flat buffers rather than an object each, because
 * building thousands of objects costs more than parsing them did. Nothing is
 * decoded until asked for, so a grid that only draws text never builds a {@link Cell}.
 *
 * Coordinates are the sheet's, not the window's: `text(10, 2)` is row 10 of the
 * sheet whichever row the window starts on. Anything outside the window is empty.
 */
export class CellWindow {
  /** First row held. */
  readonly rowStart: number;
  /** First column held. */
  readonly colStart: number;
  /** Rows held, which may be fewer than asked for at the sheet's edge. */
  readonly rows: number;
  /** Columns held. */
  readonly cols: number;
  readonly #native: NativeCellWindow;

  /** @internal Use `Sheet.window`. */
  constructor(native: NativeCellWindow) {
    this.#native = native;
    this.rowStart = native.rowStart;
    this.colStart = native.colStart;
    this.rows = native.rows;
    this.cols = native.cols;
  }

  /** One past the last row held. */
  get rowEnd(): number {
    return this.rowStart + this.rows;
  }

  /** One past the last column held. */
  get colEnd(): number {
    return this.colStart + this.cols;
  }

  #index(row: number, col: number): number {
    const r = row - this.rowStart;
    const c = col - this.colStart;
    if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) return -1;
    return r * this.cols + c;
  }

  /** What the cell at `(row, col)` holds. Cheaper than {@link cell}. */
  kind(row: number, col: number): CellKind {
    const i = this.#index(row, col);
    return i < 0 ? 'empty' : (KINDS[this.#native.kinds[i] ?? 0] ?? 'empty');
  }

  /** The display text at `(row, col)` — all a plain grid needs. */
  text(row: number, col: number): string {
    const i = this.#index(row, col);
    if (i < 0) return '';
    const { offsets, text } = this.#native;
    return text.slice(offsets[i], offsets[i + 1]);
  }

  /**
   * The numeric value at `(row, col)`: a number, a bool as 0 or 1, a date's serial,
   * a duration in days. NaN for anything else.
   */
  number(row: number, col: number): number {
    const i = this.#index(row, col);
    return i < 0 ? Number.NaN : (this.#native.numbers[i] ?? Number.NaN);
  }

  /** The cell at `(row, col)`, fully decoded. */
  cell(row: number, col: number): Cell {
    const kind = this.kind(row, col);
    const text = this.text(row, col);
    const n = this.number(row, col);
    switch (kind) {
      case 'empty':
        return { kind, text: '' };
      case 'number':
        return { kind, value: n, text };
      case 'bool':
        return n === 1
          ? { kind, value: true, text: 'TRUE' }
          : { kind, value: false, text: 'FALSE' };
      case 'date':
        return { kind, serial: n, text };
      case 'duration':
        return { kind, days: n, text };
      case 'text':
      case 'error':
        return { kind, text };
    }
  }
}

/** Unpack the bindings' flat merge quads. @internal */
export function toMergedRanges(quads: Uint32Array): MergedRange[] {
  const out: MergedRange[] = [];
  for (let i = 0; i + 3 < quads.length; i += 4) {
    out.push({
      row: quads[i] ?? 0,
      col: quads[i + 1] ?? 0,
      lastRow: quads[i + 2] ?? 0,
      lastCol: quads[i + 3] ?? 0,
    });
  }
  return out;
}

/**
 * The letters Excel heads a column with: 0 is `A`, 25 is `Z`, 26 is `AA`.
 *
 * @example
 * ```ts
 * columnName(27); // 'AB'
 * ```
 */
export function columnName(index: number): string {
  let name = '';
  for (let n = Math.floor(index) + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}
