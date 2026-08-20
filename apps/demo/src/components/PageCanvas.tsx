import { paintToCanvas, type RenderedPage } from '@build-qube/papyra';
import { useEffect, useRef } from 'react';

interface Props {
  page: RenderedPage | null;
  className?: string;
}

/**
 * Declarative canvas for small bitmaps.
 *
 * Fine for thumbnails, which are tens of kilobytes. The main viewport uses
 * {@link PageView} instead, because holding a multi-megabyte page in React state
 * costs hundreds of milliseconds per page change.
 */
export function PageCanvas({ page, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (ref.current && page) paintToCanvas(page, ref.current);
  }, [page]);

  return <canvas ref={ref} className={className} />;
}
