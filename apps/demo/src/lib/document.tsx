import { open, PasswordError, type SearchMatch } from '@build-qube/papyra';
import { type ReactNode, useCallback, useState } from 'react';
import {
  DocumentContext,
  type Loaded,
  type PasswordRequest,
} from './documentContext.js';

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
  const [password, setPassword] = useState<PasswordRequest | null>(null);

  const load = useCallback(async (file: File, secret?: string) => {
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // papyra takes the File directly; we keep the bytes for the benchmark panel.
      // A viewer wants a narrow pool: priority can only reorder work that has not
      // started, so a wide pool makes the visible page wait behind more in-flight
      // renders. Measured 5.2x faster to the visible page at 4 vs 1.1x at 18.
      const doc = await open(
        file,
        secret === undefined
          ? { concurrency: 4 }
          : { concurrency: 4, password: secret },
      );
      setPassword(null);
      setLoaded({ doc, bytes, name: file.name });
      setMatches([]);
      setActive(null);
    } catch (e) {
      // The one failure worth asking about rather than reporting. `retry` is what
      // separates "we never asked" from "the answer was wrong", and it is the whole
      // reason papyra throws two types here rather than one.
      if (e instanceof PasswordError) {
        setPassword({ file, retry: e.retry });
        return;
      }
      setError((e as Error).message);
    }
  }, []);

  const cancelPassword = useCallback(() => setPassword(null), []);

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
        password,
        cancelPassword,
      }}
    >
      {children}
    </DocumentContext>
  );
}
