import type { RenderedPage } from './types.js';
import type { Rotation } from './viewport.js';

/**
 * Both canvas flavours. Spelled out at {@link paintToCanvas}'s signature rather than
 * used there: an alias only this module exports would appear in the reference as a
 * type nobody can import.
 */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Wrap a rendered page as `ImageData`, ready for `putImageData`.
 *
 * This copies. It has to: on the wasm build the pixels live in the module's shared
 * linear memory, and `ImageData` refuses a `SharedArrayBuffer`-backed view. Copying
 * unconditionally keeps both runtimes on the same path.
 */
export function toImageData(page: RenderedPage): ImageData {
  return new ImageData(
    Uint8ClampedArray.from(page.data),
    page.width,
    page.height,
  );
}

/** How to paint. */
export interface PaintOptions {
  /**
   * Quarter turns clockwise to apply while drawing. Defaults to none.
   *
   * Free in the sense that matters: the pixels are not copied twice and no rotated
   * bitmap is retained. Pair it with a {@link Viewport} of the same rotation so that
   * link regions and text highlights land on the same page the pixels do.
   */
  rotation?: Rotation;
}

/**
 * Paint a rendered page onto a canvas, resizing the canvas to match.
 *
 * With a `rotation` the canvas takes the turned dimensions — a 90° view of a portrait
 * page is a landscape canvas.
 *
 * @example
 * ```ts
 * const vp = viewport(doc.pageSize(0), { fitWidth: 1600, rotation: 90 });
 * paintToCanvas(await doc.renderPage(0, { dpi: vp.dpi }), canvas, {
 *   rotation: vp.rotation,
 * });
 * ```
 */
export function paintToCanvas(
  page: RenderedPage,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: PaintOptions = {},
): void {
  const rotation = options.rotation ?? 0;
  const turned = rotation === 90 || rotation === 270;
  canvas.width = turned ? page.height : page.width;
  canvas.height = turned ? page.width : page.height;

  const ctx = canvas.getContext('2d') as AnyContext | null;
  if (!ctx) throw new Error('papyra: could not get a 2d canvas context');

  if (rotation === 0) {
    ctx.putImageData(toImageData(page), 0, 0);
    return;
  }

  // `putImageData` writes straight to the backing store and ignores the transform, so
  // a rotation cannot go through it. The pixels land on a scratch surface first and
  // are then blitted under a transform, which is one extra copy — against rotating
  // the buffer ourselves, which is a copy plus a per-pixel loop in JS.
  const scratch = scratchCanvas(page.width, page.height);
  const scratchCtx = scratch.getContext('2d') as AnyContext | null;
  if (!scratchCtx) throw new Error('papyra: could not get a 2d canvas context');
  scratchCtx.putImageData(toImageData(page), 0, 0);

  // Each pair puts the rotated page's origin back at the canvas corner: at 90° the
  // page's top-left corner ends up top-right, so the axes move there first.
  if (rotation === 90) ctx.translate(canvas.width, 0);
  else if (rotation === 180) ctx.translate(canvas.width, canvas.height);
  else ctx.translate(0, canvas.height);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(scratch as CanvasImageSource, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * A surface to hold the unrotated pixels.
 *
 * `OffscreenCanvas` when there is one — it is the only option inside a worker, where
 * there is no `document` to create an element from.
 */
function scratchCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  return el;
}
