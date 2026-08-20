import type { Document, RenderedPage } from '@build-qube/papyra';
import { useEffect, useState } from 'react';
import { PageCanvas } from './PageCanvas.js';

interface Props {
  doc: Document;
  current: number;
  onSelect: (index: number) => void;
  /**
   * Hold off until the visible page is on screen. Thumbnails and the main page share
   * one render pool, so starting them together makes the page the user is actually
   * looking at queue behind every thumbnail.
   */
  enabled: boolean;
}

const THUMB_DPI = 36;

/**
 * Streams thumbnails in, yielding each as it finishes rather than waiting for the
 * whole document. Rendering is abandoned if the document changes mid-stream.
 */
export function Thumbnails({ doc, current, onSelect, enabled }: Props) {
  const [thumbs, setThumbs] = useState<Map<number, RenderedPage>>(new Map());
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setThumbs(new Map());
    setElapsed(null);
    const started = performance.now();

    (async () => {
      for await (const { page, bitmap } of doc.stream({ dpi: THUMB_DPI })) {
        if (cancelled) return;
        setThumbs((prev) => new Map(prev).set(page, bitmap));
      }
      if (!cancelled) setElapsed(performance.now() - started);
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, enabled]);

  return (
    <aside className="thumbs">
      <header>
        <span>{doc.pageCount} pages</span>
        {elapsed !== null && (
          <span className="muted">{elapsed.toFixed(0)}ms</span>
        )}
      </header>
      <ol>
        {Array.from({ length: doc.pageCount }, (_, i) => (
          // The index is the page number: this list is never reordered, filtered, or
          // inserted into, so the index is the stable identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: index is the page identity
          <li key={i}>
            <button
              type="button"
              className={i === current ? 'thumb selected' : 'thumb'}
              onClick={() => onSelect(i)}
            >
              {thumbs.has(i) ? (
                <PageCanvas page={thumbs.get(i) ?? null} />
              ) : (
                <div className="placeholder" />
              )}
              <span>{i + 1}</span>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}
