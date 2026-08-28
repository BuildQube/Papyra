import type { Document } from '@build-qube/papyra';
import { open } from '@build-qube/papyra';
import { usePdfDocument } from '@workspace/pdf-viewer/hooks/use-pdf-viewer';
import { useEffect, useState } from 'react';

/**
 * One shared open of the sample, however many previews ask for it.
 *
 * A `Document` carries a render cache, and opening the same three pages once per
 * block would pay for that cache several times over for no benefit. Module scope
 * rather than a ref: the previews mount and unmount as they scroll past.
 */
let sample: Promise<Document> | null = null;

function openSample(base: string): Promise<Document> {
  sample ??= fetch(`${base}sample.pdf`)
    .then((res) => res.arrayBuffer())
    .then((bytes) => open(new Uint8Array(bytes), { concurrency: 2 }))
    .catch((e: unknown) => {
      // Let the next preview try again rather than caching the failure forever.
      sample = null;
      throw e;
    });
  return sample;
}

/**
 * The document a preview should render.
 *
 * Whatever the reader already has open, if anything — browsing the registry with your
 * own document in it beats browsing it with ours — and the bundled sample otherwise,
 * so the page works on a cold visit.
 */
export function usePreviewDocument(): Document | null {
  const loaded = usePdfDocument();
  const [fallback, setFallback] = useState<Document | null>(null);

  useEffect(() => {
    if (loaded) return;
    let live = true;
    void openSample(import.meta.env.BASE_URL).then(
      (doc) => live && setFallback(doc),
      () => {
        /* The preview stays empty; the props table is the point of the page. */
      },
    );
    return () => {
      live = false;
    };
  }, [loaded]);

  return loaded?.doc ?? fallback;
}
