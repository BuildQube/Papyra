import { describe, expect, test } from 'bun:test';
import { lineQuad, type TextLine } from '../../src/text.js';
import type { PageSize, RenderedPage } from '../../src/types.js';
import {
  type Rotation,
  rotatePage,
  viewport,
  viewportQuad,
  viewportRect,
} from '../../src/viewport.js';

/** US Letter, so a rotation is visible in the dimensions. */
const LETTER: PageSize = { width: 612, height: 792 };

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

describe('viewport', () => {
  test('defaults to 72 DPI and no rotation', () => {
    const vp = viewport(LETTER);
    expect(vp).toMatchObject({ width: 612, height: 792, scale: 1, dpi: 72 });
  });

  test('a quarter turn swaps the output dimensions', () => {
    const vp = viewport(LETTER, { rotation: 90 });
    expect([vp.width, vp.height]).toEqual([792, 612]);
  });

  test('a half turn does not', () => {
    const vp = viewport(LETTER, { rotation: 180 });
    expect([vp.width, vp.height]).toEqual([612, 792]);
  });

  test('dpi scales both dimensions', () => {
    const vp = viewport(LETTER, { dpi: 144 });
    expect([vp.width, vp.height, vp.scale]).toEqual([1224, 1584, 2]);
  });

  test('fitWidth measures the width on screen, not the page width', () => {
    // The whole reason to size through a viewport: turned, the page's 792pt height is
    // what has to land in 1600px, so the scale differs from the unrotated case.
    const upright = viewport(LETTER, { fitWidth: 1600 });
    const turned = viewport(LETTER, { fitWidth: 1600, rotation: 90 });

    expect(upright.width).toBe(1600);
    expect(turned.width).toBe(1600);
    expect(turned.scale).not.toBe(upright.scale);
    expect(turned.scale).toBeCloseTo(1600 / 792, 10);
  });

  test('dpi renders the bitmap the viewport expects', () => {
    // A render is unrotated, so its pixels must match the viewport with the rotation
    // undone — otherwise a painted page and its link layer disagree in size.
    const vp = viewport(LETTER, { fitWidth: 1600, rotation: 270 });
    // The engine floors a scaled point size to get its pixmap, and so does the
    // viewport — so the two agree exactly rather than within a rounding step.
    const bitmapWidth = Math.floor((LETTER.width * vp.dpi) / 72);
    const bitmapHeight = Math.floor((LETTER.height * vp.dpi) / 72);
    expect(bitmapHeight).toBe(vp.width);
    expect(bitmapWidth).toBe(vp.height);
  });

  test('a zero-width page falls back to dpi rather than dividing by zero', () => {
    const vp = viewport({ width: 0, height: 0 }, { fitWidth: 1600 });
    expect(vp.scale).toBe(1);
  });
});

describe('viewportRect', () => {
  const rect = { x: 72, y: 100, width: 128, height: 20 };

  test('is scaleRect when unrotated', () => {
    const vp = viewport(LETTER, { dpi: 144 });
    expect(viewportRect(rect, vp)).toEqual({
      x: 144,
      y: 200,
      width: 256,
      height: 40,
    });
  });

  test('a quarter turn clockwise moves the top-left corner to the right edge', () => {
    const vp = viewport(LETTER, { rotation: 90 });
    // The rect starts 100pt down the page; turned, it sits 100pt in from the right,
    // and its far edge (y = 120) is 120pt in.
    expect(viewportRect(rect, vp)).toEqual({
      x: 792 - 120,
      y: 72,
      width: 20,
      height: 128,
    });
  });

  test('stays inside the viewport at every rotation', () => {
    for (const rotation of ROTATIONS) {
      const vp = viewport(LETTER, { rotation, dpi: 150 });
      const out = viewportRect(rect, vp);
      expect(out.x).toBeGreaterThanOrEqual(0);
      expect(out.y).toBeGreaterThanOrEqual(0);
      expect(out.x + out.width).toBeLessThanOrEqual(vp.width);
      expect(out.y + out.height).toBeLessThanOrEqual(vp.height);
    }
  });

  test('four quarter turns return the rect where it started', () => {
    let out = rect;
    for (let i = 0; i < 4; i++) {
      out = viewportRect(out, viewport(sizeFor(i), { rotation: 90 }));
    }
    expect(out).toEqual(rect);
  });

  test('never reports a negative extent', () => {
    for (const rotation of ROTATIONS) {
      const out = viewportRect(rect, viewport(LETTER, { rotation }));
      expect(out.width).toBeGreaterThan(0);
      expect(out.height).toBeGreaterThan(0);
    }
  });
});

describe('viewportQuad', () => {
  const line: TextLine = {
    text: 'hello',
    offsets: Float32Array.from([0, 10, 20, 30, 40, 50]),
    x: 72,
    y: 100,
    dx: 1,
    dy: 0,
    ascent: 8,
    descent: 2,
  };

  test('is a pure scale when unrotated', () => {
    const quad = lineQuad(line, 0, 5);
    const out = viewportQuad(quad, viewport(LETTER, { dpi: 144 }));
    expect(out.x0).toBeCloseTo(quad.x0 * 2, 10);
    expect(out.y0).toBeCloseTo(quad.y0 * 2, 10);
  });

  test('keeps its corners in order through a quarter turn', () => {
    // Horizontal text turned 90° clockwise reads top-to-bottom, so the corner that
    // was the top-left is now the top-right — the quad's own order is preserved and
    // it is the page that moved.
    const quad = lineQuad(line, 0, 5);
    const out = viewportQuad(quad, viewport(LETTER, { rotation: 90 }));

    // Top edge (0 -> 1) still runs along the text; it is now vertical.
    expect(out.x0).toBeCloseTo(out.x1, 10);
    expect(out.y1).toBeGreaterThan(out.y0);
    // The perpendicular edge (0 -> 3) is now horizontal.
    expect(out.y0).toBeCloseTo(out.y3, 10);
  });

  test('preserves the quad area at every rotation', () => {
    const quad = lineQuad(line, 0, 5);
    for (const rotation of ROTATIONS) {
      const out = viewportQuad(quad, viewport(LETTER, { rotation }));
      expect(shoelace(out)).toBeCloseTo(shoelace(quad), 6);
    }
  });
});

describe('rotatePage', () => {
  test('returns the same object when there is nothing to do', () => {
    const page = checker(2, 3);
    expect(rotatePage(page, 0)).toBe(page);
  });

  test('a quarter turn swaps the dimensions and fixes the stride', () => {
    const out = rotatePage(checker(2, 3), 90);
    expect([out.width, out.height, out.stride]).toEqual([3, 2, 12]);
  });

  test("the top-left pixel lands where the viewport's mapping puts it", () => {
    const page = checker(2, 3);
    const out = rotatePage(page, 90);
    // Source (0, 0) -> dest (height - 1, 0), the top-right corner.
    expect(pixel(out, out.width - 1, 0)).toEqual(pixel(page, 0, 0));
  });

  test('four quarter turns are the identity', () => {
    const page = checker(3, 5);
    let out = page;
    for (let i = 0; i < 4; i++) out = rotatePage(out, 90);
    expect([out.width, out.height]).toEqual([page.width, page.height]);
    expect(Array.from(out.data)).toEqual(Array.from(page.data));
  });

  test('a half turn is two quarter turns', () => {
    const page = checker(4, 3);
    const half = rotatePage(page, 180);
    const twice = rotatePage(rotatePage(page, 90), 90);
    expect(Array.from(half.data)).toEqual(Array.from(twice.data));
  });

  test('270 undoes 90', () => {
    const page = checker(4, 3);
    const round = rotatePage(rotatePage(page, 90), 270);
    expect(Array.from(round.data)).toEqual(Array.from(page.data));
  });

  test('reads correctly from an unaligned view of shared-style memory', () => {
    // The wasm build hands back a window onto the module's linear memory, and a
    // `byteOffset` that is not a multiple of four rules out the Uint32 fast path.
    // Both paths have to produce the same pixels.
    const page = checker(3, 4);
    const padded = new Uint8Array(page.data.length + 1);
    padded.set(page.data, 1);
    const unaligned: RenderedPage = {
      ...page,
      data: padded.subarray(1),
    };
    expect(unaligned.data.byteOffset % 4).toBe(1);
    expect(Array.from(rotatePage(unaligned, 90).data)).toEqual(
      Array.from(rotatePage(page, 90).data),
    );
  });
});

/** A page whose every pixel encodes its own coordinates, so a shuffle is checkable. */
function checker(width: number, height: number): RenderedPage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x + 1;
      data[i + 1] = y + 1;
      data[i + 2] = 7;
      data[i + 3] = 255;
    }
  }
  return { width, height, stride: width * 4, format: 'rgba8', data };
}

function pixel(page: RenderedPage, x: number, y: number): number[] {
  const i = y * page.stride + x * 4;
  return Array.from(page.data.subarray(i, i + 4));
}

/** Twice the signed area of a quad — rotation preserves it, so it pins the mapping. */
function shoelace(q: {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
}): number {
  return Math.abs(
    q.x0 * q.y1 -
      q.x1 * q.y0 +
      (q.x1 * q.y2 - q.x2 * q.y1) +
      (q.x2 * q.y3 - q.x3 * q.y2) +
      (q.x3 * q.y0 - q.x0 * q.y3),
  );
}

/** The page size after `turns` quarter turns of US Letter. */
function sizeFor(turns: number): PageSize {
  return turns % 2 === 0
    ? LETTER
    : { width: LETTER.height, height: LETTER.width };
}
