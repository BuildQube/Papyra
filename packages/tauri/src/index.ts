/**
 * A Tauri engine for papyra's viewer: PDFs parsed and rendered by papyra in the
 * app's host process, through `tauri-plugin-papyra`.
 *
 * ```tsx
 * import { TauriEngine } from '@build-qube/papyra-tauri';
 * import { PdfEngineProvider } from '@/components/pdf-engine';
 *
 * <PdfEngineProvider engine={new TauriEngine()}>{app}</PdfEngineProvider>
 * ```
 */
export {
  TauriEngine,
  type TauriEngineOptions,
  type TauriPageFormat,
} from './engine.js';
