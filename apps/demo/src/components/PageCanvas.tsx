import { paintToCanvas, type RenderedPage } from '@build-qube/papyra';
import { useEffect, useRef } from 'react';

interface Props {
  page: RenderedPage | null;
  className?: string;
}

export function PageCanvas({ page, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (ref.current && page) paintToCanvas(page, ref.current);
  }, [page]);

  return <canvas ref={ref} className={className} />;
}
