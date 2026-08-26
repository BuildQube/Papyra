import type { Document, SearchMatch } from '@build-qube/papyra';
import { useEffect, useRef, useState } from 'react';

interface Props {
  doc: Document;
  current: number;
  onSelect: (index: number) => void;
  /** Every match found so far, lifted so the page overlay can draw them. */
  matches: SearchMatch[];
  onMatches: (matches: SearchMatch[]) => void;
  active: SearchMatch | null;
  onActive: (match: SearchMatch | null) => void;
}

/** Cap the result list; a common word on a long document runs to thousands. */
const LIMIT = 500;

/**
 * Search pages outward from the one on screen.
 *
 * The nearest hit is almost never on page 1, and the first result is usually the one
 * being looked for — so this is what makes a search feel like it answered rather than
 * like it started at the beginning.
 */
function outward(from: number, count: number): number[] {
  const order = [from];
  for (let d = 1; d < count; d++) {
    if (from + d < count) order.push(from + d);
    if (from - d >= 0) order.push(from - d);
  }
  return order;
}

export function Search({
  doc,
  current,
  onSelect,
  matches,
  onMatches,
  active,
  onActive,
}: Props) {
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState(false);
  const [indexed, setIndexed] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [unsearchable, setUnsearchable] = useState(0);
  // The page the search started from, so typing another letter does not re-order
  // results under the reader.
  const origin = useRef(current);

  useEffect(() => {
    onMatches([]);
    onActive(null);
    setElapsed(null);
    setUnsearchable(0);
    if (query.trim() === '') return;

    const abort = new AbortController();
    origin.current = current;
    setRunning(true);
    const started = performance.now();

    void (async () => {
      const found: SearchMatch[] = [];
      try {
        for await (const match of doc.search(query, {
          order: outward(origin.current, doc.pageCount),
          limit: LIMIT,
          signal: abort.signal,
        })) {
          found.push(match);
          // Publish as they arrive: on a long document the first hit should be
          // usable long before the last page has been read.
          if (found.length % 8 === 1) onMatches([...found]);
        }
        if (abort.signal.aborted) return;
        onMatches(found);
        setElapsed(performance.now() - started);
        if (found.length > 0) onActive(found[0] ?? null);
        setUnsearchable(await countUnsearchable(doc));
      } finally {
        if (!abort.signal.aborted) setRunning(false);
      }
    })();

    return () => abort.abort();
    // `current` is deliberately not a dependency: re-ordering results because the
    // reader turned a page would move the list out from under them.
  }, [doc, query]);

  return (
    <>
      <div className="search-box">
        <input
          type="search"
          value={query}
          placeholder="Search this document"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="index"
          disabled={indexed !== null}
          onClick={() => {
            const started = performance.now();
            void doc
              .indexText()
              .then(() => setIndexed(performance.now() - started));
          }}
        >
          {indexed === null ? 'Index all pages' : 'Indexed'}
        </button>
      </div>

      <p className="panel-note muted">
        {query.trim() === ''
          ? indexed === null
            ? 'Matches are found page by page, nearest first.'
            : `${doc.pageCount} pages indexed in ${indexed.toFixed(0)}ms`
          : running
            ? `searching… ${matches.length} so far`
            : `${matches.length}${matches.length === LIMIT ? '+' : ''} ` +
              `match${matches.length === 1 ? '' : 'es'}` +
              (elapsed !== null ? ` · ${elapsed.toFixed(0)}ms` : '')}
        {unsearchable > 0 && (
          <>
            {' · '}
            <span
              className="warn"
              title="These pages draw text with no ToUnicode mapping. Some or all of it cannot be searched, by papyra or anything else without OCR."
            >
              {unsearchable} page{unsearchable === 1 ? '' : 's'} partly
              unreadable
            </span>
          </>
        )}
      </p>

      <ol className="results">
        {matches.map((match, i) => (
          <li key={`${match.page}:${i}`}>
            <button
              type="button"
              className={match === active ? 'result selected' : 'result'}
              onClick={() => {
                onActive(match);
                if (match.page !== current) onSelect(match.page);
              }}
            >
              <span className="result-page">{match.page + 1}</span>
              <span className="result-text">
                {match.context.slice(0, match.contextStart)}
                <mark>
                  {match.context.slice(match.contextStart, match.contextEnd)}
                </mark>
                {match.context.slice(match.contextEnd)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}

/**
 * Pages holding text no encoding can map back to Unicode.
 *
 * Counted whenever *any* glyph fails, not only when the whole page does: a paper whose
 * headings use a standard font and whose body uses an embedded subset with no
 * `ToUnicode` cmap still returns lines, and calling that page searchable would be a
 * lie in the direction that matters. "No results" and "this cannot be read" look
 * identical to a user otherwise, and only one of them is worth rephrasing for.
 */
async function countUnsearchable(doc: Document): Promise<number> {
  let count = 0;
  for (let i = 0; i < doc.pageCount; i++) {
    if ((await doc.pageText(i)).undecodedGlyphs > 0) count++;
  }
  return count;
}
