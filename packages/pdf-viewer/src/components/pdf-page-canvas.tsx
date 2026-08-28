import { paintToCanvas, type RenderedPage } from '@build-qube/papyra';
import { useEffect, useRef } from 'react';

/** Props for {@link PageCanvas}. */
export interface PageCanvasProps {
  /** The bitmap to paint, or null to leave the canvas blank. */
  page: RenderedPage | null;
  /** Classes for the element itself. Layout only — the caller owns the box. */
  className?: string;
}

/**
 * Declarative canvas for small bitmaps.
 *
 * Fine for thumbnails, which are tens of kilobytes. The main viewport uses
 * `PageView` instead, because holding a multi-megabyte page in React state
 * costs hundreds of milliseconds per page change.
 */
export function PageCanvas({ page, className }: PageCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (ref.current && page) paintToCanvas(page, ref.current);
  }, [page]);

  return <canvas ref={ref} className={className} />;
}
