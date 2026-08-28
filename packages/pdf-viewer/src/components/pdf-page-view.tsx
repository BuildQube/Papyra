import { paintToCanvas, type RenderedPage } from '@build-qube/papyra';
import type { CSSProperties } from 'react';
import { useImperativeHandle, useRef } from 'react';

export interface PageViewHandle {
  /** Paint immediately and report when the frame is actually on screen. */
  paint(page: RenderedPage): Promise<{ paintMs: number; presentMs: number }>;
}

interface Props {
  ref: React.Ref<PageViewHandle>;
  className?: string;
  /**
   * The CSS box the page occupies, which zoom sets and the bitmap does not.
   *
   * Keeping the two apart is what makes a pinch feel instant: the box follows the
   * gesture every frame while the canvas keeps whatever it last rendered, stretched
   * to fit, until the gesture settles and a sharp bitmap replaces it.
   */
  style?: CSSProperties;
}

/**
 * Painted imperatively, on purpose.
 *
 * A rendered page is megabytes of pixels — 11.4 MB for a 2000px-wide ARCH-E sheet.
 * Putting that in React state means every page change allocates a new multi-megabyte
 * buffer, holds it across a render pass, and drops the previous one, which showed up
 * as hundreds of milliseconds between the render resolving and the paint effect
 * running. Painting straight to the canvas lets the buffer die immediately.
 */
export function PageView({ ref, className, style }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useImperativeHandle(ref, () => ({
    paint(page) {
      const target = canvas.current;
      if (!target) {
        return Promise.resolve({ paintMs: 0, presentMs: 0 });
      }
      const started = performance.now();
      paintToCanvas(page, target);
      const painted = performance.now();
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() =>
            resolve({
              paintMs: painted - started,
              presentMs: performance.now() - painted,
            }),
          );
        });
      });
    },
  }));

  return <canvas ref={canvas} className={className} style={style} />;
}
