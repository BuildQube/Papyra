/**
 * papyra — fast PDF rendering for Node and the browser, and spreadsheets and TIFF
 * scans beside it.
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

export * from './core.js';
export type { ImageHandle, SvgHandle } from './document.js';
export { Document, open } from './document.js';
export { encode, PageImage } from './encode.js';
export type { Runtime } from './runtime.js';
export {
  backend,
  currentRuntime,
  hardwareConcurrency,
  init,
} from './runtime.js';
export type {
  TiffCompression,
  TiffPage,
  TiffRenderOptions,
} from './tiff.js';
export { openTiff, TIFF_MAX_PIXELS, TiffImage } from './tiff.js';
export type {
  SheetInfo,
  SheetKind,
  SheetVisibility,
  WindowRange,
  WorkbookFormat,
  WorkbookOptions,
} from './workbook.js';
export { openWorkbook, Sheet, Workbook } from './workbook.js';
