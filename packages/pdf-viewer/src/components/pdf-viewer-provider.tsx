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
  /** The tree that may read the store. */
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
  children,
  ...options
}: PdfViewerProviderProps) {
  // Lazily, and once: a store created in render would be replaced on every pass.
  // Every option goes through, not just `concurrency` — a block passing `view` or
  // `sidebar` and getting the default back is a bug that presents as "the prop does
  // nothing". A later change to a prop is ignored, deliberately: a store is not
  // rebuilt, and the render cache on its document with it, because a prop moved.
  const [fallback] = useState(() => createPdfViewerStore(options));

  return (
    <PdfViewerContext value={store ?? fallback}>{children}</PdfViewerContext>
  );
}
