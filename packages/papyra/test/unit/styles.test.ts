import { describe, expect, test } from 'bun:test';
import type {
  CellStyle as NativeCellStyle,
  SheetLayout as NativeSheetLayout,
} from '@build-qube/papyra-native';
import { cssColor, toCellStyle, toSheetLayout } from '../../src/styles.js';

const PLAIN: NativeCellStyle = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  fontScale: 1,
  wrap: false,
  indent: 0,
};

describe('toCellStyle', () => {
  test('leaves absent fields absent', () => {
    expect(toCellStyle(PLAIN)).toEqual({
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      fontScale: 1,
      wrap: false,
      indent: 0,
    });
    expect('color' in toCellStyle(PLAIN)).toBe(false);
  });

  test('keeps black, which is a colour and not "automatic"', () => {
    const s = toCellStyle({
      ...PLAIN,
      color: 0,
      fill: 0xffff00,
      borderBottom: { style: 'double', color: 0x0000ff },
      borderLeft: { style: 'thin' },
      horizontal: 'center',
    });
    expect(s.color).toBe(0);
    expect(s.fill).toBe(0xffff00);
    expect(s.borderBottom).toEqual({ style: 'double', color: 0x0000ff });
    expect(s.borderLeft).toEqual({ style: 'thin' });
    expect(s.horizontal).toBe('center');
  });
});

test('toSheetLayout unpacks flat spans and rows', () => {
  const native: NativeSheetLayout = {
    defaultColWidth: 64,
    defaultRowHeight: 20,
    cols: new Float64Array([0, 0, 145, 5, 5, 0]),
    rows: new Float64Array([0, 40, 5, 0]),
    showGridLines: false,
  };
  expect(toSheetLayout(native)).toEqual({
    defaultColWidth: 64,
    defaultRowHeight: 20,
    columns: [
      { first: 0, last: 0, width: 145 },
      { first: 5, last: 5, width: 0 },
    ],
    rows: [
      { row: 0, height: 40 },
      { row: 5, height: 0 },
    ],
    showGridLines: false,
  });
});

test('cssColor pads to six digits', () => {
  expect(cssColor(0x1f4e79)).toBe('#1f4e79');
  expect(cssColor(0)).toBe('#000000');
  expect(cssColor(0xff)).toBe('#0000ff');
});
