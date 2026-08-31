/**
 * papyra — fast PDF rendering for Node and the browser.
 *
 * ```ts
 * import { open, paintToCanvas } from '@build-qube/papyra';
 *
 * const doc = await open(file);                 // Uint8Array | Blob | File
 * const page = await doc.renderPage(0, { fitWidth: 1600 });
 * paintToCanvas(page, canvas);
 *
 * // Viewers: attach your own priorities. Lower runs first; the default is urgent.
 * const job = doc.render(3, { fitWidth: 1600, priority: 2 });
 * onScroll(() => job.setPriority(0));
 * ```
 */

export type { CacheStats } from './cache.js';
export type { PaintOptions } from './canvas.js';
export { paintToCanvas, toImageData } from './canvas.js';
export type { ImageHandle, RenderHandle, SvgHandle } from './document.js';
export { Document, open } from './document.js';
export type {
  EncodedFormat,
  EncodedImage,
  EncodeOptions,
  RasterFormat,
  SvgPage,
} from './encode.js';
export {
  encode,
  encodedImage,
  mimeType,
  PageImage,
  svgPage,
} from './encode.js';
export {
  IncorrectPasswordError,
  PasswordError,
  PasswordRequiredError,
} from './errors.js';
export type { LinkTarget, PageLink } from './links.js';
export type {
  DestinationKind,
  OutlineDestination,
  OutlineNode,
} from './outline.js';
export { buildOutlineTree, walkOutline } from './outline.js';
export type { Runtime } from './runtime.js';
export {
  backend,
  currentRuntime,
  hardwareConcurrency,
  init,
} from './runtime.js';
export type { JobHandle, JobTiming } from './scheduler.js';
export { AbortError, DEFAULT_PRIORITY } from './scheduler.js';
export type { MatchOptions, SearchMatch } from './search.js';
export { findRanges, searchPageText } from './search.js';
export type {
  MarkedContent,
  OrderedLine,
  StructNode,
} from './structure.js';
export {
  buildStructTree,
  readingOrder,
  structuredPageString,
  walkStructTree,
} from './structure.js';
export type { PageText, Quad, Rect, TextLine } from './text.js';
export {
  lineQuad,
  pageString,
  quadBounds,
  scaleQuad,
  scaleRect,
} from './text.js';
export type {
  DocumentMetadata,
  OpenOptions,
  PageSize,
  PdfSource,
  RenderedPage,
  RenderOptions,
  SearchOptions,
  StreamedPage,
  StreamOptions,
  SvgOptions,
} from './types.js';
export type { Rotation, Viewport, ViewportOptions } from './viewport.js';
export {
  rotatePage,
  rotateSize,
  viewport,
  viewportQuad,
  viewportRect,
} from './viewport.js';
