import { describe, expect, test } from 'bun:test';
import type { CellWindow as NativeCellWindow } from '@build-qube/papyra-native';
import { CellWindow, columnName, toMergedRanges } from '../../src/cells.js';

/** Pack cells the way the bindings do: tags, numbers, one string and its offsets. */
function pack(
  rowStart: number,
  colStart: number,
  cols: number,
  cells: [kind: number, value: number, text: string][],
): NativeCellWindow {
  const offsets = [0];
  let text = '';
  for (const [, , t] of cells) {
    text += t;
    offsets.push(text.length);
  }
  return {
    rowStart,
    colStart,
    rows: cells.length / cols,
    cols,
    kinds: new Uint8Array(cells.map(([k]) => k)),
    numbers: new Float64Array(cells.map(([, n]) => n)),
    text,
    offsets: new Uint32Array(offsets),
    styles: new Uint16Array(cells.map((_, i) => i)),
    colors: new Uint32Array(cells.map((_, i) => (i === 1 ? 0x0100_0000 : 0))),
  };
}

describe('CellWindow', () => {
  // Row 10, columns 2..4: a 1x3 window well away from A1.
  const window = new CellWindow(
    pack(10, 2, 3, [
      [2, Number.NaN, 'Nuts \u{1F529} M8'],
      [1, 0.25, '0.25'],
      [4, 45366, '2024-03-15'],
    ]),
  );

  test('addresses cells in sheet coordinates, not window coordinates', () => {
    expect(window.text(10, 2)).toBe('Nuts \u{1F529} M8');
    expect(window.text(10, 3)).toBe('0.25');
    expect(window.rowEnd).toBe(11);
    expect(window.colEnd).toBe(5);
  });

  test('slices text by UTF-16 offsets, past a surrogate pair', () => {
    // The bolt emoji is two UTF-16 units. Byte offsets would shift the next cell.
    expect(window.text(10, 4)).toBe('2024-03-15');
  });

  test('reads outside the window as empty', () => {
    expect(window.kind(0, 0)).toBe('empty');
    expect(window.text(10, 5)).toBe('');
    expect(window.number(9, 2)).toBeNaN();
    expect(window.cell(11, 2)).toEqual({ kind: 'empty', text: '' });
  });

  test('decodes each kind into its own shape', () => {
    expect(window.cell(10, 3)).toEqual({
      kind: 'number',
      value: 0.25,
      text: '0.25',
    });
    expect(window.cell(10, 4)).toEqual({
      kind: 'date',
      serial: 45366,
      text: '2024-03-15',
    });

    const rest = new CellWindow(
      pack(0, 0, 4, [
        [3, 1, 'TRUE'],
        [3, 0, 'FALSE'],
        [5, 1.5, '36:00:00'],
        [6, Number.NaN, '#DIV/0!'],
      ]),
    );
    expect(rest.cell(0, 0)).toEqual({
      kind: 'bool',
      value: true,
      text: 'TRUE',
    });
    expect(rest.cell(0, 1)).toEqual({
      kind: 'bool',
      value: false,
      text: 'FALSE',
    });
    expect(rest.cell(0, 2)).toEqual({
      kind: 'duration',
      days: 1.5,
      text: '36:00:00',
    });
    expect(rest.cell(0, 3)).toEqual({ kind: 'error', text: '#DIV/0!' });
  });
});

describe('CellWindow styles', () => {
  const window = new CellWindow(
    pack(0, 0, 3, [
      [1, 1, '1'],
      [1, -1, '(1)'],
      [0, Number.NaN, ''],
    ]),
  );

  test('reads a style index per cell, and 0 outside the window', () => {
    expect(window.style(0, 2)).toBe(2);
    expect(window.style(5, 5)).toBe(0);
  });

  test('tells black apart from no colour', () => {
    // The bindings set a high bit on a present colour; black is 0x000000.
    expect(window.color(0, 1)).toBe(0);
    expect(window.color(0, 0)).toBeUndefined();
    expect(window.color(9, 9)).toBeUndefined();
  });
});

describe('toMergedRanges', () => {
  test('unpacks flat quads', () => {
    expect(toMergedRanges(new Uint32Array([3, 0, 3, 1, 0, 2, 4, 2]))).toEqual([
      { row: 3, col: 0, lastRow: 3, lastCol: 1 },
      { row: 0, col: 2, lastRow: 4, lastCol: 2 },
    ]);
    expect(toMergedRanges(new Uint32Array())).toEqual([]);
  });
});

describe('columnName', () => {
  test('counts in bijective base 26', () => {
    // There is no zero digit: Z is followed by AA, not BA.
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(27)).toBe('AB');
    expect(columnName(701)).toBe('ZZ');
    expect(columnName(702)).toBe('AAA');
    // Excel's last column.
    expect(columnName(16383)).toBe('XFD');
  });
});
