import type { RenderedPage } from './types.js';

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

/** Paint a rendered page onto a canvas, resizing the canvas to match. */
export function paintToCanvas(
  page: RenderedPage,
  canvas: HTMLCanvasElement | OffscreenCanvas,
): void {
  canvas.width = page.width;
  canvas.height = page.height;
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('papyra: could not get a 2d canvas context');
  ctx.putImageData(toImageData(page), 0, 0);
}
