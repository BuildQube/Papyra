import {
  paintToCanvas,
  type RenderedPage,
  type Rotation,
} from '@build-qube/papyra';
import type { CSSProperties } from 'react';
import { useImperativeHandle, useRef } from 'react';

/** What a paint cost, once the pixels were actually on screen. */
export interface PaintTiming {
  /** Time inside `putImageData`. */
  paintMs: number;
  /** `putImageData` done until the compositor showed the frame. */
  presentMs: number;
}

/**
 * The imperative side of {@link PageView}.
 *
 * Painting goes through a handle rather than a prop because a rendered page is
 * megabytes of RGBA: holding it in React state costs hundreds of milliseconds per
 * page change for a value nothing else reads.
 */
export interface PageViewHandle {
  /**
   * Paint immediately and report when the frame is actually on screen.
   *
   * `rotation` is applied by the canvas as it draws, so turning the page costs a
   * blit rather than a render.
   */
  paint(page: RenderedPage, rotation?: Rotation): Promise<PaintTiming>;
}

/** Props for {@link PageView}. */
export interface PageViewProps {
  /** Handed the imperative handle used to paint into this canvas. */
  ref: React.Ref<PageViewHandle>;
  /** Classes for the element itself. Layout only — the caller owns the box. */
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
export function PageView({ ref, className, style }: PageViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useImperativeHandle(ref, () => ({
    paint(page, rotation = 0) {
      const target = canvas.current;
      if (!target) {
        return Promise.resolve({ paintMs: 0, presentMs: 0 });
      }
      const started = performance.now();
      paintToCanvas(page, target, { rotation });
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
