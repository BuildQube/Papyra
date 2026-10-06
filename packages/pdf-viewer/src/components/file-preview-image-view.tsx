import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ZoomBar } from '@/components/viewer-zoom-bar';
import { useZoom, type ZoomAnchor } from '@/hooks/use-viewer-zoom';
import { extensionOf, type FileViewProps } from '@/lib/file-preview-core';
import { cn } from '@/lib/utils';
import { pageBox, type Rotation, type Size } from '@/lib/viewer-zoom';

/** Padding inside the scroll area, which content cannot use when fitting. */
const GUTTER = 32;

/**
 * Points per CSS pixel. The zoom maths is in PDF points, so an image enters it as
 * its pixel size in points — which makes 100% one image pixel per CSS pixel, the
 * same promise 100% makes for a page.
 */
const PT_PER_PX = 72 / 96;

/**
 * An SVG's size from its own root element: `width` and `height` when both are plain
 * lengths, else the `viewBox`, else nothing.
 *
 * Not from the browser, because the browser invents one. An SVG with only a
 * `viewBox` has no intrinsic size, and Chrome reports the 150px default for it —
 * so "100%" would mean 150px whatever the drawing is. Left to size itself in an
 * `<img>`, the same SVG shrinks to nothing, which is how "actual size" used to show
 * a blank area.
 */
async function svgSize(
  file: File,
): Promise<{ width: number; height: number } | null> {
  const head = await file.slice(0, 4096).text();
  const root = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (!root) return null;
  const attr = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1];
  // A percentage or an em has no meaning without a container to resolve against.
  const length = (value: string | undefined) =>
    value && /^\s*[\d.]+(px)?\s*$/.test(value) ? Number.parseFloat(value) : 0;

  const width = length(attr('width'));
  const height = length(attr('height'));
  if (width > 0 && height > 0) return { width, height };

  const box = attr('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const [, , w = 0, h = 0] = box ?? [];
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; url: string; width: number; height: number }
  | { status: 'failed'; error: unknown };

/**
 * An image with the page viewer's zoom: ⌘/ctrl-scroll, pinch, ⌘/ctrl +/−, the fit
 * modes, and the point under the cursor held still.
 *
 * Opens at 100% when the image fits and at "image fit" when it does not — a 16px
 * icon blown up to fill the pane says less about it than the icon does.
 *
 * Loaded by `imageRenderer` — import that, not this, so the view stays out of the
 * bundle until an image is opened.
 */
export function ImageFileView({ file }: FileViewProps) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });

  // Decoded off-screen first, for the dimensions zoom needs before anything is laid
  // out. Created and revoked by one effect, so a file swapped underneath the view
  // never leaves its predecessor's blob pinned in memory.
  useEffect(() => {
    let live = true;
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.src = url;
    setLoaded({ status: 'loading' });
    probe.decode().then(
      async () => {
        const own = isVector(file) ? await svgSize(file) : null;
        const size = own ?? {
          width: probe.naturalWidth || 300,
          height: probe.naturalHeight || 150,
        };
        if (live) setLoaded({ status: 'ready', url, ...size });
      },
      (error: unknown) => live && setLoaded({ status: 'failed', error }),
    );
    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // To the preview's error boundary, which says the file could not be opened and
  // offers it as a download.
  if (loaded.status === 'failed') throw loaded.error;
  if (loaded.status === 'loading') return null;
  return <ZoomedImage file={file} {...loaded} />;
}

function ZoomedImage({
  file,
  url,
  width,
  height,
}: {
  file: File;
  url: string;
  width: number;
  height: number;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const anchor = useRef<ZoomAnchor | null>(null);

  const [rotation, setRotation] = useState<Rotation>(0);
  const size: Size = { width: width * PT_PER_PX, height: height * PT_PER_PX };
  // The image as shown: what the fit modes and the box measure. A quarter turn swaps
  // the sides, so "image fit" refits a portrait photo turned landscape.
  const shown: Size =
    rotation % 180 === 0 ? size : { width: size.height, height: size.width };
  const zoom = useZoom({
    viewport,
    page: shown,
    gutter: GUTTER,
    initial: 'page-fit',
    anchor,
  });

  // The opening zoom needs the viewport measured, which happens after the first
  // layout — so the image stays hidden until it is decided, rather than showing a
  // frame at "image fit" and then jumping.
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

  // One box scaling uniformly, so the fraction under the pointer is preserved — the
  // same anchoring the one-page PDF viewer uses.
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

  const box = pageBox(shown, zoom.scale);
  const upright = pageBox(size, zoom.scale);
  const vector = isVector(file);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col @container/pdf-viewer">
      <div className="flex flex-none flex-wrap items-center gap-2.5 border-b bg-card px-3 py-1.5">
        <ZoomBar
          onSpec={zoom.setSpec}
          onStepIn={zoom.stepIn}
          onStepOut={zoom.stepOut}
          scale={zoom.scale}
          settling={false}
          spec={zoom.spec}
          subject="Image"
          rotation={rotation}
          onRotate={(quarters) =>
            setRotation(
              ((((rotation + quarters * 90) % 360) + 360) % 360) as Rotation,
            )
          }
        />
      </div>
      {/*
       * `m-auto` on the child rather than centring on the grid: centred content
       * that overflows spills past the top and left edges, where no scrollbar can
       * reach it, while an auto margin collapses to zero instead.
       */}
      <div
        className="grid min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto overscroll-contain bg-muted/40 p-4"
        ref={viewport}
      >
        <div
          className={cn(
            'relative m-auto leading-[0] shadow-sm',
            // Transparency shown as a checkerboard, as image tools do — against a
            // plain fill, a transparent logo and a white one look the same.
            'bg-[repeating-conic-gradient(var(--color-muted)_0%_25%,var(--color-background)_0%_50%)] bg-size-[16px_16px]',
            !placed && 'invisible',
          )}
          ref={stack}
          style={{ width: box.width, height: box.height }}
        >
          <img
            alt={file.name}
            className={cn(
              'absolute top-1/2 left-1/2 max-w-none',
              // Past 2x a photo's pixels are the information; smoothing them away
              // is what makes a zoomed screenshot unreadable. Vectors stay sharp.
              !vector && zoom.scale >= 2 && '[image-rendering:pixelated]',
            )}
            draggable={false}
            height={height}
            src={url}
            // Turned by a transform, not re-encoded: the box above takes the
            // rotated footprint, and the image is centred in it at its upright size.
            style={{
              width: upright.width,
              height: upright.height,
              transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
            }}
            width={width}
          />
        </div>
      </div>
    </div>
  );
}

function isVector(file: File): boolean {
  return extensionOf(file.name) === '.svg' || file.type.includes('svg');
}
