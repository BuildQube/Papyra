import type { Document, Rotation } from '@build-qube/papyra';
import { rotateSize } from '@build-qube/papyra';
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PdfIsolationGuard } from '@/components/pdf-isolation-guard';
import { PageView, type PageViewHandle } from '@/components/pdf-page-view';
import { ZoomBar } from '@/components/pdf-zoom-bar';
import {
  labelsDiffer,
  pageLabel,
  usePageLabels,
} from '@/hooks/use-pdf-page-labels';
import { useZoom, type ZoomAnchor } from '@/hooks/use-pdf-zoom';
import { PAGE } from '@/lib/pdf-page-class';
import { pageBox, renderWidth, type ZoomSpec } from '@/lib/pdf-zoom';
import { cn } from '@/lib/utils';

/** Padding inside the scroll area, which content cannot use when fitting. */
const GUTTER = 32;

/** Props for {@link PdfViewerBasic}. */
export interface PdfViewerBasicProps {
  /** The open document. */
  doc: Document;
  /** The page on screen, 0-based. Leave it out to let the viewer hold its own. */
  page?: number;
  /** The page to start on when uncontrolled. */
  defaultPage?: number;
  /** Called with the new page, 0-based. */
  onPageChange?: (page: number) => void;
  /** The zoom to open at. */
  initialZoom?: ZoomSpec;
  /** Classes for the outermost element. */
  className?: string;
}

/**
 * One page at a time, with a pager and zoom. No sidebar, no scrolling column.
 *
 * The viewer to embed — a panel, a modal, a card — where the full one would be more
 * furniture than document. It holds no store: a single page and a zoom level do not
 * need one, and staying out of that keeps this usable anywhere.
 *
 * ```tsx
 * <PdfViewerBasic doc={doc} className="h-96 rounded-md border" />
 * ```
 */
export function PdfViewerBasic({
  doc,
  page,
  defaultPage = 0,
  onPageChange,
  initialZoom = 'auto',
  className,
}: PdfViewerBasicProps) {
  const [own, setOwn] = useState(defaultPage);
  const index = Math.min(page ?? own, doc.pageCount - 1);

  // Local rather than in a store, for the same reason the page is: this block exists
  // to be embeddable, and a rotation nobody outside it reads does not need lifting.
  const [rotation, setRotation] = useState<Rotation>(0);
  const [annotations, setAnnotations] = useState(true);

  const viewport = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const surface = useRef<PageViewHandle>(null);
  const anchor = useRef<ZoomAnchor | null>(null);

  const labels = usePageLabels(doc);
  const label = labelsDiffer(labels) ? pageLabel(labels, index) : '';
  const pageSize = useMemo(() => doc.pageSize(index), [doc, index]);
  // The page as shown: what the fit modes and the CSS box measure. Rendering still
  // uses `pageSize`, since the bitmap is always upright.
  const shown = useMemo(
    () => rotateSize(pageSize, rotation),
    [pageSize, rotation],
  );

  const zoom = useZoom({
    viewport,
    page: shown,
    gutter: GUTTER,
    initial: initialZoom,
    anchor,
  });

  const box = pageBox(shown, zoom.scale);
  const pixelWidth = renderWidth(pageSize, zoom.renderScale);

  /**
   * A single page scales about the cursor exactly: it is one box scaling uniformly,
   * so the fraction of it under the pointer is preserved and the DOM can be measured
   * straight. The continuous view cannot do this, which is why anchoring is a
   * contract rather than something zoom works out for itself.
   */
  useImperativeHandle(anchor, () => ({
    capture(clientX, clientY) {
      const el = stack.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        fx: (clientX - rect.left) / rect.width,
        fy: (clientY - rect.top) / rect.height,
        clientX,
        clientY,
      };
    },
    restore(token) {
      const el = stack.current;
      const vp = viewport.current;
      if (!el || !vp) return;
      const a = token as {
        fx: number;
        fy: number;
        clientX: number;
        clientY: number;
      };
      const rect = el.getBoundingClientRect();
      vp.scrollLeft += rect.left + a.fx * rect.width - a.clientX;
      vp.scrollTop += rect.top + a.fy * rect.height - a.clientY;
    },
  }));

  useEffect(() => {
    if (pixelWidth <= 0) return;
    let cancelled = false;
    const job = doc.render(index, {
      fitWidth: pixelWidth,
      priority: 0,
      annotations,
    });
    job.promise.then(
      (rendered) => {
        if (!cancelled) void surface.current?.paint(rendered, rotation);
      },
      () => {
        /* A cancelled or failed render leaves the previous page on screen. */
      },
    );
    return () => {
      cancelled = true;
      job.cancel('page or zoom changed');
    };
    // `rotation` re-runs this only to repaint: the resubmission is a cache hit, which
    // is cheaper than keeping the bitmap around to turn later.
  }, [doc, index, pixelWidth, rotation, annotations]);

  const goTo = (next: number) => {
    setOwn(next);
    onPageChange?.(next);
  };

  return (
    <PdfIsolationGuard>
      <div className={cn('flex min-h-0 min-w-0 flex-col', className)}>
        <div className="flex flex-none flex-wrap items-center gap-2.5 border-b bg-card px-3 py-1.5">
          <ZoomBar
            label={label}
            onPage={goTo}
            onSpec={zoom.setSpec}
            onStepIn={zoom.stepIn}
            onStepOut={zoom.stepOut}
            page={index}
            pageCount={doc.pageCount}
            scale={zoom.scale}
            settling={zoom.settling}
            spec={zoom.spec}
            rotation={rotation}
            onRotate={(quarters) =>
              setRotation(
                ((((rotation + quarters * 90) % 360) + 360) % 360) as Rotation,
              )
            }
            annotations={annotations}
            onAnnotations={setAnnotations}
          />
        </div>
        {/*
         * A native scroller: the zoom gestures live here, so `touch-action` has to
         * leave the two-finger pinch alone and `overscroll-behavior` has to stop a
         * scroll that hits the end from navigating back.
         */}
        <div
          className="relative grid min-h-0 flex-1 touch-pan-x touch-pan-y items-start justify-items-center overflow-auto overscroll-contain p-4"
          ref={viewport}
        >
          <div
            className="relative leading-[0]"
            ref={stack}
            style={{ width: box.width, height: box.height }}
          >
            <PageView
              className={cn(PAGE, 'max-w-none')}
              ref={surface}
              style={{ width: box.width, height: box.height }}
            />
          </div>
        </div>
      </div>
    </PdfIsolationGuard>
  );
}
