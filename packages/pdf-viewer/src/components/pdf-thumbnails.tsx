import type { Document, RenderedPage, Rotation } from '@build-qube/papyra';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PageCanvas } from '@/components/pdf-page-canvas';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { pageLabel, usePageLabels } from '@/hooks/use-pdf-page-labels';

/** Props for {@link Thumbnails}. */
export interface ThumbnailsProps {
  /** The open document. */
  doc: Document;
  /** The page on screen, 0-based. Its row is marked selected. */
  current: number;
  /** Called with a 0-based page index when the reader picks a page. */
  onSelect: (index: number) => void;
  /**
   * Tiles per row.
   *
   * Leave it out and the count follows the width: as many tiles of their rendered
   * size as fit, one at minimum. A picker grid sets it outright.
   */
  columns?: number;
  /**
   * Quarter turns clockwise to show tiles at, so the strip agrees with the page.
   *
   * Costs nothing: the same bitmap is repainted under a canvas transform, so turning
   * the view does not restream a 400-page document.
   */
  rotation?: Rotation;
  /** Classes for the scrolling container. */
  className?: string;
}

/** Thumbnails yield to the page on screen; the scheduler enforces it. */
const THUMB_PRIORITY = 2;

/**
 * Thumbnails are sized by output width, not DPI. At a fixed 36 DPI a 42x30in drawing
 * renders 1512x1080 (6.5 MB) per "thumbnail" — 44 of those is ~290 MB of buffers plus
 * as much again in canvases, which is enough to take the tab down.
 */
const THUMB_WIDTH = 160;

/** The grid's padding on each side, and the gap between tiles — `p-2` and `gap-2`. */
const GRID_INSET = 8;

/**
 * How many tiles of {@link THUMB_WIDTH} fit across a container, at least one.
 *
 * Adding columns rather than re-rendering wider is what keeps a resizable sidebar
 * and a full-width drawer cheap: the bitmap is the same 160px in either, and the
 * worst case is a single tile stretched to just under two widths. Re-rendering at
 * the container's width would be a cache miss across the document on every drag
 * pixel, for a picture nobody reads the text of.
 */
function columnsFor(width: number): number {
  return Math.max(
    1,
    Math.floor(
      (width - 2 * GRID_INSET + GRID_INSET) / (THUMB_WIDTH + GRID_INSET),
    ),
  );
}

/**
 * Streams thumbnails in, yielding each as it finishes rather than waiting for the
 * whole document. Rendering is abandoned if the document changes mid-stream.
 */
export function Thumbnails({
  doc,
  current,
  onSelect,
  columns,
  rotation = 0,
  className,
}: ThumbnailsProps) {
  const [thumbs, setThumbs] = useState<Map<number, RenderedPage>>(new Map());
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [fit, setFit] = useState(1);
  const root = useRef<HTMLDivElement>(null);
  const labels = usePageLabels(doc);

  // Only measured when the count is not given: a picker grid that says three
  // columns gets three, and pays for no observer.
  useLayoutEffect(() => {
    const el = root.current;
    if (columns !== undefined || !el) return;
    const measure = () => setFit(columnsFor(el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [columns]);

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
    <div ref={root} className={className}>
      <header className="sticky top-0 z-10 flex justify-between border-b bg-card px-2.5 py-2 text-xs">
        <span>{doc.pageCount} pages</span>
        {elapsed !== null && (
          <span className="text-muted-foreground">{elapsed.toFixed(0)}ms</span>
        )}
      </header>
      <ol
        className="grid gap-2 p-2"
        style={{
          gridTemplateColumns: `repeat(${columns ?? fit}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: doc.pageCount }, (_, i) => (
          // The list is `Array.from({ length: pageCount })` and never reorders,
          // so page 7 is the seventh item for the life of the document.
          // biome-ignore lint/suspicious/noArrayIndexKey: the index is the identity
          <li key={i}>
            <Button
              variant="ghost"
              data-active={i === current}
              className="h-auto w-full flex-col gap-1 p-1 text-xs text-muted-foreground data-[active=true]:text-foreground data-[active=true]:ring-2 data-[active=true]:ring-primary"
              onClick={() => onSelect(i)}
            >
              {thumbs.has(i) ? (
                <PageCanvas
                  page={thumbs.get(i) ?? null}
                  rotation={rotation}
                  className="block h-auto w-full rounded-xs bg-white"
                />
              ) : (
                // The aspect ratio is A4's, not this page's: it stands in only until
                // the render arrives with the real one, and guessing per page would
                // mean a `pageSize()` call per thumbnail to save one reflow.
                <Skeleton className="aspect-[1/1.414] w-full" />
              )}
              <span>{pageLabel(labels, i)}</span>
            </Button>
          </li>
        ))}
      </ol>
    </div>
  );
}
