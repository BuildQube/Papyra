import type { Quad, Rect } from './text.js';
import type { PageSize, RenderedPage } from './types.js';

/**
 * Quarter turns clockwise, applied on top of whatever the page's own `/Rotate` already
 * did.
 *
 * A viewer's rotate button, not a property of the document: papyra has already applied
 * `/Rotate` by the time you see a {@link PageSize} or a {@link PageText}, so this turns
 * the page relative to how it is meant to be read.
 */
export type Rotation = 0 | 90 | 180 | 270;

/** How to build a {@link Viewport}. Size it by `dpi` or by `fitWidth`, not both. */
export interface ViewportOptions {
  /** Dots per inch. 72 is the page's natural size. Defaults to 72. */
  dpi?: number;
  /**
   * Target output width in pixels, measured **after** rotation. Overrides `dpi`.
   *
   * This is the reason to size through a viewport rather than through
   * {@link RenderOptions.fitWidth} directly: at 90° the width on screen is the page's
   * height, so the two mean different things the moment the page is turned. Fitting a
   * column of viewport width is what a viewer actually wants, and
   * {@link Viewport.dpi} carries the answer back to the render call.
   */
  fitWidth?: number;
  /** Quarter turns clockwise. Defaults to none. */
  rotation?: Rotation;
}

/**
 * A page's mapping from PDF points to the pixels on screen: a scale, a rotation, and
 * the output size the two produce.
 *
 * papyra renders pages unrotated — the engine has no transform knob, and turning a
 * bitmap is a copy nobody needs when a canvas can do it in the paint call — so a
 * rotated view is a viewer-side construction. This is that construction, and it is the
 * one place the rotation is written down: {@link viewportRect} and
 * {@link viewportQuad} put link regions and text highlights in the same space as the
 * pixels {@link paintToCanvas} draws, and disagreeing about the angle is the whole
 * failure mode.
 *
 * @example
 * ```ts
 * const vp = viewport(doc.pageSize(0), { fitWidth: 1600, rotation: 90 });
 * const page = await doc.renderPage(0, { dpi: vp.dpi });
 * paintToCanvas(page, canvas, { rotation: vp.rotation });
 * for (const link of await doc.links(0)) {
 *   place(hitbox, viewportRect(link.rect, vp));
 * }
 * ```
 */
export interface Viewport {
  /**
   * Output width in pixels, after rotation.
   *
   * A whole number, and the same one the renderer arrives at: it floors a page's
   * scaled point size to get its pixmap, so a viewport that reported the fractional
   * value would be a pixel wider than the bitmap it describes about half the time.
   */
  readonly width: number;
  /** Output height in pixels, after rotation. Floored, as {@link width} is. */
  readonly height: number;
  /** Pixels per PDF point. `1` is 72 DPI. */
  readonly scale: number;
  /**
   * The DPI to render at. Pass straight to {@link RenderOptions.dpi}.
   *
   * Always describes the *unrotated* render, which is the only kind there is — the
   * rotation is applied when the bitmap is painted, not when it is produced.
   */
  readonly dpi: number;
  /** The rotation this viewport applies. */
  readonly rotation: Rotation;
  /** The page size it was built from, in points, before rotation. */
  readonly page: PageSize;
}

/** True when the rotation exchanges the page's width and height. */
function turned(rotation: Rotation): boolean {
  return rotation === 90 || rotation === 270;
}

/**
 * A page's dimensions after a rotation, still in points.
 *
 * The layout half of a rotated view, and separate from {@link viewport} because it is
 * needed *before* a scale exists: a viewer sizing its page boxes, or resolving a
 * fit-to-width against the turned page, is working in points and cannot use a
 * viewport's floored pixel dimensions without losing the fraction of a point that
 * decides a box's final rounding.
 *
 * Returns the same object when there is nothing to swap, so it is safe in a
 * dependency array.
 */
export function rotateSize(size: PageSize, rotation: Rotation): PageSize {
  return turned(rotation) ? { width: size.height, height: size.width } : size;
}

/**
 * Build a {@link Viewport} for a page.
 *
 * @example
 * ```ts
 * const vp = viewport(doc.pageSize(0), { fitWidth: 1600, rotation: 90 });
 * canvasEl.style.width = `${vp.width}px`;
 * canvasEl.style.height = `${vp.height}px`;
 * ```
 */
export function viewport(
  size: PageSize,
  options: ViewportOptions = {},
): Viewport {
  const rotation = options.rotation ?? 0;
  // `fitWidth` is measured on screen, so at 90° it constrains the page's height.
  const along = turned(rotation) ? size.height : size.width;
  const scale =
    options.fitWidth !== undefined && along > 0
      ? options.fitWidth / along
      : (options.dpi ?? 72) / 72;

  const shown = rotateSize(size, rotation);

  return {
    width: Math.floor(shown.width * scale),
    height: Math.floor(shown.height * scale),
    scale,
    dpi: scale * 72,
    rotation,
    page: size,
  };
}

/**
 * Map a point from 72-DPI page space into a viewport's pixels.
 *
 * Rotation happens in point space and the scale is applied after, so a rect and a quad
 * on the same page cannot drift apart by a rounding step.
 */
function project(
  x: number,
  y: number,
  vp: Viewport,
): { readonly x: number; readonly y: number } {
  const { width: w, height: h } = vp.page;
  switch (vp.rotation) {
    case 90:
      return { x: (h - y) * vp.scale, y: x * vp.scale };
    case 180:
      return { x: (w - x) * vp.scale, y: (h - y) * vp.scale };
    case 270:
      return { x: y * vp.scale, y: (w - x) * vp.scale };
    default:
      return { x: x * vp.scale, y: y * vp.scale };
  }
}

/**
 * Put a rect — a {@link PageLink.rect}, a {@link quadBounds} result — into a viewport's
 * pixels.
 *
 * Stays axis-aligned, because the rotations are quarter turns: only the corners swap
 * roles. Supersedes {@link scaleRect} for anything drawn over a rotated view;
 * `scaleRect` remains the cheaper call when the rotation is always zero.
 */
export function viewportRect(rect: Rect, vp: Viewport): Rect {
  const a = project(rect.x, rect.y, vp);
  const b = project(rect.x + rect.width, rect.y + rect.height, vp);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x, b.x) - x,
    height: Math.max(a.y, b.y) - y,
  };
}

/**
 * Put a {@link lineQuad} into a viewport's pixels.
 *
 * The corner order survives: rotating the page rotates the text with it, so the
 * quad's top-left is still the top-left of the text's own orientation. That is what
 * keeps a highlight on a drawing's vertical dimension label correct at every angle
 * rather than only at zero.
 */
export function viewportQuad(quad: Quad, vp: Viewport): Quad {
  const p0 = project(quad.x0, quad.y0, vp);
  const p1 = project(quad.x1, quad.y1, vp);
  const p2 = project(quad.x2, quad.y2, vp);
  const p3 = project(quad.x3, quad.y3, vp);
  return {
    x0: p0.x,
    y0: p0.y,
    x1: p1.x,
    y1: p1.y,
    x2: p2.x,
    y2: p2.y,
    x3: p3.x,
    y3: p3.y,
  };
}

/**
 * Turn a rendered page's pixels, returning a new {@link RenderedPage}.
 *
 * **Prefer {@link paintToCanvas} with a `rotation` in a browser** — a canvas rotates
 * in the draw call and this copies the whole buffer, which is 7 MB and a few tens of
 * milliseconds for a 1600px ARCH-E sheet. This exists for the paths that have no
 * canvas: writing a rotated PNG from Node, handing bytes to an encoder.
 *
 * A rotation of `0` returns the page unchanged rather than copying it.
 */
export function rotatePage(
  page: RenderedPage,
  rotation: Rotation,
): RenderedPage {
  if (rotation === 0) return page;

  const { width: w, height: h, stride } = page;
  const outW = turned(rotation) ? h : w;
  const outH = turned(rotation) ? w : h;
  const out = new Uint8Array(outW * outH * 4);

  // One 32-bit move per pixel instead of four 8-bit ones, when the views allow it. On
  // wasm `page.data` is a window onto shared linear memory at an arbitrary offset, and
  // `Uint32Array` refuses one that is not 4-byte aligned — hence the byte fallback
  // rather than an assumption.
  const aligned = page.data.byteOffset % 4 === 0 && stride % 4 === 0;
  const src32 = aligned
    ? new Uint32Array(page.data.buffer, page.data.byteOffset, (h * stride) / 4)
    : null;
  const dst32 = src32 ? new Uint32Array(out.buffer) : null;
  const srcRow = stride / 4;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Where this source pixel lands, per quarter turn clockwise.
      const dx = rotation === 90 ? h - 1 - y : rotation === 180 ? w - 1 - x : y;
      const dy = rotation === 90 ? x : rotation === 180 ? h - 1 - y : w - 1 - x;

      if (src32 && dst32) {
        dst32[dy * outW + dx] = src32[y * srcRow + x] as number;
      } else {
        const s = y * stride + x * 4;
        const d = (dy * outW + dx) * 4;
        out[d] = page.data[s] as number;
        out[d + 1] = page.data[s + 1] as number;
        out[d + 2] = page.data[s + 2] as number;
        out[d + 3] = page.data[s + 3] as number;
      }
    }
  }

  return {
    width: outW,
    height: outH,
    stride: outW * 4,
    format: page.format,
    data: out,
  };
}
