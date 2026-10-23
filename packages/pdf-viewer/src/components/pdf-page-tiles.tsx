import {
  type PageBitmap,
  type PagedDoc,
  paintToCanvas,
  type RenderHandle,
  type Rotation,
  rotateSize,
} from '@build-qube/papyra/core';
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { usePageEngine } from '@/components/pdf-engine';
import {
  type Box,
  type TileSlot,
  tileSlots,
  uprightBox,
  uprightTransform,
} from '@/lib/viewer-zoom';

/** Props for {@link PageTiles}. */
export interface PageTilesProps {
  /** The open document. Nothing is drawn unless its capabilities include `tiles`. */
  doc: PagedDoc;
  /** The 0-based page to tile. */
  index: number;
  /** The page box's width, in CSS pixels, after rotation. */
  width: number;
  /** The page box's height, in CSS pixels, after rotation. */
  height: number;
  /** Page width in PDF points, before rotation. */
  pageWidth: number;
  /** Page height in PDF points, before rotation. */
  pageHeight: number;
  /** Quarter turns clockwise the page box is shown at. */
  rotation: Rotation;
  /** Whether to draw the document's own annotations into the tiles. */
  annotations: boolean;
  /**
   * DPI to lay tiles at, from `tileDpi`, or 0 for none. Past the bitmap's pixel cap a
   * page is stretched; tiles at this DPI cover the part on screen with sharp pixels.
   */
  dpi: number;
  /** The scrolling element, which decides what of the page is on screen to tile. */
  scroller: RefObject<HTMLElement | null>;
}

/**
 * The tiles over the part of a page that is on screen, in an upright layer turned
 * onto the box — so a tile is always the page's own pixels, as the bitmap is.
 *
 * Mount it inside the page box, over the stretched bitmap, which stays as the tiles'
 * placeholder: what is visible is measured against the parent element.
 *
 * Measures what is visible itself, on every scroll frame, rather than taking it as a
 * prop: neither the column nor a single-page view re-renders on scroll, and at 400%
 * one page fills the screen for a long scroll.
 */
export function PageTiles(props: PageTilesProps) {
  if (props.dpi <= 0 || !props.doc.capabilities.tiles) return null;
  return <TileLayer {...props} />;
}

function TileLayer({
  doc,
  index,
  width,
  height,
  pageWidth,
  pageHeight,
  rotation,
  annotations,
  dpi,
  scroller,
}: PageTilesProps) {
  const layer = useRef<HTMLDivElement>(null);
  // What is on screen, as fractions of the upright page, so the slots below follow a
  // new box size or DPI in the same render, before anything re-measures: a stale set
  // would start a wasted tile on every zoom step and trail the bitmap in a pinch.
  const [view, setView] = useState<Box | null>(null);
  const upright = rotateSize({ width, height }, rotation);
  const slotsAt = useCallback(
    (at: Box) =>
      tileSlots({ width: pageWidth, height: pageHeight }, dpi, upright.width, {
        x0: at.x0 * upright.width,
        y0: at.y0 * upright.height,
        x1: at.x1 * upright.width,
        y1: at.y1 * upright.height,
      }),
    [pageWidth, pageHeight, dpi, upright.width, upright.height],
  );
  const slots = useMemo(() => (view ? slotsAt(view) : []), [view, slotsAt]);

  // Passive, not layout: the scroller is an ancestor, and on the first commit its ref
  // is attached only after this component's layout effects have run.
  useEffect(() => {
    const vp = scroller.current;
    const page = layer.current?.parentElement;
    if (!vp || !page) return;
    const keys = (at: Box) =>
      slotsAt(at)
        .map((s) => s.key)
        .join();
    const measure = () => {
      const v = vp.getBoundingClientRect();
      const p = page.getBoundingClientRect();
      const box = uprightBox(
        {
          x0: Math.max(0, v.left - p.left),
          y0: Math.max(0, v.top - p.top),
          x1: Math.min(width, v.right - p.left),
          y1: Math.min(height, v.bottom - p.top),
        },
        { width, height },
        rotation,
      );
      const next = {
        x0: box.x0 / upright.width,
        y0: box.y0 / upright.height,
        x1: box.x1 / upright.width,
        y1: box.y1 / upright.height,
      };
      // Most scroll frames cross no tile edge; those keep the view and render nothing.
      setView((prev) => (prev && keys(prev) === keys(next) ? prev : next));
    };
    measure();
    let frame = 0;
    const onScroll = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
      }
    };
    vp.addEventListener('scroll', onScroll, { passive: true });
    // The scroller, not the window: closing a sidebar widens it at the same zoom.
    const resized = new ResizeObserver(onScroll);
    resized.observe(vp);
    return () => {
      vp.removeEventListener('scroll', onScroll);
      resized.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [
    scroller,
    width,
    height,
    rotation,
    upright.width,
    upright.height,
    slotsAt,
  ]);

  return (
    <div
      ref={layer}
      className="pointer-events-none absolute top-0 left-0 origin-top-left"
      style={{
        width: upright.width,
        height: upright.height,
        transform: uprightTransform({ width, height }, rotation),
      }}
    >
      {slots.map((slot) => (
        <TileCanvas
          // The DPI is in the key so a new zoom step mounts fresh canvases, and the
          // stretched bitmap shows until they paint, not the old step's tiles.
          key={`${dpi}:${slot.key}`}
          doc={doc}
          index={index}
          slot={slot}
          dpi={dpi}
          annotations={annotations}
        />
      ))}
    </div>
  );
}

/** One tile's canvas: rendered on mount, cancelled on unmount, hidden until painted. */
function TileCanvas({
  doc,
  index,
  slot,
  dpi,
  annotations,
}: {
  doc: PagedDoc;
  index: number;
  slot: TileSlot;
  dpi: number;
  annotations: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [painted, setPainted] = useState(false);
  const engine = usePageEngine();
  const { x, y, width, height } = slot.tile;

  useEffect(() => {
    let dropped = false;
    let handle: RenderHandle<PageBitmap>;
    try {
      // Queued in mount order, which is nearest the middle of the view first.
      handle = engine.renderTile(
        doc,
        index,
        { x, y, width, height },
        { dpi, annotations },
      );
    } catch {
      // A document closed under us, as the page surface's own render guards against;
      // the stretched bitmap stays.
      return;
    }
    handle.promise
      .then((page) => {
        if (dropped || !canvas.current) return;
        paintToCanvas(page, canvas.current);
        setPainted(true);
      })
      .catch(() => {});
    return () => {
      dropped = true;
      // A single-page view keeps the layer across a page turn, so a tile re-rendering
      // for a new page must not leave the old one's pixels over the new bitmap.
      setPainted(false);
      handle.cancel('tile left the view');
    };
  }, [engine, doc, index, x, y, width, height, dpi, annotations]);

  const { box } = slot;
  return (
    <canvas
      ref={canvas}
      className="absolute block"
      hidden={!painted}
      style={{
        left: box.x0,
        top: box.y0,
        width: box.x1 - box.x0,
        height: box.y1 - box.y0,
      }}
    />
  );
}
