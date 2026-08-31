import {
  type Document,
  paintToCanvas,
  type RenderHandle,
  type Rotation,
  type SearchMatch,
  viewport,
} from '@build-qube/papyra';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Highlights } from '@/components/pdf-highlights';
import { Links } from '@/components/pdf-links';
import { cn } from '@/lib/utils';

/** Props for {@link PageSurface}. */
export interface PageSurfaceProps {
  /** The open document. */
  doc: Document;
  /** The 0-based page this surface renders. */
  index: number;
  /** Where this page sits in the scrolled column, in CSS pixels. */
  top: number;
  /** Distance from the column's left edge, in CSS pixels. */
  left: number;
  /** Rendered width, in CSS pixels. */
  width: number;
  /** Rendered height, in CSS pixels. */
  height: number;
  /** Page width in PDF points, before rotation. */
  pageWidth: number;
  /** Page height in PDF points, before rotation. */
  pageHeight: number;
  /**
   * Quarter turns clockwise to show this page at.
   *
   * Applied when painting and when mapping the overlays, never when rendering: the
   * bitmap is upright whatever this says, so turning the view re-reads the render
   * cache instead of rasterising anything.
   */
  rotation: Rotation;
  /** Whether to draw the document's own annotations into the bitmap. */
  annotations: boolean;
  /** Device pixels to rasterise at, or 0 to stay a placeholder. */
  renderWidth: number;
  /** Lower runs first. Reassigned as the page moves through the viewport. */
  priority: number;
  /** Every match in the document; the ones on this page are drawn. */
  matches: readonly SearchMatch[];
  /** The match drawn in the active colour, if it is on this page. */
  active: SearchMatch | null;
  /** True when this is the page the viewer considers current, which outlines it. */
  current: boolean;
  /** Where an internal link goes. */
  onSelect: (index: number) => void;
}

/**
 * One page of the continuous view: a box of known size, a placeholder, and a canvas.
 *
 * The box is sized from `pageSize()` before anything renders, so the column has its
 * final geometry from the first frame — scrolling to page 400 does not have to wait
 * for pages 1-399 to rasterise, and nothing ever shifts under the pointer.
 *
 * Each surface owns its render job rather than the parent owning all of them. That is
 * what makes reprioritisation cheap: a page that scrolls into view calls `setPriority`
 * on work that is already queued instead of cancelling and resubmitting it, so the
 * queue keeps its place and coalescing still holds.
 */
export const PageSurface = memo(function PageSurface({
  doc,
  index,
  top,
  left,
  width,
  height,
  pageWidth,
  pageHeight,
  rotation,
  annotations,
  renderWidth,
  priority,
  matches,
  active,
  current,
  onSelect,
}: PageSurfaceProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const job = useRef<RenderHandle | null>(null);
  const [painted, setPainted] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (renderWidth <= 0) return;
    let dropped = false;
    let handle: RenderHandle;
    try {
      handle = doc.render(index, {
        fitWidth: renderWidth,
        priority,
        annotations,
      });
    } catch {
      // The pixel guard. `renderWidth` caps well below it, so this is belt and braces.
      return;
    }
    job.current = handle;
    setPending(!handle.cached);

    handle.promise
      .then((page) => {
        if (dropped || !canvas.current) return;
        paintToCanvas(page, canvas.current, { rotation });
        setPainted(true);
        setPending(false);
      })
      .catch(() => {
        if (!dropped) setPending(false);
      });

    return () => {
      dropped = true;
      job.current = null;
      handle.cancel('page left the render window');
    };
    // `priority` is deliberately absent: it is applied to the live job below rather
    // than resubmitting, which is the whole point of the handle.
    // `rotation` is a dependency even though it changes nothing about the render:
    // re-submitting hits papyra's cache and repaints, which costs nothing and avoids
    // holding a multi-megabyte bitmap per mounted surface just to turn it later.
  }, [doc, index, renderWidth, rotation, annotations]);

  useEffect(() => {
    job.current?.setPriority(priority);
  }, [priority]);

  const mine = useMemo(
    () => matches.filter((m) => m.page === index),
    [matches, index],
  );

  // Built from the CSS box rather than from the zoom, so the overlays land on the
  // pixels even while a pinch has the canvas stretched to a size nothing rendered at.
  const pageViewport = useMemo(
    () =>
      viewport(
        { width: pageWidth, height: pageHeight },
        { fitWidth: width, rotation },
      ),
    [pageWidth, pageHeight, width, rotation],
  );

  return (
    <div
      className={cn(
        'absolute bg-white shadow-[0_4px_18px_rgb(0_0_0/0.45)]',
        current && 'outline-2 outline-offset-1 outline-primary/55',
      )}
      style={{ top, left, width, height }}
    >
      <canvas ref={canvas} className="block size-full" hidden={!painted} />
      {!painted && (
        /*
         * A placeholder of exactly the right size, from `pageSize()`, before anything
         * has rendered. That is what lets the column be scrolled to the end
         * immediately: the geometry never depends on the pixels arriving.
         */
        <div
          className={cn(
            'grid size-full place-items-center border bg-card text-muted-foreground tabular-nums',
            pending && 'animate-pulse',
          )}
        >
          {index + 1}
        </div>
      )}
      {painted && pageWidth > 0 && (
        <Links
          doc={doc}
          index={index}
          pageViewport={pageViewport}
          onSelect={onSelect}
        />
      )}
      {painted && mine.length > 0 && pageWidth > 0 && (
        <Highlights
          matches={mine}
          active={active?.page === index ? active : null}
          pageViewport={pageViewport}
          width={width}
          height={height}
        />
      )}
    </div>
  );
});
