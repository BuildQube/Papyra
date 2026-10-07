import { describe, expect, test } from 'bun:test';
import type { CellStyle, SheetLayout } from '@build-qube/papyra';
import {
  borderCss,
  cellCss,
  edgesAxis,
  layoutColumns,
  layoutRows,
  leadingBorders,
  textColor,
  toEdges,
  uniformAxis,
} from '@/lib/file-preview-sheet-layout';

const PLAIN: CellStyle = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  fontScale: 1,
  wrap: false,
  indent: 0,
};

const LAYOUT: SheetLayout = {
  defaultColWidth: 64,
  defaultRowHeight: 20,
  columns: [
    { first: 0, last: 0, width: 145 },
    { first: 2, last: 16383, width: 0 },
  ],
  rows: [{ row: 1, height: 40 }],
  showGridLines: true,
};

describe('axes', () => {
  test('a uniform axis is arithmetic', () => {
    const a = uniformAxis(1_000_000, 24);
    expect(a.total).toBe(24_000_000);
    expect(a.start(10)).toBe(240);
    expect(a.at(250)).toBe(10);
    expect(a.at(-5)).toBe(0);
    expect(a.at(1e12)).toBe(999_999);
  });

  test('an edges axis finds the item under a point, skipping hidden ones', () => {
    // Widths 10, 0, 30: the middle item is hidden and shares its start.
    const a = edgesAxis(toEdges([10, 0, 30]));
    expect(a.total).toBe(40);
    expect(a.size(1)).toBe(0);
    expect(a.at(5)).toBe(0);
    expect(a.at(10)).toBe(2);
    expect(a.at(39)).toBe(2);
  });

  test('a layout spans columns, clamping a span that runs to the last column', () => {
    const cols = layoutColumns(LAYOUT, 4);
    expect([0, 1, 2, 3].map((c) => cols.size(c))).toEqual([145, 64, 0, 0]);
  });

  test('rows take their own heights, or stay uniform when none do', () => {
    const rows = layoutRows(LAYOUT, 3);
    expect([0, 1, 2].map((r) => rows.size(r))).toEqual([20, 40, 20]);
    expect(layoutRows({ ...LAYOUT, rows: [] }, 1_000_000).total).toBe(
      20_000_000,
    );
  });
});

describe('textColor', () => {
  test('explicit black on no fill is the page default, so dark themes can read it', () => {
    expect(textColor({ ...PLAIN, color: 0x000000 }, undefined)).toBeUndefined();
    expect(textColor({ ...PLAIN, color: 0xffffff }, undefined)).toBeUndefined();
  });

  test('a colour that means something is kept', () => {
    expect(textColor({ ...PLAIN, color: 0x1f4e79 }, undefined)).toBe('#1f4e79');
    // A format's [Red] overrides the font's colour, as in Excel.
    expect(textColor({ ...PLAIN, color: 0x1f4e79 }, 0xff0000)).toBe('#ff0000');
  });

  test('on a fill, the author colour stands, or else whatever reads', () => {
    expect(
      textColor({ ...PLAIN, fill: 0x4472c4, color: 0xffffff }, undefined),
    ).toBe('#ffffff');
    expect(textColor({ ...PLAIN, fill: 0xffff00 }, undefined)).toBe('#000000');
    expect(textColor({ ...PLAIN, fill: 0x1f1f1f }, undefined)).toBe('#ffffff');
  });
});

describe('cell CSS', () => {
  test('defaults: numbers right, text left, bottom-aligned, gridlines on', () => {
    expect(cellCss(undefined, 'number', undefined, true)).toMatchObject({
      justifyContent: 'flex-end',
      alignItems: 'flex-end',
    });
    expect(cellCss(undefined, 'text', undefined, true).justifyContent).toBe(
      'flex-start',
    );
    expect(cellCss(undefined, 'text', undefined, true).borderRight).toContain(
      '1px solid',
    );
    expect(cellCss(undefined, 'text', undefined, false).borderRight).toBe(
      undefined,
    );
  });

  test('applies fonts, fill, alignment, wrap and indent', () => {
    const css = cellCss(
      {
        ...PLAIN,
        bold: true,
        italic: true,
        underline: true,
        strike: true,
        fontScale: 2,
        fill: 0xffff00,
        horizontal: 'center',
        vertical: 'top',
        wrap: true,
        indent: 2,
      },
      'text',
      undefined,
      true,
    );
    expect(css).toMatchObject({
      fontWeight: 600,
      fontStyle: 'italic',
      textDecoration: 'underline line-through',
      fontSize: '2em',
      background: '#ffff00',
      justifyContent: 'center',
      alignItems: 'flex-start',
      whiteSpace: 'normal',
      paddingLeft: 26,
    });
  });

  test('an own border replaces the gridline; leading edges go to the overlay', () => {
    const style: CellStyle = {
      ...PLAIN,
      borderRight: { style: 'medium', color: 0xff0000 },
      borderTop: { style: 'thin' },
    };
    expect(cellCss(style, 'text', undefined, true).borderRight).toBe(
      '2px solid #ff0000',
    );
    expect(leadingBorders(style)).toEqual({
      borderTop: '1px solid var(--foreground)',
    });
    expect(leadingBorders(PLAIN)).toBeUndefined();
  });

  test('a black border on no fill follows the page, like black text', () => {
    expect(borderCss({ style: 'double', color: 0 }, false)).toBe(
      '3px double var(--foreground)',
    );
    expect(borderCss({ style: 'double', color: 0 }, true)).toBe(
      '3px double #000000',
    );
  });
});
