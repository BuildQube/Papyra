import {
  type Document,
  open,
  PasswordError,
  type SearchMatch,
} from '@build-qube/papyra';
import type { ViewMode } from '@/lib/pdf-zoom';

/** The open document, and the bytes it was opened from. */
export interface PdfDocumentSlice {
  /** The parsed PDF, with its render cache attached. */
  doc: Document;
  /**
   * The file's own bytes, when the store opened it.
   *
   * Optional because a caller may hand over an already-open `Document` and have no
   * bytes to give — {@link PdfViewerActions.setDocument} is exactly that case.
   */
  bytes?: Uint8Array;
  /** The file name, when one is known. Documents do not carry their own. */
  name?: string;
}

/** Every match found so far, and whichever one the viewer is showing. */
export interface PdfSearchSlice {
  /** Results in the order they were found — nearest page first. */
  matches: SearchMatch[];
  /** The match the page overlay draws in the active colour, if any. */
  active: SearchMatch | null;
}

/** A document that would not open without a password. */
export interface PdfPasswordRequest {
  /** The file to retry once a password is in hand. */
  file: File;
  /** A password was already tried and rejected — `PasswordError.retry`. */
  retry: boolean;
}

/**
 * Everything the viewer shares between panels.
 *
 * Each field is a slice whose reference changes only when its own contents change,
 * which is what makes the selector hooks cheap: a page change replaces `page` and
 * leaves `search` and `document` pointing at the same objects, so a component reading
 * only `search` never re-renders.
 */
export interface PdfViewerState {
  /** Null until a document opens. */
  document: PdfDocumentSlice | null;
  /** The current page, 0-based. */
  page: number;
  /** Search results, lifted so the page overlay and the result list agree. */
  search: PdfSearchSlice;
  /** The last load failure, if any. */
  error: string | null;
  /** Set while a document waits on a password, cleared when it opens. */
  password: PdfPasswordRequest | null;
  /**
   * Whether pages are shown one at a time or in a scrolling column.
   *
   * State rather than a prop on the view, so a toolbar toggle, a saved preference and
   * a deep link are all the same thing to whatever is rendering.
   */
  view: ViewMode;
}

/**
 * The store's writes. This object is created once and never replaced, so it is safe
 * to destructure in a component without a subscription or a dependency array.
 */
export interface PdfViewerActions {
  /**
   * Open a file, optionally with a password.
   *
   * A rejected or missing password does not throw: it sets `password` instead, which
   * is what lets one prompt both ask cold and say the last answer was wrong.
   */
  load(file: File, password?: string): Promise<void>;
  /**
   * Put an already-open document in.
   *
   * For callers that opened the PDF themselves — which is every block in this
   * registry, since opening a file is the application's job and not a viewer's.
   */
  setDocument(document: PdfDocumentSlice | null): void;
  /** Move to a page. Clamped to the open document. */
  setPage(index: number): void;
  /** Replace the search results. */
  setMatches(matches: SearchMatch[]): void;
  /** Set the highlighted match, or clear it. */
  setActive(match: SearchMatch | null): void;
  /** Set or clear the load error. */
  setError(message: string | null): void;
  /** Give up on a password prompt. */
  cancelPassword(): void;
  /** Switch between single-page and continuous. */
  setView(view: ViewMode): void;
}

/** Options for {@link createPdfViewerStore}. */
export interface PdfViewerStoreOptions {
  /** The view to start in. Defaults to `scroll`. */
  view?: ViewMode;
  /**
   * Renders in flight at once.
   *
   * A viewer wants a narrow pool: priority can only reorder work that has not
   * started, so a wide pool makes the visible page wait behind more in-flight
   * renders. Measured 5.2x faster to the visible page at 4 than at 18.
   */
  concurrency?: number;
}

/**
 * A subscribable store, deliberately not a React context value.
 *
 * A context holding this state would re-render every consumer on every change — with
 * a 400-page thumbnail strip mounted, a page change would walk the whole tree. Here
 * the context carries only the store itself, which never changes, and components
 * subscribe to the one slice they read.
 */
export interface PdfViewerStore {
  /** The current state. Stable between notifications. */
  getState(): PdfViewerState;
  /** Register for change notifications; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Stable for the life of the store. */
  readonly actions: PdfViewerActions;
}

/** Shared so an empty result set does not churn the slice reference. */
const EMPTY_SEARCH: PdfSearchSlice = { matches: [], active: null };

/**
 * Create a viewer store.
 *
 * Nothing about zoom lives here on purpose. A pinch changes the scale on every
 * animation frame, and a store notification per frame would re-render every
 * subscriber for a value only the page surface reads — `useZoom` keeps it local and
 * commits the settled value.
 */
export function createPdfViewerStore(
  options: PdfViewerStoreOptions = {},
): PdfViewerStore {
  const { concurrency = 4, view = 'scroll' } = options;

  let state: PdfViewerState = {
    document: null,
    page: 0,
    search: EMPTY_SEARCH,
    error: null,
    password: null,
    view,
  };

  const listeners = new Set<() => void>();

  function commit(next: PdfViewerState): void {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  }

  const actions: PdfViewerActions = {
    async load(file, password) {
      commit({ ...state, error: null });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const doc = await open(
          file,
          password === undefined ? { concurrency } : { concurrency, password },
        );
        commit({
          ...state,
          document: { doc, bytes, name: file.name },
          page: 0,
          search: EMPTY_SEARCH,
          password: null,
        });
      } catch (e) {
        // The one failure worth asking about rather than reporting. `retry` is what
        // separates "we never asked" from "the answer was wrong", and it is the whole
        // reason papyra throws two types here rather than one.
        if (e instanceof PasswordError) {
          commit({ ...state, password: { file, retry: e.retry } });
          return;
        }
        commit({ ...state, error: (e as Error).message });
      }
    },

    setDocument(document) {
      if (document === state.document) return;
      commit({
        ...state,
        document,
        page: 0,
        search: EMPTY_SEARCH,
        password: null,
      });
    },

    setPage(index) {
      const count = state.document?.doc.pageCount ?? 0;
      const next = count > 0 ? Math.min(Math.max(index, 0), count - 1) : 0;
      if (next === state.page) return;
      commit({ ...state, page: next });
    },

    setMatches(matches) {
      if (matches === state.search.matches) return;
      if (matches.length === 0 && state.search.matches.length === 0) return;
      commit({ ...state, search: { ...state.search, matches } });
    },

    setActive(active) {
      if (active === state.search.active) return;
      commit({ ...state, search: { ...state.search, active } });
    },

    setError(message) {
      if (message === state.error) return;
      commit({ ...state, error: message });
    },

    cancelPassword() {
      if (state.password === null) return;
      commit({ ...state, password: null });
    },

    setView(next) {
      if (next === state.view) return;
      commit({ ...state, view: next });
    },
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions,
  };
}
