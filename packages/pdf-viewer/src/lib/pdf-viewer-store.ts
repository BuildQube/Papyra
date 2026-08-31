import {
  type Document,
  open,
  PasswordError,
  type Quad,
  type Rotation,
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

/** The structure element the reader picked, and where its content sits. */
export interface PdfStructureSlice {
  /** Page the selected element's content is on, or null when nothing is selected. */
  page: number | null;
  /**
   * The selected element's content, one quadrilateral per line, in 72-DPI page space.
   *
   * Quads rather than rects for the reason the search overlay uses them: an element on
   * rotated text gets a box at the text's own angle instead of a smear across
   * everything near it.
   */
  quads: readonly Quad[];
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
  /**
   * The structure element being shown, lifted for the same reason search is: the
   * panel knows which element, and the page overlay is what draws it.
   */
  structure: PdfStructureSlice;
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
  /**
   * Quarter turns clockwise applied to every page on screen.
   *
   * Document-wide rather than per-page, matching every viewer a reader has used: a
   * sideways scan is sideways throughout, and turning one page of a report is not a
   * thing anyone asks for.
   *
   * Pages still render upright — this reaches the canvas as a paint-time transform and
   * the overlays as a coordinate mapping, so rotating costs no re-render.
   */
  rotation: Rotation;
  /**
   * Whether the document's own annotations are drawn into the page bitmap.
   *
   * On by default. Off is worth showing here because this viewer draws its own link
   * layer: with both on, a link's border comes from the PDF's appearance stream *and*
   * from the overlay, which is the double-draw the switch exists for.
   */
  annotations: boolean;
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
  /** Show a structure element's content on the page, or clear the selection. */
  setStructureSelection(page: number | null, quads: readonly Quad[]): void;
  /** Set or clear the load error. */
  setError(message: string | null): void;
  /** Give up on a password prompt. */
  cancelPassword(): void;
  /** Switch between single-page and continuous. */
  setView(view: ViewMode): void;
  /** Turn every page by a quarter, in either direction. Wraps at a full turn. */
  rotateBy(quarters: 1 | -1): void;
  /** Set the rotation outright — for a deep link, or a reset. */
  setRotation(rotation: Rotation): void;
  /** Draw the document's own annotations, or leave them to the overlay. */
  setAnnotations(on: boolean): void;
}

/** Options for {@link createPdfViewerStore}. */
export interface PdfViewerStoreOptions {
  /** The view to start in. Defaults to `scroll`. */
  view?: ViewMode;
  /** The rotation to start at. Defaults to upright. */
  rotation?: Rotation;
  /** Whether to draw the document's own annotations. Defaults to on. */
  annotations?: boolean;
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

/** Shared for the same reason as {@link EMPTY_SEARCH}. */
const EMPTY_STRUCTURE: PdfStructureSlice = { page: null, quads: [] };

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
  const {
    concurrency = 4,
    view = 'scroll',
    rotation = 0,
    annotations = true,
  } = options;

  let state: PdfViewerState = {
    document: null,
    page: 0,
    search: EMPTY_SEARCH,
    structure: EMPTY_STRUCTURE,
    error: null,
    password: null,
    view,
    rotation,
    annotations,
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
          structure: EMPTY_STRUCTURE,
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
        structure: EMPTY_STRUCTURE,
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

    setStructureSelection(page, quads) {
      // Collapse a clear onto the shared empty slice, so clearing twice — which
      // switching tabs does — notifies nobody the second time.
      if (page === null || quads.length === 0) {
        if (state.structure === EMPTY_STRUCTURE) return;
        commit({ ...state, structure: EMPTY_STRUCTURE });
        return;
      }
      commit({ ...state, structure: { page, quads } });
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

    rotateBy(quarters) {
      // Modulo twice: the first can be negative, and a rotation of -90 is not one of
      // the four the type admits.
      const next = (((state.rotation + quarters * 90) % 360) + 360) % 360;
      actions.setRotation(next as Rotation);
    },

    setRotation(next) {
      if (next === state.rotation) return;
      commit({ ...state, rotation: next });
    },

    setAnnotations(on) {
      if (on === state.annotations) return;
      commit({ ...state, annotations: on });
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
