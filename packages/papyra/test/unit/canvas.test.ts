import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { paintToCanvas, toImageData } from '../../src/canvas.js';
import type { RenderedPage } from '../../src/types.js';
import type { Rotation } from '../../src/viewport.js';

/**
 * `paintToCanvas` against a recording 2D context. Bun has no canvas, so the context
 * keeps the transform the way a browser's does and maps each draw's corners through
 * it — which is what lets these tests say where the pixels landed, not just which
 * methods were called.
 */
type Point = [number, number];
type Matrix = [number, number, number, number, number, number];
type Op =
  | { op: 'put'; image: ImageData; at: Point }
  | { op: 'draw'; source: unknown; corners: Point[] };

class FakeContext {
  ops: Op[] = [];
  m: Matrix = [1, 0, 0, 1, 0, 0];

  translate(x: number, y: number) {
    this.mul([1, 0, 0, 1, x, y]);
  }
  rotate(a: number) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.mul([c, s, -s, c, 0, 0]);
  }
  setTransform(...m: Matrix) {
    this.m = m;
  }
  // `putImageData` ignores the transform in a browser, so the fake does too.
  putImageData(image: ImageData, x: number, y: number) {
    this.ops.push({ op: 'put', image, at: [x, y] });
  }
  drawImage(source: { width: number; height: number }, x: number, y: number) {
    const { width: w, height: h } = source;
    const corners: Point[] = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ];
    this.ops.push({
      op: 'draw',
      source,
      corners: corners.map(([px, py]) => this.apply(px, py)),
    });
  }

  private mul([a, b, c, d, e, f]: Matrix) {
    const [A, B, C, D, E, F] = this.m;
    this.m = [
      A * a + C * b,
      B * a + D * b,
      A * c + C * d,
      B * c + D * d,
      A * e + C * f + E,
      B * e + D * f + F,
    ];
  }
  private apply(x: number, y: number): Point {
    const [a, b, c, d, e, f] = this.m;
    // Rounded, and `+ 0` folds -0, so cos(π/2)'s 6e-17 compares as the 0 it is.
    return [
      Math.round(a * x + c * y + e) + 0,
      Math.round(b * x + d * y + f) + 0,
    ];
  }
}

class FakeCanvas {
  ctx: FakeContext | null = new FakeContext();
  constructor(
    public width = 0,
    public height = 0,
  ) {}
  getContext() {
    return this.ctx;
  }
}

class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

const scratches: FakeCanvas[] = [];
class FakeOffscreenCanvas extends FakeCanvas {
  constructor(width: number, height: number) {
    super(width, height);
    scratches.push(this);
  }
}

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  scratches.length = 0;
  g.ImageData = FakeImageData;
  g.OffscreenCanvas = FakeOffscreenCanvas;
});
afterEach(() => {
  delete g.ImageData;
  delete g.OffscreenCanvas;
  delete g.document;
});

/** 4×2, so a quarter turn is visible in the canvas dimensions. */
const PAGE: RenderedPage = {
  width: 4,
  height: 2,
  data: new Uint8Array(4 * 2 * 4).fill(7),
};
/** Same shape as an `ImageBitmap`: dimensions, no `data`. */
const BITMAP = { width: 4, height: 2 } as ImageBitmap;

function paint(page: RenderedPage | ImageBitmap, rotation?: Rotation) {
  const canvas = new FakeCanvas();
  paintToCanvas(
    page,
    canvas as unknown as HTMLCanvasElement,
    rotation === undefined ? undefined : { rotation },
  );
  return { canvas, ctx: canvas.ctx as FakeContext };
}

describe('toImageData', () => {
  test('copies, so a view of shared wasm memory is not handed to ImageData', () => {
    const image = toImageData(PAGE);
    expect(image.width).toBe(4);
    expect(image.height).toBe(2);
    expect(image.data).toBeInstanceOf(Uint8ClampedArray);
    expect(image.data.buffer).not.toBe(PAGE.data.buffer);
    expect([...image.data]).toEqual([...PAGE.data]);
  });
});

describe('paintToCanvas', () => {
  test('unrotated pixels go straight in with putImageData', () => {
    const { canvas, ctx } = paint(PAGE);
    expect([canvas.width, canvas.height]).toEqual([4, 2]);
    expect(ctx.ops).toHaveLength(1);
    expect(ctx.ops[0]).toMatchObject({ op: 'put', at: [0, 0] });
    expect(scratches).toHaveLength(0);
  });

  test('an unrotated ImageBitmap is drawn, since it has no pixels to put', () => {
    const { ctx } = paint(BITMAP, 0);
    expect(ctx.ops).toEqual([
      {
        op: 'draw',
        source: BITMAP,
        corners: [
          [0, 0],
          [4, 0],
          [4, 2],
          [0, 2],
        ],
      },
    ]);
  });

  // Where the source's top-left corner must land for each clockwise turn.
  const ORIGIN: Record<
    Exclude<Rotation, 0>,
    (w: number, h: number) => Point
  > = {
    90: (w) => [w, 0],
    180: (w, h) => [w, h],
    270: (_, h) => [0, h],
  };

  for (const rotation of [90, 180, 270] as const) {
    test(`${rotation}°: pixels go through a scratch surface and are drawn turned`, () => {
      const { canvas, ctx } = paint(PAGE, rotation);
      const turned = rotation !== 180;
      expect([canvas.width, canvas.height]).toEqual(turned ? [2, 4] : [4, 2]);

      // The scratch holds the page unrotated, filled by putImageData…
      expect(scratches).toHaveLength(1);
      const scratch = scratches[0] as FakeCanvas;
      expect([scratch.width, scratch.height]).toEqual([4, 2]);
      expect(scratch.ctx?.ops).toMatchObject([{ op: 'put', at: [0, 0] }]);

      // …and only drawImage touches the target, because putImageData would ignore
      // the rotation the target's transform carries.
      expect(ctx.ops.map((o) => o.op)).toEqual(['draw']);
      const draw = ctx.ops[0] as Extract<Op, { op: 'draw' }>;
      expect(draw.source).toBe(scratch);
      expect(draw.corners[0]).toEqual(
        ORIGIN[rotation](canvas.width, canvas.height),
      );
      // Every corner lands on the canvas: nothing drawn off its edge.
      const xs = draw.corners.map(([x]) => x);
      const ys = draw.corners.map(([, y]) => y);
      expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, canvas.width]);
      expect([Math.min(...ys), Math.max(...ys)]).toEqual([0, canvas.height]);

      // The transform is left as it was found, for whoever paints next.
      expect(ctx.m).toEqual([1, 0, 0, 1, 0, 0]);
    });
  }

  test('a rotated ImageBitmap is drawn directly, with no scratch copy', () => {
    const { canvas, ctx } = paint(BITMAP, 90);
    expect(scratches).toHaveLength(0);
    expect(ctx.ops).toMatchObject([{ op: 'draw', source: BITMAP }]);
    const draw = ctx.ops[0] as Extract<Op, { op: 'draw' }>;
    expect(draw.corners[0]).toEqual([canvas.width, 0]);
  });

  test('without OffscreenCanvas the scratch is a DOM canvas', () => {
    delete g.OffscreenCanvas;
    const created: FakeCanvas[] = [];
    g.document = {
      createElement: (tag: string) => {
        expect(tag).toBe('canvas');
        const el = new FakeCanvas();
        created.push(el);
        return el;
      },
    };
    const { ctx } = paint(PAGE, 270);
    expect(created).toHaveLength(1);
    const el = created[0] as FakeCanvas;
    expect([el.width, el.height]).toEqual([4, 2]);
    expect(ctx.ops).toMatchObject([{ op: 'draw', source: el }]);
  });

  test('throws when the canvas has no 2d context', () => {
    const canvas = new FakeCanvas();
    canvas.ctx = null;
    expect(() =>
      paintToCanvas(PAGE, canvas as unknown as HTMLCanvasElement),
    ).toThrow('could not get a 2d canvas context');
  });

  test('throws when the scratch surface has no 2d context', () => {
    g.OffscreenCanvas = class extends FakeCanvas {
      override ctx = null;
    };
    expect(() => paint(PAGE, 90)).toThrow('could not get a 2d canvas context');
  });
});
