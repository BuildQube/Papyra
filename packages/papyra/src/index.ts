/**
 * papyra — fast PDF rendering for Node and the browser.
 *
 * ```ts
 * import { open, paintToCanvas } from '@build-qube/papyra';
 *
 * const doc = await open(file);                 // Uint8Array | Blob | File
 * const page = await doc.renderPage(0, { dpi: 150 });
 * paintToCanvas(page, canvas);
 * ```
 */

export { paintToCanvas, toImageData } from './canvas.js';
export { Document, open } from './document.js';
export type { Runtime } from './runtime.js';
export {
  backend,
  currentRuntime,
  hardwareConcurrency,
  init,
} from './runtime.js';
export type {
  OpenOptions,
  PageSize,
  PdfSource,
  RenderedPage,
  RenderOptions,
  StreamedPage,
  StreamOptions,
} from './types.js';
