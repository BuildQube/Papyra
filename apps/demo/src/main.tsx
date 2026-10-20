import { defaultPdfEngine } from '@build-qube/papyra/core';
import { PdfjsEngine } from '@build-qube/papyra-pdfjs';
import { RouterProvider } from '@tanstack/react-router';
import { PdfEngineProvider } from '@workspace/pdf-viewer/components/pdf-engine';
import { PdfViewerProvider } from '@workspace/pdf-viewer/components/pdf-viewer-provider';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './components/theme-provider.js';
import { router } from './router.js';
import '@workspace/ui/globals.css';

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');

if (!globalThis.crossOriginIsolated) {
  console.warn(
    'papyra: page is not cross-origin isolated — check the COOP/COEP headers in vite.config.ts',
  );
}

/**
 * `?engine=pdfjs` runs every viewer on pdf.js instead of papyra, for comparing the
 * two on one document. Read once: a document belongs to the engine that opened it,
 * so the engine is fixed for the page's life, and changing it means a reload.
 */
const engine =
  new URLSearchParams(location.search).get('engine') === 'pdfjs'
    ? new PdfjsEngine({
        workerSrc: new URL(
          'pdfjs-dist/build/pdf.worker.mjs',
          import.meta.url,
        ).toString(),
      })
    : defaultPdfEngine;

createRoot(el).render(
  <StrictMode>
    {/* Dark by default, not `system`: this is a dark tool, and a page of white
        chrome around a white PDF loses the page edges entirely. */}
    <ThemeProvider defaultTheme="dark" storageKey="papyra-theme">
      {/* Above the router on purpose: the open document — and its 128 MB render cache —
          must survive navigation between the viewer and the export view. */}
      <PdfEngineProvider engine={engine}>
        <PdfViewerProvider view="page">
          <RouterProvider router={router} />
        </PdfViewerProvider>
      </PdfEngineProvider>
    </ThemeProvider>
  </StrictMode>,
);
