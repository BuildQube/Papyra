import type { Document } from '@build-qube/papyra';
import { useEffect, useState } from 'react';

/**
 * The label printed on each page, or an empty array when the document has none.
 *
 * papyra memoises the walk per document, so every component that wants labels can
 * call this without coordinating — the second caller gets the first one's promise.
 */
export function usePageLabels(doc: Document | undefined): readonly string[] {
  const [labels, setLabels] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!doc) {
      setLabels([]);
      return;
    }
    let cancelled = false;
    setLabels([]);
    doc.pageLabels().then(
      (next) => !cancelled && setLabels(next),
      () => !cancelled && setLabels([]),
    );
    return () => {
      cancelled = true;
    };
  }, [doc]);

  return labels;
}

/**
 * What to show for a page: its label, falling back to the index.
 *
 * The fallback is the whole point of papyra returning an empty array rather than a
 * synthesised `1..n` — a document that defines no labels is asking for plain
 * numbering, and one that defines labels but skips a page gets an empty string, which
 * lands here too.
 */
export function pageLabel(labels: readonly string[], index: number): string {
  return labels[index] || String(index + 1);
}

/** True when the document numbers any page as something other than its index. */
export function labelsDiffer(labels: readonly string[]): boolean {
  return labels.some((label, i) => label !== '' && label !== String(i + 1));
}
