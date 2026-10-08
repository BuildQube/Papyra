import {
  openTiff,
  paintToCanvas,
  type RenderedPage,
  TIFF_MAX_PIXELS,
  type TiffImage,
  type TiffPage,
} from '@build-qube/papyra';
import { ImageOffIcon } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { PdfIsolationGuard } from '@/components/pdf-isolation-guard';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { ZoomBar } from '@/components/viewer-zoom-bar';
import { useZoom, type ZoomAnchor } from '@/hooks/use-viewer-zoom';
import type { FileViewProps } from '@/lib/file-preview-core';
import { cn } from '@/lib/utils';
import {
  pageBox,
  type Rotation,
  renderWidth,
  type Size,
} from '@/lib/viewer-zoom';

/** Padding inside the scroll area, which content cannot use when fitting. */
const GUTTER = 32;

/**
 * A page's size in points, which is what the zoom maths measures.
 *
 * From its stated resolution when it has one, so 100% is the sheet's physical size —
 * what 100% means for a PDF, and the only reading under which a 300-dpi E-size scan
 * and a 200-dpi one of the same sheet look the same. It also squares a fax's pixels:
 * those are 204 by 196 dpi, and drawn one-to-one the page comes out 4% too wide.
 * Without a resolution, one pixel is one CSS pixel, as the image view has it.
 */
function pointSize(page: TiffPage): Size {
  const x = page.dpi?.x ?? 96;
  const y = page.dpi?.y ?? 96;
  return { width: (page.width * 72) / x, height: (page.height * 72) / y };
}

type Opened =
  | { status: 'opening' }
  | { status: 'open'; tiff: TiffImage }
  | { status: 'failed'; error: unknown };

/**
 * A TIFF, a page at a time, with the image view's zoom and rotation and a pager when
 * there is more than one page.
 *
 * Each page is decoded by papyra in Rust, off the main thread, straight to the size it
 * is shown at and never past 4096 × 4096 — a 300-dpi E-size sheet is 135 MP, and
 * holding it whole would cost half a gigabyte for a preview. Zooming past the cap
 * enlarges the decoded pixels.
 *
 * Loaded by `tiffRenderer` — import that, not this, so papyra stays out of the bundle
 * until a TIFF is opened.
 */
export function TiffFileView({ file }: FileViewProps) {
  return (
    <PdfIsolationGuard>
      <OpenedTiff file={file} />
    </PdfIsolationGuard>
  );
}

function OpenedTiff({ file }: Pick<FileViewProps, 'file'>) {
  const [opened, setOpened] = useState<Opened>({ status: 'opening' });

  useEffect(() => {
    let live = true;
    setOpened({ status: 'opening' });
    openTiff(file).then(
      (tiff) => live && setOpened({ status: 'open', tiff }),
      (error: unknown) => live && setOpened({ status: 'failed', error }),
    );
    return () => {
      live = false;
    };
  }, [file]);

  switch (opened.status) {
    case 'opening':
      return (
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      );
    case 'failed':
      // To the preview's error boundary, which says the file could not be opened and
      // offers it as a download.
      throw opened.error;
    case 'open':
      // A new file passes through 'opening' first, so this remounts with it and
      // starts on page one at its own zoom.
      return <TiffPages tiff={opened.tiff} />;
  }
}

type Decoded =
  | { status: 'decoding' }
  | { status: 'ready'; bitmap: RenderedPage }
  | { status: 'failed'; error: unknown };

function TiffPages({ tiff }: { tiff: TiffImage }) {
  const [index, setIndex] = useState(0);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [decoded, setDecoded] = useState<Decoded>({ status: 'decoding' });
  // The bitmap is painted and not kept, so a long fax holds one page's pixels at a
  // time.
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const anchor = useRef<ZoomAnchor | null>(null);

  const page = tiff.pages[index] as TiffPage;
  const size = pointSize(page);
  // A quarter turn swaps the sides, so "page fit" refits a portrait sheet turned
  // landscape.
  const shown: Size =
    rotation % 180 === 0 ? size : { width: size.height, height: size.width };
  const zoom = useZoom({
    viewport,
    page: shown,
    gutter: GUTTER,
    initial: 'page-fit',
    anchor,
  });

  const bitmap = decoded.status === 'ready' ? decoded.bitmap : undefined;
  useEffect(() => {
    if (bitmap && canvas.current) paintToCanvas(bitmap, canvas.current);
  }, [bitmap]);

  // As the image view does: 100% when the page fits at its physical size, else
  // "page fit". Decided once, after the viewport is first measured, and the page
  // stays hidden until then so it does not jump.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    if (placed || zoom.viewport.width <= 0) return;
    const actual = pageBox(shown, 1);
    if (
      actual.width <= zoom.viewport.width &&
      actual.height <= zoom.viewport.height
    ) {
      zoom.setSpec(1);
    }
    setPlaced(true);
  }, [placed, zoom.viewport.width, zoom.viewport.height]);

  // One box scaling uniformly, so the fraction under the pointer is preserved.
  useImperativeHandle(anchor, () => ({
    capture(clientX, clientY) {
      const rect = stack.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return {
        fx: (clientX - rect.left) / rect.width,
        fy: (clientY - rect.top) / rect.height,
        clientX,
        clientY,
      };
    },
    restore(token) {
      const rect = stack.current?.getBoundingClientRect();
      const vp = viewport.current;
      if (!rect || !vp) return;
      const a = token as {
        fx: number;
        fy: number;
        clientX: number;
        clientY: number;
      };
      vp.scrollLeft += rect.left + a.fx * rect.width - a.clientX;
      vp.scrollTop += rect.top + a.fy * rect.height - a.clientY;
    },
  }));

  // Decoded at the settled on-screen width, as a PDF page is rendered, and never
  // past the cap. Letting the browser shrink a full-cap canvas instead breaks line
  // work up: its downscale samples rather than averages, so at "page fit" a
  // one-pixel line on a 5000px scan survives in dashes. papyra's box filter keeps
  // it whole, and a G4 sheet decodes in tens of milliseconds, so asking again on
  // every settled zoom is cheaper than it sounds.
  const full = Math.min(
    page.width,
    Math.floor(Math.sqrt((TIFF_MAX_PIXELS * page.width) / page.height)),
  );
  const target = Math.min(full, renderWidth(size, zoom.renderScale));
  const shownIndex = useRef(-1);
  useEffect(() => {
    if (!placed) return;
    let live = true;
    // A new page dims the old one; a new zoom keeps the current pixels up until the
    // sharper ones arrive.
    if (shownIndex.current !== index) setDecoded({ status: 'decoding' });
    tiff.renderPage(index, { maxWidth: target }).then(
      (bitmap) => {
        if (!live) return;
        shownIndex.current = index;
        setDecoded({ status: 'ready', bitmap });
      },
      (error: unknown) => {
        if (!live) return;
        shownIndex.current = index;
        setDecoded({ status: 'failed', error });
      },
    );
    return () => {
      live = false;
    };
  }, [tiff, index, target, placed]);

  const box = pageBox(shown, zoom.scale);
  const upright = pageBox(size, zoom.scale);
  // CSS pixels per decoded pixel. Past 2 the pixels are the information: smoothing a
  // scan's enlarged pixels turns line work to fog.
  const magnified = bitmap ? upright.width / bitmap.width >= 2 : false;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col @container/pdf-viewer">
      <div className="flex flex-none flex-wrap items-center gap-2.5 border-b bg-card px-3 py-1.5">
        <ZoomBar
          onPage={tiff.pageCount > 1 ? setIndex : undefined}
          onSpec={zoom.setSpec}
          onStepIn={zoom.stepIn}
          onStepOut={zoom.stepOut}
          page={index}
          pageCount={tiff.pageCount}
          rotation={rotation}
          onRotate={(quarters) =>
            setRotation(
              ((((rotation + quarters * 90) % 360) + 360) % 360) as Rotation,
            )
          }
          scale={zoom.scale}
          settling={zoom.settling || decoded.status === 'decoding'}
          spec={zoom.spec}
          subject={tiff.pageCount > 1 ? 'Page' : 'Image'}
        />
      </div>
      {/*
       * `m-auto` on the child rather than centring on the grid: centred content
       * that overflows spills past the top and left edges, where no scrollbar can
       * reach it, while an auto margin collapses to zero instead.
       */}
      <div
        className="relative grid min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto overscroll-contain bg-muted/40 p-4"
        ref={viewport}
      >
        {decoded.status === 'failed' ? (
          <PageFailed error={decoded.error} index={index} />
        ) : (
          <div
            className={cn(
              'relative m-auto bg-white leading-[0] shadow-sm',
              !placed && 'invisible',
            )}
            ref={stack}
            style={{ width: box.width, height: box.height }}
          >
            <canvas
              aria-label={`Page ${index + 1} of ${tiff.pageCount}`}
              className={cn(
                'absolute top-1/2 left-1/2 max-w-none',
                magnified && '[image-rendering:pixelated]',
                // The previous page stays up, dimmed, while the next one decodes.
                decoded.status === 'decoding' && 'opacity-50',
              )}
              ref={canvas}
              role="img"
              // Turned by a transform, not repainted: the box above takes the
              // rotated footprint, and the canvas is centred in it upright.
              style={{
                width: upright.width,
                height: upright.height,
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
              }}
            />
            {decoded.status === 'decoding' && (
              <Spinner className="absolute inset-0 m-auto" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One page that would not decode. Not thrown to the error boundary: the file opened,
 * and the pager should still reach its other pages.
 */
function PageFailed({ index, error }: { index: number; error: unknown }) {
  return (
    <Empty className="m-auto">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ImageOffIcon />
        </EmptyMedia>
        <EmptyTitle>Page {index + 1} could not be shown</EmptyTitle>
        <EmptyDescription>
          {error instanceof Error ? error.message : String(error)}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
