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

export type { Attachment } from './attachments.js';
export {
  attachmentMediaType,
  isInvoiceAttachment,
} from './attachments.js';
export type { CacheStats } from './cache.js';
export type { PaintOptions } from './canvas.js';
export { paintToCanvas, toImageData } from './canvas.js';
export type {
  BoolCell,
  Cell,
  CellKind,
  DateCell,
  DurationCell,
  EmptyCell,
  ErrorCell,
  MergedRange,
  NumberCell,
  TextCell,
} from './cells.js';
export { CellWindow, columnName } from './cells.js';
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
  EncryptedWorkbookError,
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
export type {
  BorderEdge,
  BorderStyle,
  CellStyle,
  ColumnSpan,
  HorizontalAlign,
  RowSize,
  SheetLayout,
  VerticalAlign,
} from './styles.js';
export { cssColor } from './styles.js';
export type { PageText, Quad, Rect, TextLine } from './text.js';
export {
  lineQuad,
  pageString,
  quadBounds,
  scaleQuad,
  scaleRect,
} from './text.js';
export type {
  TiffCompression,
  TiffPage,
  TiffRenderOptions,
} from './tiff.js';
export { openTiff, TIFF_MAX_PIXELS, TiffImage } from './tiff.js';
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
export type {
  SheetInfo,
  SheetKind,
  SheetVisibility,
  WindowRange,
  WorkbookFormat,
  WorkbookOptions,
} from './workbook.js';
export { openWorkbook, Sheet, Workbook } from './workbook.js';
