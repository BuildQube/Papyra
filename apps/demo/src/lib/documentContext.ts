import type { Document, SearchMatch } from '@build-qube/papyra';
import { createContext, use, useEffect } from 'react';

export interface Loaded {
  doc: Document;
  /** Kept for the benchmark panel, which re-opens the bytes under pdf.js too. */
  bytes: Uint8Array;
  name: string;
}

/** A document that would not open without a password. */
export interface PasswordRequest {
  file: File;
  /** A password was already tried and rejected — `PasswordError.retry`. */
  retry: boolean;
}

export interface DocumentState {
  loaded: Loaded | null;
  error: string | null;
  /** Pass a password to retry a document that asked for one. */
  load: (file: File, password?: string) => Promise<void>;
  setError: (message: string | null) => void;
  /** Set while a document is waiting on a password, cleared when it opens. */
  password: PasswordRequest | null;
  cancelPassword: () => void;
  /**
   * Search results live here, not in a route, for the same reason the document does:
   * running a search and then flipping to the export view should not discard it.
   */
  matches: SearchMatch[];
  setMatches: (matches: SearchMatch[]) => void;
  active: SearchMatch | null;
  setActive: (match: SearchMatch | null) => void;
}

export const DocumentContext = createContext<DocumentState | null>(null);

export function useDocument(): DocumentState {
  const ctx = use(DocumentContext);
  if (!ctx) throw new Error('useDocument outside DocumentProvider');
  return ctx;
}

/**
 * `?file=/some.pdf` opens without a file picker — handy for reproducing a specific
 * document, and for driving the demo from a script.
 */
export function useFileParam(url: string | undefined): void {
  const { loaded, load, setError } = useDocument();

  useEffect(() => {
    if (!url || loaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        if (cancelled) return;
        await load(new File([blob], url.split('/').pop() ?? 'document.pdf'));
      } catch (e) {
        if (!cancelled)
          setError(`could not load ${url}: ${(e as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, loaded, load, setError]);
}
