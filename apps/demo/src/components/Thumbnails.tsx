import type { Document, RenderedPage } from '@build-qube/papyra';
import { useEffect, useState } from 'react';
import { PageCanvas } from './PageCanvas.js';

interface Props {
  doc: Document;
  current: number;
  onSelect: (index: number) => void;
}

/** Thumbnails yield to the page on screen; the scheduler enforces it. */
const THUMB_PRIORITY = 2;

/**
 * Thumbnails are sized by output width, not DPI. At a fixed 36 DPI a 42x30in drawing
 * renders 1512x1080 (6.5 MB) per "thumbnail" — 44 of those is ~290 MB of buffers plus
 * as much again in canvases, which is enough to take the tab down.
 */
const THUMB_WIDTH = 160;

/**
 * Streams thumbnails in, yielding each as it finishes rather than waiting for the
 * whole document. Rendering is abandoned if the document changes mid-stream.
 */
export function Thumbnails({ doc, current, onSelect }: Props) {
  const [thumbs, setThumbs] = useState<Map<number, RenderedPage>>(new Map());
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThumbs(new Map());
    setElapsed(null);
    const started = performance.now();

    (async () => {
      for await (const { page, bitmap } of doc.stream({
        fitWidth: THUMB_WIDTH,
        priority: THUMB_PRIORITY,
      })) {
        if (cancelled) return;
        setThumbs((prev) => new Map(prev).set(page, bitmap));
      }
      if (!cancelled) setElapsed(performance.now() - started);
    })();

    return () => {
      cancelled = true;
    };
  }, [doc]);

  return (
    // Rendered inside the sidebar's tab panel, which owns the scrolling.
    <div className="thumbs">
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
    </div>
  );
}
