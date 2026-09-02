import { PanelLeftIcon } from 'lucide-react';
import type { ComponentProps, ReactNode, Ref, RefObject } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Sidebar } from '@/components/pdf-sidebar';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { Toggle } from '@/components/ui/toggle';
import {
  usePdfDocument,
  usePdfPage,
  usePdfRotation,
  usePdfSearch,
  usePdfSidebar,
  usePdfViewerActions,
} from '@/hooks/use-pdf-viewer';
import { cn } from '@/lib/utils';

/** Props for {@link ViewerLayout}. */
export interface ViewerLayoutProps {
  /** Page and zoom controls. Pinned above the scroll area, as in any viewer. */
  toolbar?: ReactNode;
  /** Timings for whichever pipeline this route measures. */
  status?: ReactNode;
  /** Controls panel down the right-hand side. */
  aside?: ReactNode;
  /** Whether the sidebar exists at all. Its open state lives in the store. */
  showThumbs?: boolean;
  /**
   * The scrolling element, handed back so a route can drive it. The viewer binds its
   * zoom gestures here and corrects the scroll offset after every zoom.
   */
  viewport?: RefObject<HTMLDivElement | null>;
  /** The page area: whichever view is mounted. */
  children: ReactNode;
  /** Classes for the outermost element. */
  className?: string;
}

/**
 * Narrower than this, in pixels of the viewer's own width, and the sidebar is a
 * drawer rather than a column.
 *
 * The viewer's width, not the window's: the components page embeds it in a card, and
 * a wide window holding a narrow viewer has the same problem a phone has. 768 is
 * Tailwind's `md`, and the arithmetic behind it is a 240px column beside a page that
 * still has room to be read.
 */
const COMPACT_WIDTH = 768;

/** The column's width when it opens. What it was when it was fixed. */
const SIDEBAR_WIDTH = 240;

/**
 * Drag the column narrower than this and it collapses instead.
 *
 * Wide enough for a 160px thumbnail with the strip's padding either side; below that
 * the thumbnails would shrink, and a column too narrow to show its content is one
 * the reader was trying to close.
 */
const SIDEBAR_MIN = 180;

/**
 * The panel's imperative handle, taken from the wrapper's prop rather than imported
 * from `react-resizable-panels`: that library is the `resizable` item's dependency,
 * not this one's, and in this workspace it does not resolve from here.
 */
type PanelHandle =
  NonNullable<ComponentProps<typeof ResizablePanel>['panelRef']> extends Ref<
    infer T
  >
    ? NonNullable<T>
    : never;

/**
 * Whether the element is narrower than {@link COMPACT_WIDTH}. Null until measured.
 *
 * Measured in a layout effect, synchronously before first paint, rather than left to
 * the observer's first callback: the sidebar starts a thumbnail stream the moment it
 * mounts, so rendering the desktop frame on a phone for one frame would cost 400
 * renders that then compete with the page the reader is looking at.
 */
function useCompact(ref: RefObject<HTMLElement | null>): boolean | null {
  const [compact, setCompact] = useState<boolean | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setCompact(el.clientWidth < COMPACT_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return compact;
}

/**
 * The shared frame: sidebar, page area, optional side panel.
 *
 * The viewer and the export view render the *same* layout on purpose — the only
 * difference between them is how the pixels get onto the screen, so anything else
 * differing would muddy the comparison.
 *
 * The sidebar has two frames and one state. Wide, it is a resizable column that
 * collapses when dragged shut or toggled; narrow, the same panels come up in a
 * bottom drawer, because a 240px column out of a phone's 390 leaves nothing for the
 * page. Both read the store's `sidebar` flag, and the toggle in the toolbar row
 * writes it, so neither frame knows which one it is.
 *
 * Flex, not a fixed 3-column grid: routes carry different panels — the viewer has no
 * side panel at all — and an absent child must not leave a hole. That holds for the
 * sidebar too: `showThumbs` off renders no panel group, not an empty panel and a
 * handle beside the page.
 */
export function ViewerLayout({
  toolbar,
  status,
  aside,
  showThumbs = true,
  viewport,
  children,
  className,
}: ViewerLayoutProps) {
  const doc = usePdfDocument();
  const [page, setPage] = usePdfPage();
  const { query, matches, active } = usePdfSearch();
  const [rotation] = usePdfRotation();
  const [open, setSidebar] = usePdfSidebar();
  const { setActive, setStructureSelection, toggleSidebar } =
    usePdfViewerActions();

  const root = useRef<HTMLElement>(null);
  const compact = useCompact(root);
  const panel = useRef<PanelHandle | null>(null);
  // The width the reader last dragged the column to, so the toggle reopens it there.
  // Not the panel's own `expand()`: measured, that came back at the minimum rather
  // than the size it had before collapsing.
  const width = useRef(SIDEBAR_WIDTH);

  // Becoming narrow closes the sidebar — on first measurement, so a drawer does not
  // cover the document on load, and on a resize, so it does not pop up mid-read.
  // Becoming wide again leaves it closed: the toggle is right there.
  useEffect(() => {
    if (compact) setSidebar(false);
  }, [compact, setSidebar]);

  // The store drives the column. The reverse edge is `onResize` below, for a drag.
  useEffect(() => {
    const handle = panel.current;
    if (!handle || compact !== false) return;
    if (open) handle.resize(width.current);
    else handle.collapse();
  }, [open, compact]);

  if (!doc) return null;

  const sidebar = (
    <Sidebar
      doc={doc.doc}
      current={page}
      onSelect={(index) => {
        setPage(index);
        // Picking a page is the end of the interaction on a phone. Not on a desktop,
        // where the column stays and the reader keeps browsing.
        if (compact) setSidebar(false);
      }}
      query={query}
      matches={matches}
      active={active}
      onActive={setActive}
      rotation={rotation}
      onHighlight={setStructureSelection}
    />
  );

  const pages = (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {(toolbar || showThumbs) && (
        <div className="flex flex-none flex-wrap items-center gap-2.5 border-b bg-card px-3 py-1.5">
          {showThumbs && (
            <Toggle
              variant="outline"
              size="sm"
              aria-label="Toggle sidebar"
              pressed={open}
              onPressedChange={toggleSidebar}
            >
              <PanelLeftIcon />
            </Toggle>
          )}
          {toolbar}
        </div>
      )}
      {status && (
        <div className="min-h-6 flex-none border-b px-3 py-1 text-center text-xs">
          {status}
        </div>
      )}
      {/* Focusable so that a click on the page puts focus inside the viewer, which
          is what scopes the find bar's ⌘F to it. -1 keeps it out of the tab order:
          the toolbar's controls are the stops, the scroll area is not one. */}
      <div
        className="relative grid min-h-0 flex-1 touch-pan-x touch-pan-y items-start justify-items-center overflow-auto overscroll-contain p-6 outline-none"
        ref={viewport}
        tabIndex={-1}
      >
        {children}
      </div>
    </section>
  );

  return (
    <main
      ref={root}
      data-slot="pdf-viewer"
      className={cn(
        'flex min-h-0 min-w-0 flex-1 @container/pdf-viewer',
        className,
      )}
    >
      {showThumbs && compact === false ? (
        <ResizablePanelGroup>
          <ResizablePanel
            panelRef={panel}
            collapsible
            defaultSize={open ? SIDEBAR_WIDTH : 0}
            minSize={SIDEBAR_MIN}
            maxSize="50%"
            onResize={(size) => {
              // A drag past the minimum collapses the panel; the store has to hear
              // about it or the toggle would show "open" beside a closed column.
              const collapsed = size.inPixels < 1;
              if (!collapsed) width.current = size.inPixels;
              if (collapsed === open) setSidebar(!collapsed);
            }}
          >
            {sidebar}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel>{pages}</ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        pages
      )}

      {showThumbs && compact && (
        <Drawer open={open} onOpenChange={setSidebar} showSwipeHandle>
          <DrawerContent className="[--drawer-height:80dvh]">
            <DrawerTitle className="sr-only">Document panels</DrawerTitle>
            {sidebar}
          </DrawerContent>
        </Drawer>
      )}

      {aside}
    </main>
  );
}
