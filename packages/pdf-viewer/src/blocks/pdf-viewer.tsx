import type { Document } from '@build-qube/papyra';
import { rotateSize } from '@build-qube/papyra';
import { useEffect, useMemo, useRef } from 'react';
import { ContinuousPages } from '@/components/pdf-continuous-pages';
import { FindBar } from '@/components/pdf-find-bar';
import { PdfIsolationGuard } from '@/components/pdf-isolation-guard';
import { ViewerLayout } from '@/components/pdf-viewer-layout';
import { PdfViewerProvider } from '@/components/pdf-viewer-provider';
import { ZoomBar } from '@/components/pdf-zoom-bar';
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
  usePdfViewerActions,
} from '@/hooks/use-pdf-viewer';
import { useZoom, type ZoomAnchor } from '@/hooks/use-pdf-zoom';
import type { PdfViewerStore } from '@/lib/pdf-viewer-store';
import type { ZoomSpec } from '@/lib/pdf-zoom';

/** The padding inside the scroll area, which content cannot use when fitting. */
const GUTTER = 48;

/** Props for {@link PdfViewer}. */
export interface PdfViewerProps {
  /**
   * The open document.
   *
   * Opening a PDF is the application's job — it owns the file input, the password
   * prompt and whatever it wants to do with failures — so this takes a `Document`
   * rather than a `File`.
   */
  doc: Document;
  /** The zoom to open at. Defaults to `auto`. */
  initialZoom?: ZoomSpec;
  /** Whether the pages/outline/search sidebar is shown. */
  showSidebar?: boolean;
  /**
   * A store to share, when the surrounding app wants to read or drive the viewer's
   * page and search state. One is created internally otherwise.
   */
  store?: PdfViewerStore;
  /** Classes for the viewer's outermost element. */
  className?: string;
}

/**
 * A complete PDF viewer: sidebar, toolbar, and a continuous scrolling column.
 *
 * Continuous only, deliberately. Two view modes double the zoom-anchoring work for a
 * choice most applications make once, and the single-page arrangement is its own,
 * much smaller component. The mode still lives in the store, so adding a toggle here
 * later is a UI change rather than a state change.
 *
 * ```tsx
 * const doc = await open(file);
 * <PdfViewer doc={doc} />
 * ```
 */
export function PdfViewer({
  doc,
  initialZoom = 'auto',
  showSidebar = true,
  store,
  className,
}: PdfViewerProps) {
  return (
    <PdfIsolationGuard>
      <PdfViewerProvider store={store} view="scroll">
        <ViewerBody
          className={className}
          doc={doc}
          initialZoom={initialZoom}
          showSidebar={showSidebar}
        />
      </PdfViewerProvider>
    </PdfIsolationGuard>
  );
}

/**
 * Split from {@link PdfViewer} because the hooks below need the provider that
 * component renders, and a component cannot consume a context it puts in scope.
 */
function ViewerBody({
  doc,
  initialZoom,
  showSidebar,
  className,
}: Required<Pick<PdfViewerProps, 'doc' | 'initialZoom' | 'showSidebar'>> & {
  className?: string;
}) {
  const loaded = usePdfDocument();
  const [page, setPage] = usePdfPage();
  const { query, matches, active } = usePdfSearch();
  const structure = usePdfStructure();
  const [rotation, rotateBy] = usePdfRotation();
  const [annotations, setAnnotations] = usePdfAnnotations();
  const { setDocument, setQuery, setMatches, setActive } =
    usePdfViewerActions();

  const viewport = useRef<HTMLDivElement>(null);
  const anchor = useRef<ZoomAnchor | null>(null);

  // The document is a prop but the panels read it from the store, so it is mirrored
  // in rather than threaded through six components. Identity is the guard: the store
  // ignores a document it already holds, so this settles after one pass.
  useEffect(() => {
    setDocument({ doc });
  }, [doc, setDocument]);

  const index = Math.min(page, doc.pageCount - 1);
  const labels = usePageLabels(doc);
  // Only worth the space when the document disagrees with the index — showing "3"
  // next to "3" is noise.
  const label = labelsDiffer(labels) ? pageLabel(labels, index) : '';
  // The fit modes measure the page as shown: turned, "page width" has to fit the
  // page's height, or a landscape view of a portrait page overflows the column.
  const pageSize = useMemo(
    () => rotateSize(doc.pageSize(index), rotation),
    [doc, index, rotation],
  );

  const zoom = useZoom({
    viewport,
    page: pageSize,
    gutter: GUTTER,
    initial: initialZoom,
    // The continuous view anchors zoom itself: the gaps between pages do not scale
    // with the pages, so the point under the cursor cannot be derived from the DOM.
    anchor,
  });

  // Nothing renders until the store has the document the panels read.
  if (!loaded) return null;

  return (
    <ViewerLayout
      className={className}
      showThumbs={showSidebar}
      toolbar={
        <>
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
          />
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
            rotation={rotation}
            onRotate={rotateBy}
            annotations={annotations}
            onAnnotations={setAnnotations}
          />
        </>
      }
      viewport={viewport}
    >
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
    </ViewerLayout>
  );
}
