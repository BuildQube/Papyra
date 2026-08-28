import {
  type Document,
  paintToCanvas,
  type RenderHandle,
  type SearchMatch,
} from '@build-qube/papyra';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Highlights } from './Highlights.js';
import { Links } from './Links.js';

interface Props {
  doc: Document;
  index: number;
  /** Where this page sits in the scrolled column, in CSS pixels. */
  top: number;
  left: number;
  width: number;
  height: number;
  /** Page width in PDF points, for placing highlights. */
  pageWidth: number;
  /** Device pixels to rasterise at, or 0 to stay a placeholder. */
  renderWidth: number;
  /** Lower runs first. Reassigned as the page moves through the viewport. */
  priority: number;
  matches: readonly SearchMatch[];
  active: SearchMatch | null;
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
  renderWidth,
  priority,
  matches,
  active,
  current,
  onSelect,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const job = useRef<RenderHandle | null>(null);
  const [painted, setPainted] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (renderWidth <= 0) return;
    let dropped = false;
    let handle: RenderHandle;
    try {
      handle = doc.render(index, { fitWidth: renderWidth, priority });
    } catch {
      // The pixel guard. `renderWidth` caps well below it, so this is belt and braces.
      return;
    }
    job.current = handle;
    setPending(!handle.cached);

    handle.promise
      .then((page) => {
        if (dropped || !canvas.current) return;
        paintToCanvas(page, canvas.current);
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
  }, [doc, index, renderWidth]);

  useEffect(() => {
    job.current?.setPriority(priority);
  }, [priority]);

  const mine = useMemo(
    () => matches.filter((m) => m.page === index),
    [matches, index],
  );

  return (
    <div
      className={current ? 'page-slot current' : 'page-slot'}
      style={{ top, left, width, height }}
    >
      <canvas ref={canvas} hidden={!painted} />
      {!painted && (
        <div className={pending ? 'page-blank pending' : 'page-blank'}>
          {index + 1}
        </div>
      )}
      {painted && pageWidth > 0 && (
        <Links
          doc={doc}
          index={index}
          scale={width / pageWidth}
          onSelect={onSelect}
        />
      )}
      {painted && mine.length > 0 && pageWidth > 0 && (
        <Highlights
          matches={mine}
          active={active?.page === index ? active : null}
          scale={width / pageWidth}
          width={width}
          height={height}
        />
      )}
    </div>
  );
});
