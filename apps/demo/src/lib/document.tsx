import { open, type SearchMatch } from '@build-qube/papyra';
import { type ReactNode, useCallback, useState } from 'react';
import { DocumentContext, type Loaded } from './documentContext.js';

/**
 * Holds the open document *above* the router.
 *
 * A `Document` is a parsed PDF with a 128 MB render cache attached. If it lived in a
 * route component, every navigation between the viewer and the export view would tear
 * it down and re-open the file — throwing away the cache that makes revisiting a page
 * ~50x faster, which is precisely the behaviour the demo exists to show.
 */
export function DocumentProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [active, setActive] = useState<SearchMatch | null>(null);

  const load = useCallback(async (file: File) => {
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // papyra takes the File directly; we keep the bytes for the benchmark panel.
      // A viewer wants a narrow pool: priority can only reorder work that has not
      // started, so a wide pool makes the visible page wait behind more in-flight
      // renders. Measured 5.2x faster to the visible page at 4 vs 1.1x at 18.
      const doc = await open(file, { concurrency: 4 });
      setLoaded({ doc, bytes, name: file.name });
      setMatches([]);
      setActive(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  return (
    <DocumentContext
      value={{
        loaded,
        error,
        load,
        setError,
        matches,
        setMatches,
        active,
        setActive,
      }}
    >
      {children}
    </DocumentContext>
  );
}
