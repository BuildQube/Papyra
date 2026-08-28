import type { Document, SearchMatch } from '@build-qube/papyra';
import { SearchIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

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
  }, [doc, query]);

  return (
    <>
      <div className="flex flex-none flex-col gap-1.5 border-b p-2">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={query}
            placeholder="Search this document"
            onChange={(e) => setQuery(e.target.value)}
          />
        </InputGroup>
        <Button
          variant="outline"
          size="sm"
          disabled={indexed !== null}
          onClick={() => {
            const started = performance.now();
            void doc
              .indexText()
              .then(() => setIndexed(performance.now() - started));
          }}
        >
          {indexed === null ? 'Index all pages' : 'Indexed'}
        </Button>
      </div>

      <p className="flex flex-none flex-wrap items-center gap-1.5 border-b px-2.5 py-2 text-xs text-muted-foreground">
        {running && <Spinner className="size-3" />}
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
          <Tooltip>
            <TooltipTrigger render={<Badge variant="outline" />}>
              {unsearchable} page{unsearchable === 1 ? '' : 's'} partly
              unreadable
            </TooltipTrigger>
            <TooltipContent>
              These pages draw text with no ToUnicode mapping. Some or all of it
              cannot be searched, by papyra or anything else without OCR.
            </TooltipContent>
          </Tooltip>
        )}
      </p>

      <ItemGroup className="gap-0 p-1 pb-3">
        {matches.map((match, i) => (
          <Item
            key={`${match.page}:${i}`}
            size="xs"
            data-active={match === active}
            className="cursor-pointer text-left hover:bg-muted data-[active=true]:bg-primary/10"
            render={<button type="button" />}
            onClick={() => {
              onActive(match);
              if (match.page !== current) onSelect(match.page);
            }}
          >
            <ItemMedia className="w-6 justify-end self-start text-xs text-muted-foreground tabular-nums">
              {match.page + 1}
            </ItemMedia>
            <ItemContent>
              <ItemDescription className="text-xs">
                {match.context.slice(0, match.contextStart)}
                <mark className="rounded-xs bg-primary/30 text-foreground">
                  {match.context.slice(match.contextStart, match.contextEnd)}
                </mark>
                {match.context.slice(match.contextEnd)}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
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
