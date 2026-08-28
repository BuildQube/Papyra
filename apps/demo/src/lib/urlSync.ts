import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  usePdfDocument,
  usePdfPage,
  usePdfViewerActions,
} from '@workspace/pdf-viewer/hooks/use-pdf-viewer';
import { useEffect, useRef } from 'react';

/**
 * Keeps `?page=` and the store's page in step.
 *
 * The store is the source of truth and the URL is a projection of it — the reverse
 * would put a navigation in the path of every thumbnail click. This adapter is
 * deliberately *not* in `@workspace/pdf-viewer`: the store knows nothing about
 * routing, which is what lets the same components work under a different router or
 * none at all.
 *
 * `?page=` is 1-based because it is user-facing; everything internal is a 0-based
 * index. Navigation is `replace`, so clicking through a thumbnail strip does not bury
 * the back button under one history entry per page.
 */
export function usePageUrlSync(): void {
  const { page: param } = useSearch({ strict: false }) as { page?: number };
  const navigate = useNavigate();
  const [page, setPage] = usePdfPage();
  const doc = usePdfDocument();

  // What we last wrote, so the two effects below cannot answer each other forever.
  const settled = useRef<number | null>(null);

  const fromUrl = Math.max(0, (param ?? 1) - 1);

  useEffect(() => {
    if (!doc || fromUrl === page || settled.current === fromUrl) return;
    settled.current = fromUrl;
    setPage(fromUrl);
  }, [doc, fromUrl, page, setPage]);

  useEffect(() => {
    if (!doc || page === fromUrl) return;
    settled.current = page;
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, page: page + 1 }),
      replace: true,
    });
  }, [doc, page, fromUrl, navigate]);
}

/**
 * `?file=/some.pdf` opens without a file picker — handy for reproducing a specific
 * document, and for driving the demo from a script.
 */
export function useFileParam(url: string | undefined): void {
  const doc = usePdfDocument();
  const { load, setError } = usePdfViewerActions();

  useEffect(() => {
    if (!url || doc) return;
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
  }, [url, doc, load, setError]);
}
