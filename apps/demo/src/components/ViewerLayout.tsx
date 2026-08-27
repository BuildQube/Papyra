import type { ReactNode } from 'react';
import { useDocument } from '../lib/documentContext.js';
import { usePage } from '../lib/usePage.js';
import { Sidebar } from './Sidebar.js';

interface Props {
  /** Timings for whichever pipeline this route measures. */
  status?: ReactNode;
  /** Controls panel down the right-hand side. */
  aside?: ReactNode;
  showThumbs?: boolean;
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
  status,
  aside,
  showThumbs = true,
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
        {status && <div className="status">{status}</div>}
        {children}
      </section>
      {aside}
    </main>
  );
}
