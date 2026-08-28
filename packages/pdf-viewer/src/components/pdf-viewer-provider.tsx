import { createContext, type ReactNode, useState } from 'react';
import {
  createPdfViewerStore,
  type PdfViewerStore,
  type PdfViewerStoreOptions,
} from '@/lib/pdf-viewer-store';

/**
 * Carries the store, never the state.
 *
 * Because the value is the store object and that object never changes, this context
 * never re-renders anything. All the granularity lives in the selector hooks.
 */
export const PdfViewerContext = createContext<PdfViewerStore | null>(null);

/** Props for {@link PdfViewerProvider}. */
export interface PdfViewerProviderProps extends PdfViewerStoreOptions {
  /**
   * An existing store, if the caller wants to own it — to drive it from outside
   * React, to share it between two trees, or to seed it in a test.
   */
  store?: PdfViewerStore;
  children: ReactNode;
}

/**
 * Puts a viewer store in scope.
 *
 * Mount it *above* whatever routing the app has. A `Document` is a parsed PDF with a
 * render cache attached, so a provider inside a route would tear it down on every
 * navigation and re-open the file — throwing away the cache that makes revisiting a
 * page roughly 50x faster.
 */
export function PdfViewerProvider({
  store,
  concurrency,
  children,
}: PdfViewerProviderProps) {
  // Lazily, and once: a store created in render would be replaced on every pass.
  const [fallback] = useState(() => createPdfViewerStore({ concurrency }));

  return (
    <PdfViewerContext value={store ?? fallback}>{children}</PdfViewerContext>
  );
}
