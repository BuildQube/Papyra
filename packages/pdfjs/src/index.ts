/**
 * A pdf.js engine for papyra's viewer.
 *
 * ```tsx
 * import { PdfEngineProvider } from '@/components/pdf-engine';
 * import { defaultPdfEngine } from '@build-qube/papyra/core';
 * import { PdfjsEngine } from '@build-qube/papyra-pdfjs';
 *
 * <PdfEngineProvider engine={[defaultPdfEngine, new PdfjsEngine({ workerSrc })]}>
 * ```
 *
 * papyra's engine where the page is cross-origin isolated, pdf.js everywhere else.
 */
export {
  type Pdfjs,
  PdfjsEngine,
  type PdfjsEngineOptions,
} from './engine.js';
