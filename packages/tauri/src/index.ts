/**
 * Tauri engines for papyra's viewer: PDFs, TIFFs, spreadsheets, and Word and
 * PowerPoint parsed and rendered by papyra in the app's host process, through
 * `tauri-plugin-papyra` (and `tauri-plugin-papyra-office` for office files).
 *
 * ```tsx
 * import { TauriEngine, openTiff, openWorkbook } from '@build-qube/papyra-tauri';
 * import { PdfEngineProvider } from '@/components/pdf-engine';
 *
 * <PdfEngineProvider engine={new TauriEngine()}>{app}</PdfEngineProvider>
 * createFilePreview([tiffRenderer.with({ open: openTiff }), …]);
 * ```
 */
export {
  TauriEngine,
  type TauriEngineOptions,
  type TauriPageFormat,
} from './engine.js';
export { TauriOfficeEngine } from './office.js';
export { openTiff } from './tiff.js';
export { openWorkbook } from './workbook.js';
