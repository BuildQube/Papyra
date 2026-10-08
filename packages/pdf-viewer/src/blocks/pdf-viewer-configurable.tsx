import type { Document } from '@build-qube/papyra';
import { viewport as pageViewport, rotateSize } from '@build-qube/papyra';
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ContinuousPages } from '@/components/pdf-continuous-pages';
import { FindBar } from '@/components/pdf-find-bar';
import { Highlights } from '@/components/pdf-highlights';
import { PdfIsolationGuard } from '@/components/pdf-isolation-guard';
import { Links } from '@/components/pdf-links';
import { PageView, type PageViewHandle } from '@/components/pdf-page-view';
import { Properties } from '@/components/pdf-properties';
import type { SidebarPanel } from '@/components/pdf-sidebar';
import { ViewerLayout } from '@/components/pdf-viewer-layout';
import { PdfViewerProvider } from '@/components/pdf-viewer-provider';
import { ZoomBar } from '@/components/viewer-zoom-bar';
import {
  labelsDiffer,
  pageLabel,
  usePageLabels,
} from '@/hooks/use-pdf-page-labels';
import {
  usePdfAnnotations,
  usePdfDocument,
  usePdfPage,
  usePdfRotation,
  usePdfSearch,
  usePdfStructure,
  usePdfView,
  usePdfViewerActions,
} from '@/hooks/use-pdf-viewer';
import { useZoom, type ZoomAnchor } from '@/hooks/use-viewer-zoom';
import { PAGE } from '@/lib/pdf-page-class';
import type { PdfViewerStore } from '@/lib/pdf-viewer-store';
import { cn } from '@/lib/utils';
import {
  pageBox,
  renderWidth,
  type ViewMode,
  type ZoomSpec,
} from '@/lib/viewer-zoom';

/** The padding inside the scroll area, which content cannot use when fitting. */
const GUTTER = 48;

/** Props for {@link PdfViewerConfigurable}. */
export interface PdfViewerConfigurableProps {
  /** The open document. */
  doc: Document;
  /**
   * Pages one at a time (`'page'`), or in a scrolling column (`'scroll'`). Where the
   * viewer starts; with `viewToggle` the reader can change it. Defaults to `'page'`.
   */
  view?: ViewMode;
  /** Offer the single/continuous choice in the zoom menu. Off by default. */
  viewToggle?: boolean;
  /** A sidebar panel of page thumbnails. Off by default. */
  thumbnails?: boolean;
  /** A sidebar panel with the document's bookmarks, when it has any. Off by default. */
  outline?: boolean;
  /** A sidebar panel with the tagged-PDF structure tree. Off by default. */
  structure?: boolean;
  /** A sidebar panel listing embedded files. Off by default. */
  attachments?: boolean;
  /**
   * Find in document: a toolbar button, highlights on the page, and a sidebar panel
   * listing every result. Off by default.
   */
  search?: boolean;
  /**
   * "Document properties…" in the zoom menu: metadata, page size, fingerprint and
   * any attachments, in a dialog. Off by default. Give it `fileName` and `fileSize`
   * too, since a parsed document knows neither.
   */
  properties?: boolean;
  /** The file's name, for the properties dialog. */
  fileName?: string;
  /** The file's length in bytes, for the properties dialog. */
  fileSize?: number;
  /** Offer the full-screen toggle. On by default. */
  fullscreen?: boolean;
  /**
   * Whether the panels and the find bar show how long their work took. Off by
   * default: it is a number for whoever is tuning papyra, not for a reader.
   */
  displayRenderTime?: boolean;
  /** The zoom to open at. Defaults to `auto`. */
  initialZoom?: ZoomSpec;
  /** The page to open at, 0-based. */
  defaultPage?: number;
  /**
   * A store to share, when the surrounding app wants to read or drive the viewer's
   * page and search state. One is created internally otherwise.
   */
  store?: PdfViewerStore;
  /** Classes for the viewer's outermost element. */
  className?: string;
}

/**
 * One viewer, with every feature behind a prop.
 *
 * Everything off is `pdf-viewer-basic`: a page at a time with a pager and zoom.
 * Turning on any of `thumbnails`, `outline`, `structure`, `attachments` or `search`
 * brings in the sidebar, offering exactly those panels; `properties` adds the
 * document-properties dialog to the zoom menu; `view="scroll"` is the
 * continuous column `pdf-viewer` uses. A panel that is off is never mounted, so a
 * viewer without `thumbnails` does not stream them.
 *
 * The feature props are live, but `view`, `defaultPage` and `store` are where the
 * viewer starts: the store, and the render cache on its document, are not rebuilt
 * because a prop moved. Key the viewer to start over.
 *
 * ```tsx
 * <PdfViewerConfigurable doc={doc} thumbnails search className="h-[600px]" />
 * ```
 */
export function PdfViewerConfigurable({
  store,
  view = 'page',
  ...props
}: PdfViewerConfigurableProps) {
  return (
    <PdfIsolationGuard>
      <PdfViewerProvider store={store} view={view}>
        <ViewerBody {...props} />
      </PdfViewerProvider>
    </PdfIsolationGuard>
  );
}

/**
 * Split from {@link PdfViewerConfigurable} because the hooks below need the provider
 * that component renders, and a component cannot consume a context it puts in scope.
 */
function ViewerBody({
  doc,
  viewToggle = false,
  thumbnails = false,
  outline = false,
  structure: showStructure = false,
  attachments = false,
  search = false,
  properties = false,
  fileName,
  fileSize,
  fullscreen = true,
  displayRenderTime = false,
  initialZoom = 'auto',
  defaultPage,
  className,
}: Omit<PdfViewerConfigurableProps, 'store' | 'view'>) {
  const loaded = usePdfDocument();
  const [page, setPage] = usePdfPage();
  const [mode, setMode] = usePdfView();
  const { query, matches, active } = usePdfSearch();
  const structure = usePdfStructure();
  const [rotation, rotateBy] = usePdfRotation();
  const [annotations, setAnnotations] = usePdfAnnotations();
  const { setDocument, setQuery, setMatches, setActive } =
    usePdfViewerActions();

  const viewport = useRef<HTMLDivElement>(null);
  const anchor = useRef<ZoomAnchor | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  const surface = useRef<PageViewHandle>(null);
  const [showProperties, setShowProperties] = useState(false);

  // Mirrored into the store, which the panels read, as `pdf-viewer` does. The page
  // follows the document in, since the store clamps it to the one it holds.
  useEffect(() => {
    setDocument({ doc });
    if (defaultPage !== undefined) setPage(defaultPage);
  }, [doc, setDocument]);

  const panels = useMemo(() => {
    const on: SidebarPanel[] = [];
    if (thumbnails) on.push('pages');
    if (outline) on.push('outline');
    if (showStructure) on.push('structure');
    if (attachments) on.push('attachments');
    if (search) on.push('search');
    return on;
  }, [thumbnails, outline, showStructure, attachments, search]);

  const index = Math.min(page, doc.pageCount - 1);
  const labels = usePageLabels(doc);
  // Only worth the space when the document disagrees with the index.
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
  const single = mode === 'page';

  // A single page scales about the cursor exactly: it is one box scaling uniformly,
  // so the DOM can be measured straight. The continuous view anchors itself, since
  // the gaps between pages do not scale with them.
  useImperativeHandle(
    single ? anchor : null,
    () => ({
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
    }),
    [single],
  );

  useEffect(() => {
    if (!single || pixelWidth <= 0) return;
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
    // `rotation` re-runs this only to repaint: the resubmission is a cache hit.
  }, [doc, index, pixelWidth, rotation, annotations, single]);

  // Nothing renders until the store has the document the panels read.
  if (!loaded) return null;

  const overlay = pageViewport(pageSize, { fitWidth: box.width, rotation });

  return (
    <ViewerLayout
      className={className}
      showThumbs={panels.length > 0}
      panels={panels}
      displayRenderTime={displayRenderTime}
      fullscreen={fullscreen}
      toolbar={
        <>
          {search && (
            <FindBar
              doc={doc}
              current={index}
              query={query}
              onQuery={setQuery}
              matches={matches}
              onMatches={setMatches}
              active={active}
              onActive={setActive}
              onSelect={setPage}
              displayRenderTime={displayRenderTime}
            />
          )}
          <ZoomBar
            label={label}
            onPage={setPage}
            onSpec={zoom.setSpec}
            onStepIn={zoom.stepIn}
            onStepOut={zoom.stepOut}
            page={index}
            pageCount={doc.pageCount}
            scale={zoom.scale}
            settling={zoom.settling}
            spec={zoom.spec}
            mode={mode}
            onMode={viewToggle ? setMode : undefined}
            rotation={rotation}
            onRotate={rotateBy}
            annotations={annotations}
            onAnnotations={setAnnotations}
            onProperties={
              properties ? () => setShowProperties(true) : undefined
            }
          />
          {properties && showProperties && (
            <Properties
              byteLength={fileSize}
              doc={doc}
              name={fileName}
              onClose={() => setShowProperties(false)}
              page={index}
            />
          )}
        </>
      }
      viewport={viewport}
    >
      {single ? (
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
          <Links
            doc={doc}
            index={index}
            pageViewport={overlay}
            onSelect={setPage}
          />
          <Highlights
            matches={matches.filter((m) => m.page === index)}
            active={active?.page === index ? active : null}
            regions={structure.page === index ? structure.quads : undefined}
            pageViewport={overlay}
            width={box.width}
            height={box.height}
          />
        </div>
      ) : (
        <ContinuousPages
          active={active}
          anchor={anchor}
          doc={doc}
          matches={matches}
          structure={structure}
          onPage={setPage}
          page={index}
          renderScale={zoom.renderScale}
          rotation={rotation}
          annotations={annotations}
          scale={zoom.scale}
          viewport={viewport}
        />
      )}
    </ViewerLayout>
  );
}
