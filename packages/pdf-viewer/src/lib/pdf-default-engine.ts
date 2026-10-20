import type { PdfEngine } from '@build-qube/papyra/core';
import { defaultPdfEngine } from '@build-qube/papyra/engine';

/**
 * The engine a viewer uses when no `PdfEngineProvider` is mounted: papyra's own.
 *
 * In a module of its own so an app that never runs papyra's engine can swap it at
 * build time. Naming `PapyraEngine` anywhere is enough for a bundler to emit its
 * 6 MB wasm chunk, fetched or not — so a Tauri app on `TauriEngine` aliases this
 * file to one that exports its own engine, and the wasm leaves its bundle. In Vite:
 *
 * ```ts
 * resolve: { alias: [{ find: /.*\/pdf-default-engine$/, replacement: '/src/pdf-engine.ts' }] }
 * ```
 *
 * where `/src/pdf-engine.ts` exports `fallbackPdfEngine`.
 */
export const fallbackPdfEngine: PdfEngine = defaultPdfEngine;
