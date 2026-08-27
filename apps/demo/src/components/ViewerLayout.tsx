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
    <main className="workspace">
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
      <section className="viewer">
        {toolbar && <div className="viewer-bar">{toolbar}</div>}
        {status && <div className="status">{status}</div>}
        <div className="viewer-scroll" ref={viewport}>
          {children}
        </div>
      </section>
      {aside}
    </main>
  );
}
