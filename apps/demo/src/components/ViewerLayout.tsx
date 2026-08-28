import type { ReactNode, RefObject } from 'react';
import { useDocument } from '../lib/documentContext.js';
import { usePage } from '../lib/usePage.js';
import { Sidebar } from './Sidebar.js';

interface Props {
  /** Page and zoom controls. Pinned above the scroll area, as in any viewer. */
  toolbar?: ReactNode;
  /** Timings for whichever pipeline this route measures. */
  status?: ReactNode;
  /** Controls panel down the right-hand side. */
  aside?: ReactNode;
  showThumbs?: boolean;
  /**
   * The scrolling element, handed back so a route can drive it. The viewer binds its
   * zoom gestures here and corrects the scroll offset after every zoom.
   */
  viewport?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

/**
 * The shared frame: thumbnail strip, page area, optional side panel.
 *
 * The viewer and the export view render the *same* layout on purpose — the only
 * difference between them is how the pixels get onto the screen, so anything else
 * differing would muddy the comparison.
 *
 * Flex, not a fixed 3-column grid: routes carry different panels — the viewer has no
 * side panel at all — and an absent child must not leave a hole.
 */
export function ViewerLayout({
  toolbar,
  status,
  aside,
  showThumbs = true,
  viewport,
  children,
}: Props) {
  const { loaded, matches, setMatches, active, setActive } = useDocument();
  const [page, setPage] = usePage();
  if (!loaded) return null;

  return (
    <main className="flex min-h-0 flex-1">
      {showThumbs && (
        <Sidebar
          doc={loaded.doc}
          current={page}
          onSelect={setPage}
          matches={matches}
          onMatches={setMatches}
          active={active}
          onActive={setActive}
        />
      )}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {toolbar && (
          <div className="flex flex-none flex-wrap items-center gap-2.5 border-b bg-card px-3 py-1.5">
            {toolbar}
          </div>
        )}
        {status && (
          <div className="min-h-6 flex-none border-b px-3 py-1 text-center text-xs">
            {status}
          </div>
        )}
        {/*
         * A native scroller, deliberately — not `ScrollArea`. The zoom gestures live
         * here, so the browser must not claim them first: `touch-action` leaves us
         * the two-finger pinch and keeps the one-finger pan, and `overscroll-behavior`
         * stops a scroll that hits the end from navigating back. A JS scroll
         * container owns the wheel and would take both away.
         */}
        <div
          className="relative grid min-h-0 flex-1 touch-pan-x touch-pan-y items-start justify-items-center overflow-auto overscroll-contain p-6"
          ref={viewport}
        >
          {children}
        </div>
      </section>
      {aside}
    </main>
  );
}
