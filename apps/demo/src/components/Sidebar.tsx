import type { Document, SearchMatch } from '@build-qube/papyra';
import { useEffect, useState } from 'react';
import { Outline } from './Outline.js';
import { Search } from './Search.js';
import { Thumbnails } from './Thumbnails.js';

type Tab = 'pages' | 'outline' | 'search';

interface Props {
  doc: Document;
  current: number;
  onSelect: (index: number) => void;
  matches: SearchMatch[];
  onMatches: (matches: SearchMatch[]) => void;
  active: SearchMatch | null;
  onActive: (match: SearchMatch | null) => void;
}

/**
 * Pages, outline and search share one column, as they do in every real viewer.
 *
 * Every panel stays mounted: the thumbnail strip streams its renders in and the
 * search holds its results, and unmounting would throw both away on a tab change.
 */
export function Sidebar({
  doc,
  current,
  onSelect,
  matches,
  onMatches,
  active,
  onActive,
}: Props) {
  const [tab, setTab] = useState<Tab>('pages');
  const [hasOutline, setHasOutline] = useState<boolean | null>(null);

  // Open on the outline when there is one — on a document with a table of contents
  // that is what you came for, and it saves a click to discover the feature at all.
  useEffect(() => {
    let cancelled = false;
    setHasOutline(null);
    setTab('pages');
    doc.outline().then(
      (tree) => {
        if (cancelled) return;
        setHasOutline(tree.length > 0);
        if (tree.length > 0) setTab('outline');
      },
      () => !cancelled && setHasOutline(false),
    );
    return () => {
      cancelled = true;
    };
  }, [doc]);

  return (
    <aside className="sidebar">
      <nav className="tabs">
        <button
          type="button"
          className={tab === 'pages' ? 'tab selected' : 'tab'}
          onClick={() => setTab('pages')}
        >
          Pages
        </button>
        <button
          type="button"
          className={tab === 'outline' ? 'tab selected' : 'tab'}
          onClick={() => setTab('outline')}
        >
          Outline
          {hasOutline === false && <span className="tab-badge">—</span>}
        </button>
        <button
          type="button"
          className={tab === 'search' ? 'tab selected' : 'tab'}
          onClick={() => setTab('search')}
        >
          Search
          {matches.length > 0 && (
            <span className="tab-badge">{matches.length}</span>
          )}
        </button>
      </nav>

      <div className="panel" hidden={tab !== 'pages'}>
        <Thumbnails doc={doc} current={current} onSelect={onSelect} />
      </div>
      <div className="panel" hidden={tab !== 'outline'}>
        <Outline doc={doc} current={current} onSelect={onSelect} />
      </div>
      <div className="panel" hidden={tab !== 'search'}>
        <Search
          doc={doc}
          current={current}
          onSelect={onSelect}
          matches={matches}
          onMatches={onMatches}
          active={active}
          onActive={onActive}
        />
      </div>
    </aside>
  );
}
