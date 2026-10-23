import { afterEach, describe, expect, test } from 'bun:test';
import {
  type Box,
  type Rotation,
  TILE_SIZE,
  tileDpi,
  tileSlots,
  uprightBox,
  uprightTransform,
} from '@/lib/viewer-zoom';

const ARCH_E = { width: 42 * 72, height: 30 * 72 };
const LETTER = { width: 612, height: 792 };

function withDpr(dpr: number) {
  (globalThis as { window?: unknown }).window = { devicePixelRatio: dpr };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('tileDpi', () => {
  test('is off while one bitmap of the page fits the cap', () => {
    withDpr(2);
    expect(tileDpi(LETTER, 2)).toBe(0);
    expect(tileDpi(ARCH_E, 0.5)).toBe(0);
    // Past it, whatever the sheet: Letter at 400% on a retina screen is 55 MP.
    expect(tileDpi(LETTER, 4)).toBeGreaterThan(0);
    expect(tileDpi(ARCH_E, 1)).toBeGreaterThan(0);
  });

  test('steps by √2, rounding up, so nearby zooms share one set', () => {
    withDpr(2);
    // 400% at DPR 2 wants 768 DPI; the step above is 72·√2⁷.
    const at400 = tileDpi(ARCH_E, 4);
    expect(at400).toBeCloseTo(72 * Math.SQRT2 ** 7, 6);
    expect(tileDpi(ARCH_E, 3.6)).toBe(at400);
    expect(tileDpi(ARCH_E, 4.2)).toBe(at400);
    expect(tileDpi(ARCH_E, 4.3)).toBeCloseTo(72 * 16, 6);
    // 300% at DPR 2 is exactly 576 DPI, a step: it stays there.
    expect(tileDpi(ARCH_E, 3)).toBeCloseTo(576, 6);
  });

  test('never renders above DPR 2, like the bitmap', () => {
    withDpr(3);
    const at3 = tileDpi(ARCH_E, 4);
    withDpr(2);
    expect(at3).toBe(tileDpi(ARCH_E, 4));
  });
});

/** Where `uprightTransform` sends a point of the upright layer. */
function apply(transform: string, [x, y]: [number, number]): [number, number] {
  const [, tx, ty, deg] =
    /translate\((\S+)px, (\S+)px\) rotate\((\d+)deg\)/.exec(transform) ?? [];
  const a = (Number(deg) * Math.PI) / 180;
  return [
    Math.round(Number(tx) + x * Math.cos(a) - y * Math.sin(a)),
    Math.round(Number(ty) + x * Math.sin(a) + y * Math.cos(a)),
  ];
}

describe('the upright layer', () => {
  const box = { width: 300, height: 201 };
  const rect: Box = { x0: 10, y0: 20, x1: 60, y1: 45 };

  for (const rotation of [0, 90, 180, 270] as Rotation[]) {
    test(`at ${rotation}° maps back onto the box it was turned onto`, () => {
      const turned = rotation % 180 !== 0;
      const page = turned ? { width: 201, height: 300 } : box;
      const up = uprightBox(rect, box, rotation);
      // Inside the upright page...
      expect(up.x0).toBeGreaterThanOrEqual(0);
      expect(up.x1).toBeLessThanOrEqual(page.width);
      expect(up.y1).toBeLessThanOrEqual(page.height);
      // ...and turned back by the CSS transform, the same rectangle.
      const t = uprightTransform(box, rotation);
      const corners = [apply(t, [up.x0, up.y0]), apply(t, [up.x1, up.y1])];
      const xs = corners.map(([x]) => x).sort((a, b) => a - b);
      const ys = corners.map(([, y]) => y).sort((a, b) => a - b);
      expect({ x0: xs[0], y0: ys[0], x1: xs[1], y1: ys[1] }).toEqual(rect);
    });
  }
});

describe('tileSlots', () => {
  // 400% at DPR 2 of an ARCH-E sheet: 32256 x 23040 device pixels, 32 x 23 tiles.
  const dpi = 768;
  const layerWidth = ARCH_E.width * (96 / 72) * 4;
  const view: Box = { x0: 5000, y0: 3000, x1: 6920, y1: 4080 };

  test('covers the view, nearest the middle first, with a margin behind', () => {
    const slots = tileSlots(ARCH_E, dpi, layerWidth, view);
    const visible = slots.filter((s) => s.visible);
    // 1920x1080 CSS at DPR 2 is 3840x2160 device px: 4 or 5 columns, 3 or 4 rows.
    expect(visible.length).toBeGreaterThanOrEqual(12);
    expect(visible.length).toBeLessThanOrEqual(20);
    expect(slots.length).toBeGreaterThan(visible.length);
    // Every visible tile is queued before any margin tile.
    expect(slots.findIndex((s) => !s.visible)).toBe(visible.length);
    const mid = { x: 5960, y: 3540 };
    const [first] = slots;
    expect(first?.box.x0).toBeLessThanOrEqual(mid.x);
    expect(first?.box.x1).toBeGreaterThan(mid.x);
    expect(first?.box.y0).toBeLessThanOrEqual(mid.y);
    expect(first?.box.y1).toBeGreaterThan(mid.y);
    for (const { box } of visible) {
      expect(box.x1 > view.x0 && box.x0 < view.x1).toBe(true);
    }
  });

  test('stops at the page edge, with the last tiles cut short', () => {
    const slots = tileSlots(
      ARCH_E,
      dpi,
      layerWidth,
      {
        x0: layerWidth - 10,
        y0: 0,
        x1: layerWidth,
        y1: 10,
      },
      2,
    );
    const corner = slots.find((s) => s.visible);
    expect(corner?.tile).toEqual({
      x: 31 * TILE_SIZE,
      y: 0,
      width: 32256 - 31 * TILE_SIZE,
      // Overlapping the row below by two pixels, but never past the page.
      height: TILE_SIZE + 2,
    });
    expect(Math.max(...slots.map((s) => s.tile.x / TILE_SIZE))).toBe(31);
    expect(Math.min(...slots.map((s) => s.tile.y))).toBe(0);
  });

  test('a view off the page asks for nothing', () => {
    expect(
      tileSlots(ARCH_E, dpi, layerWidth, { x0: 10, y0: 10, x1: 10, y1: 90 }),
    ).toEqual([]);
  });

  // The seam check. Where the page box sits at a fractional device pixel two tiles
  // that only meet both half-cover the pixel on their seam, and the backdrop shows
  // through as a hairline; so neighbours must overlap by a whole device pixel, at
  // every DPR and wherever between two DPI steps the zoom sits.
  for (const dpr of [1, 1.25, 1.5, 2, 3]) {
    test(`neighbours overlap by a device pixel at DPR ${dpr}`, () => {
      withDpr(dpr);
      for (const zoom of [1.01, 2.83, 3.99, 4.01, 7.3]) {
        const tiled = tileDpi(ARCH_E, zoom);
        // 101% at DPR 1 fits one bitmap.
        if (!tiled) continue;
        const width = ARCH_E.width * (96 / 72) * zoom;
        const slots = tileSlots(ARCH_E, tiled, width, {
          x0: 0,
          y0: 0,
          x1: 4000,
          y1: 4000,
        });
        const at = new Map(slots.map((s) => [s.key, s.box]));
        for (const [key, box] of at) {
          const [c, r] = key.split(',').map(Number) as [number, number];
          const right = at.get(`${c + 1},${r}`);
          const below = at.get(`${c},${r + 1}`);
          if (right) expect((box.x1 - right.x0) * dpr).toBeGreaterThan(1);
          if (below) expect((box.y1 - below.y0) * dpr).toBeGreaterThan(1);
        }
        expect(at.size).toBeGreaterThan(1);
      }
    });
  }
});
