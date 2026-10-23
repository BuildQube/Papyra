import {
  type PageBitmap,
  type PagedDoc,
  type PdfDoc,
  paintToCanvas,
  type Quad,
  type RenderHandle,
  type Rotation,
  rotateSize,
  type SearchMatch,
  viewport,
} from '@build-qube/papyra/core';
import {
  memo,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { usePageEngine } from '@/components/pdf-engine';
import { Highlights } from '@/components/pdf-highlights';
import { Links } from '@/components/pdf-links';
import { cn } from '@/lib/utils';
import {
  type TileSlot,
  tileSlots,
  uprightBox,
  uprightTransform,
} from '@/lib/viewer-zoom';

/**
 * Whether the overlay may ask for this page's links. Only a PDF engine reads links,
 * and asking one about another engine's document throws, so the capability decides
 * rather than the overlay finding out.
 */
function hasLinks(doc: PagedDoc): doc is PdfDoc {
  return doc.capabilities.links;
}

/** Props for {@link PageSurface}. */
export interface PageSurfaceProps {
  /**
   * The open document: a PDF, or any engine's pages — a Word document, say, under a
   * `PageEngineScope`. Links are drawn when its capabilities include them.
   */
  doc: PagedDoc;
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
  /**
   * DPI to lay tiles over the bitmap at, from `tileDpi`, or 0 for none.
   *
   * Past the bitmap's pixel cap a page is stretched; tiles at this DPI cover the part
   * on screen with sharp pixels, and the stretched bitmap is their placeholder.
   * Ignored by an engine without the `tiles` capability.
   */
  tileDpi?: number;
  /** The scrolling element, which decides what of the page is on screen to tile. */
  scroller?: RefObject<HTMLElement | null>;
  /** Every match in the document; the ones on this page are drawn. */
  matches: readonly SearchMatch[];
  /** The match drawn in the active colour, if it is on this page. */
  active: SearchMatch | null;
  /**
   * Content of the picked structure element, already narrowed to this page by the
   * caller — the surface knows nothing about which element it belongs to.
   */
  regions?: readonly Quad[];
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
  tileDpi = 0,
  scroller,
  matches,
  active,
  regions,
  current,
  onSelect,
}: PageSurfaceProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const job = useRef<RenderHandle<PageBitmap> | null>(null);
  const [painted, setPainted] = useState(false);
  const [pending, setPending] = useState(false);
  const engine = usePageEngine();

  useEffect(() => {
    if (renderWidth <= 0) return;
    let dropped = false;
    let handle: RenderHandle<PageBitmap>;
    try {
      handle = engine.render(doc, index, {
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
  }, [engine, doc, index, renderWidth, rotation, annotations]);

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
      {tileDpi > 0 && scroller && doc.capabilities.tiles && (
        <Tiles
          doc={doc}
          index={index}
          width={width}
          height={height}
          pageWidth={pageWidth}
          pageHeight={pageHeight}
          rotation={rotation}
          annotations={annotations}
          dpi={tileDpi}
          scroller={scroller}
        />
      )}
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
      {painted && pageWidth > 0 && hasLinks(doc) && (
        <Links
          doc={doc}
          index={index}
          pageViewport={pageViewport}
          onSelect={onSelect}
        />
      )}
      {painted &&
        (mine.length > 0 || (regions?.length ?? 0) > 0) &&
        pageWidth > 0 && (
          <Highlights
            matches={mine}
            active={active?.page === index ? active : null}
            regions={regions}
            pageViewport={pageViewport}
            width={width}
            height={height}
          />
        )}
    </div>
  );
});

interface TilesProps {
  doc: PagedDoc;
  index: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
  rotation: Rotation;
  annotations: boolean;
  dpi: number;
  scroller: RefObject<HTMLElement | null>;
}

/**
 * The tiles over the part of a page that is on screen, in an upright layer turned
 * onto the box — so a tile is always the page's own pixels, as the bitmap is.
 *
 * Measures what is visible itself, on every scroll frame, rather than taking it as a
 * prop: the column re-renders only when the range of pages changes, and at 400% one
 * page fills the screen for a long scroll.
 */
function Tiles({
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
}: TilesProps) {
  const layer = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<TileSlot[]>([]);
  const upright = rotateSize({ width, height }, rotation);

  // Passive, not layout: the scroller is an ancestor, and on the first commit its ref
  // is attached only after this component's layout effects have run.
  useEffect(() => {
    const vp = scroller.current;
    const page = layer.current?.parentElement;
    if (!vp || !page) return;
    const measure = (first = false) => {
      const v = vp.getBoundingClientRect();
      const p = page.getBoundingClientRect();
      const view = uprightBox(
        {
          x0: Math.max(0, v.left - p.left),
          y0: Math.max(0, v.top - p.top),
          x1: Math.min(width, v.right - p.left),
          y1: Math.min(height, v.bottom - p.top),
        },
        { width, height },
        rotation,
      );
      const next = tileSlots(
        { width: pageWidth, height: pageHeight },
        dpi,
        upright.width,
        view,
      );
      // Most scroll frames cross no tile edge; those keep the same set and render
      // nothing. A new box size or DPI moves every tile, so it always replaces them.
      const keys = next.map((s) => s.key).join();
      setSlots((prev) =>
        !first && prev.map((s) => s.key).join() === keys ? prev : next,
      );
    };
    measure(true);
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
    window.addEventListener('resize', onScroll);
    return () => {
      vp.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [
    scroller,
    width,
    height,
    rotation,
    pageWidth,
    pageHeight,
    dpi,
    upright.width,
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
    // Queued in mount order, which is nearest the middle of the view first.
    const handle = engine.renderTile(
      doc,
      index,
      { x, y, width, height },
      { dpi, annotations },
    );
    handle.promise
      .then((page) => {
        if (dropped || !canvas.current) return;
        paintToCanvas(page, canvas.current);
        setPainted(true);
      })
      .catch(() => {});
    return () => {
      dropped = true;
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
