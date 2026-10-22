import { describe, expect, test } from 'bun:test';
import {
  type PageText,
  pageString,
  type Quad,
  quadBounds,
  scaleQuad,
  scaleRect,
} from '../../src/text.js';

describe('pageString', () => {
  test('joins the lines, one per row', () => {
    const line = (text: string) => ({ text }) as PageText['lines'][number];
    const text: PageText = {
      page: 0,
      lines: [line('one'), line('two')],
      undecodedGlyphs: 0,
    };
    expect(pageString(text)).toBe('one\ntwo');
  });
});

describe('scaleQuad', () => {
  test('scales every corner, agreeing with scaleRect on the bounds', () => {
    // A rotated quad, so no two corners share an axis.
    const quad: Quad = {
      x0: 1,
      y0: 2,
      x1: 5,
      y1: 3,
      x2: 4,
      y2: 7,
      x3: 0.5,
      y3: 6,
    };
    const scaled = scaleQuad(quad, 2);
    expect(Object.values(scaled)).toEqual(
      Object.values(quad).map((v) => v * 2),
    );
    expect(quadBounds(scaled)).toEqual(scaleRect(quadBounds(quad), 2));
  });
});
