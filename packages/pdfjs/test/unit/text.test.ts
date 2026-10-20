import { describe, expect, test } from 'bun:test';
import { linesFromItems, type PdfjsTextItem } from '../../src/text.js';

/** A US Letter page at scale 1: flip y so the origin is the top-left corner. */
const LETTER = [1, 0, 0, -1, 0, 792];
const STYLES = { f: { ascent: 0.75, descent: -0.25 } };

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  extra: Partial<PdfjsTextItem> = {},
): PdfjsTextItem => ({
  str,
  transform: [10, 0, 0, 10, x, y],
  width,
  fontName: 'f',
  hasEOL: false,
  ...extra,
});

describe('linesFromItems', () => {
  test('one item: baseline origin, direction, even offsets, font extents', () => {
    const [line] = linesFromItems([item('abcd', 72, 700, 20)], STYLES, LETTER);
    expect(line?.text).toBe('abcd');
    expect([line?.x, line?.y, line?.dx, line?.dy]).toEqual([72, 92, 1, 0]);
    expect([...(line?.offsets ?? [])]).toEqual([0, 5, 10, 15, 20]);
    expect([line?.ascent, line?.descent]).toEqual([7.5, 2.5]);
  });

  test('items on one baseline join, with a space put back across a gap', () => {
    const lines = linesFromItems(
      [item('quick', 72, 700, 25), item('fox', 102, 700, 15)],
      STYLES,
      LETTER,
    );
    expect(lines.map((l) => l.text)).toEqual(['quick fox']);
    // The space spans the gap; "fox" starts where its item does.
    expect(lines[0]?.offsets[5]).toBe(25);
    expect(lines[0]?.offsets[6]).toBe(30);
    expect(lines[0]?.offsets.length).toBe('quick fox'.length + 1);
  });

  test('touching items join with no space', () => {
    const lines = linesFromItems(
      [item('bold', 72, 700, 20), item('face', 92, 700, 20)],
      STYLES,
      LETTER,
    );
    expect(lines.map((l) => l.text)).toEqual(['boldface']);
  });

  test('a new baseline, a jump backwards, or an end-of-line starts a new line', () => {
    const lines = linesFromItems(
      [
        item('one', 72, 700, 15),
        item('two', 72, 680, 15),
        item('three', 20, 680, 25),
        item('four', 200, 600, 20, { hasEOL: true }),
        item('five', 222, 600, 20),
      ],
      STYLES,
      LETTER,
    );
    expect(lines.map((l) => l.text)).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
  });

  test('rotated text keeps its own direction, and its quad turns with it', () => {
    // A quarter turn anticlockwise in PDF space reads upwards on the page.
    const [line] = linesFromItems(
      [{ ...item('up', 100, 100, 10), transform: [0, 10, -10, 0, 100, 100] }],
      STYLES,
      LETTER,
    );
    expect(line?.dx).toBeCloseTo(0);
    expect(line?.dy).toBeCloseTo(-1);
    expect([line?.x, line?.y]).toEqual([100, 692]);
    expect(line?.offsets.at(-1)).toBe(10);
  });

  test('a style the page does not describe falls back to typical extents', () => {
    const [line] = linesFromItems(
      [item('x', 0, 0, 5, { fontName: 'missing' })],
      STYLES,
      LETTER,
    );
    expect([line?.ascent, line?.descent]).toEqual([8, 2]);
  });
});
