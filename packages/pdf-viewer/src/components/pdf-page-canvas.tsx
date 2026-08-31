import {
  paintToCanvas,
  type RenderedPage,
  type Rotation,
} from '@build-qube/papyra';
import { useEffect, useRef } from 'react';

/** Props for {@link PageCanvas}. */
export interface PageCanvasProps {
  /** The bitmap to paint, or null to leave the canvas blank. */
  page: RenderedPage | null;
  /** Classes for the element itself. Layout only — the caller owns the box. */
  className?: string;
  /**
   * Quarter turns clockwise to paint at. Defaults to upright.
   *
   * A thumbnail strip passes the viewer's rotation so the sidebar agrees with the
   * page on screen; the same bitmap serves both, since the turn happens in the draw.
   */
  rotation?: Rotation;
}

/**
 * Declarative canvas for small bitmaps.
 *
 * Fine for thumbnails, which are tens of kilobytes. The main viewport uses
 * `PageView` instead, because holding a multi-megabyte page in React state
 * costs hundreds of milliseconds per page change.
 */
export function PageCanvas({ page, className, rotation = 0 }: PageCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (ref.current && page) paintToCanvas(page, ref.current, { rotation });
  }, [page, rotation]);

  return <canvas ref={ref} className={className} />;
}
