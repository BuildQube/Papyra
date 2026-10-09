/**
 * Drawing and page geometry, without an engine.
 *
 * Everything here is plain TypeScript over a page that has already been rendered:
 * painting a bitmap to a canvas, and mapping sizes, rects and quads through a zoom
 * and a rotation. The main entry exports all of it too, but importing that loads the
 * PDF engine — a wasm module of about 2.5 MB in a browser — which a viewer for an
 * office document or a TIFF has no use for. Import from here in code that only draws
 * pages, and the PDF engine is fetched only by code that opens a PDF.
 *
 * @module
 */

export type { PaintOptions } from './canvas.js';
export { paintToCanvas, toImageData } from './canvas.js';
export type { SearchMatch } from './search.js';
export type { Quad, Rect } from './text.js';
export type {
  PageSize,
  PageSource,
  RenderedPage,
  RenderHandle,
  RenderOptions,
} from './types.js';
export type { Rotation, Viewport, ViewportOptions } from './viewport.js';
export {
  rotatePage,
  rotateSize,
  viewport,
  viewportQuad,
  viewportRect,
} from './viewport.js';
