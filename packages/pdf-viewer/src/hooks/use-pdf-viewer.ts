import { use, useSyncExternalStore } from 'react';
import { PdfViewerContext } from '@/components/pdf-viewer-provider';
import type {
  PdfDocumentSlice,
  PdfPasswordRequest,
  PdfSearchSlice,
  PdfViewerActions,
  PdfViewerState,
  PdfViewerStore,
} from '@/lib/pdf-viewer-store';

/**
 * The store itself.
 *
 * Subscribes to nothing. Reach for this only when you need to read state outside
 * render — an event handler, an effect — and use a selector hook otherwise.
 */
export function usePdfViewerStore(): PdfViewerStore {
  const store = use(PdfViewerContext);
  if (!store) throw new Error('usePdfViewerStore outside PdfViewerProvider');
  return store;
}

/**
 * Subscribe to one slice.
 *
 * `select` must return something already in the state — a slice object or a
 * primitive — never a derived object. React compares snapshots by `Object.is` and
 * warns if a fresh object comes back each call, and a selector that allocates would
 * re-render its component on every store change, which is the cost this whole
 * arrangement exists to avoid.
 */
function useSlice<T>(select: (state: PdfViewerState) => T): T {
  const store = usePdfViewerStore();
  const snapshot = () => select(store.getState());
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

/**
 * The store's writes.
 *
 * Stable for the life of the provider and free of any subscription, so a component
 * that only writes never re-renders when state changes.
 */
export function usePdfViewerActions(): PdfViewerActions {
  return usePdfViewerStore().actions;
}

/** The open document, or null. Re-renders only when the document changes. */
export function usePdfDocument(): PdfDocumentSlice | null {
  return useSlice((state) => state.document);
}

/**
 * The current page and a setter, 0-based.
 *
 * The setter comes from the actions object, so it is stable across renders and safe
 * in a dependency array.
 */
export function usePdfPage(): [number, (index: number) => void] {
  const page = useSlice((state) => state.page);
  return [page, usePdfViewerActions().setPage];
}

/** Search results and the active match. Re-renders only when search changes. */
export function usePdfSearch(): PdfSearchSlice {
  return useSlice((state) => state.search);
}

/** The last load failure, or null. */
export function usePdfError(): string | null {
  return useSlice((state) => state.error);
}

/** The pending password request, or null. */
export function usePdfPassword(): PdfPasswordRequest | null {
  return useSlice((state) => state.password);
}
