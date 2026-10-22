/**
 * Everything in papyra that runs without its engine.
 *
 * Painting a rendered bitmap, page geometry, search over extracted text, outline and
 * structure trees, the priority queue, the error types, and {@link PagedEngine} and
 * {@link PdfEngine} to build an engine on. papyra's own engine is not here but in
 * `@build-qube/papyra/engine`.
 *
 * The main entry exports all of it too, but importing that loads the engine — on a
 * browser, a wasm module of about 2.5 MB that needs a cross-origin-isolated page to
 * start. Code that only draws pages, or that will hand the opening to another engine,
 * imports from here.
 *
 * Nothing in this module's graph may reach `@build-qube/papyra-native` at all, not
 * even through `import()`: a bundler emits the 6 MB wasm as soon as its graph reaches
 * the loader, whether or not tree-shaking later drops the code that would fetch it.
 * So an app whose viewer runs on another engine ships no wasm. `test/unit/core.test.ts`
 * walks the graph and fails if anything does.
 *
 * @module
 */

export type { Attachment } from './attachments.js';
export {
  attachmentMediaType,
  isInvoiceAttachment,
  toAttachment,
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
export type {
  EncodedFormat,
  EncodedImage,
  EncodeOptions,
  RasterFormat,
  SvgPage,
} from './encoded.js';
export { encodedImage, mimeType, svgPage } from './encoded.js';
export type {
  Availability,
  BackendRenderOptions,
  Capabilities,
  PagedBackend,
  PagedDoc,
  PdfBackend,
  PdfDoc,
} from './engine.js';
export { PagedEngine, PdfEngine, RENDER_ONLY } from './engine.js';
export {
  EncryptedWorkbookError,
  IncorrectPasswordError,
  PasswordError,
  PasswordRequiredError,
  rethrowLoadError,
} from './errors.js';
export { fingerprint } from './fingerprint.js';
export type { LinkTarget, PageLink } from './links.js';
export { toPageLink } from './links.js';
export type {
  DestinationKind,
  OutlineDestination,
  OutlineNode,
} from './outline.js';
export { buildOutlineTree, walkOutline } from './outline.js';
export type { JobHandle, JobTiming } from './scheduler.js';
export { AbortError, DEFAULT_PRIORITY } from './scheduler.js';
export type { MatchOptions, SearchMatch } from './search.js';
export { findRanges, searchPageText } from './search.js';
export { toBytes } from './source.js';
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
export type {
  SheetInfo,
  SheetKind,
  SheetSource,
  SheetVisibility,
  WindowRange,
  WorkbookFormat,
  WorkbookOptions,
  WorkbookSource,
} from './sheets.js';
export { openWorkbookWith, Sheet, Workbook } from './sheets.js';
export type { PageText, Quad, Rect, TextLine } from './text.js';
export {
  lineQuad,
  pageString,
  quadBounds,
  scaleQuad,
  scaleRect,
  toPageText,
} from './text.js';
export type {
  TiffCompression,
  TiffPage,
  TiffRenderOptions,
  TiffSource,
} from './tiff-image.js';
export { TIFF_MAX_PIXELS, TiffImage } from './tiff-image.js';
export type {
  DocumentMetadata,
  OpenOptions,
  PageBitmap,
  PageSize,
  PdfSource,
  RenderedPage,
  RenderHandle,
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
