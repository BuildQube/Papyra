import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentProvider } from './lib/document.js';
import { router } from './router.js';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');

if (!globalThis.crossOriginIsolated) {
  console.warn(
    'papyra: page is not cross-origin isolated — check the COOP/COEP headers in vite.config.ts',
  );
}

createRoot(el).render(
  <StrictMode>
    {/* Above the router on purpose: the open document — and its 128 MB render cache —
        must survive navigation between the viewer and the export view. */}
    <DocumentProvider>
      <RouterProvider router={router} />
    </DocumentProvider>
  </StrictMode>,
);
