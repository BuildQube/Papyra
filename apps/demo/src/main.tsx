import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './components/theme-provider.js';
import { DocumentProvider } from './lib/document.js';
import { router } from './router.js';
// Tailwind first, `styles.css` second, and the order is load-bearing while the
// migration to shadcn is in flight: preflight lands in `@layer base`, and unlayered
// CSS beats layered CSS whatever the specificity, so every rule still in
// `styles.css` keeps winning over the reset until its component has moved.
import '@workspace/ui/globals.css';
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
    {/* Dark by default, not `system`: this is a dark tool, and a page of white
        chrome around a white PDF loses the page edges entirely. */}
    <ThemeProvider defaultTheme="dark" storageKey="papyra-theme">
      {/* Above the router on purpose: the open document — and its 128 MB render cache —
          must survive navigation between the viewer and the export view. */}
      <DocumentProvider>
        <RouterProvider router={router} />
      </DocumentProvider>
    </ThemeProvider>
  </StrictMode>,
);
