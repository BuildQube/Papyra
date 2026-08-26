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
export { paintToCanvas, toImageData } from './canvas.js';
export type { RenderHandle } from './document.js';
export { Document, open } from './document.js';
export type {
  EncodedFormat,
  EncodedImage,
  EncodeOptions,
} from './encode.js';
export { encode, encodedImage, mimeType, PageImage } from './encode.js';
export type { Runtime } from './runtime.js';
export {
  backend,
  currentRuntime,
  hardwareConcurrency,
  init,
} from './runtime.js';
export type { JobHandle, JobTiming } from './scheduler.js';
export { AbortError, DEFAULT_PRIORITY } from './scheduler.js';
export type {
  OpenOptions,
  PageSize,
  PdfSource,
  RenderedPage,
  RenderOptions,
  StreamedPage,
  StreamOptions,
} from './types.js';
