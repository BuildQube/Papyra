import type { Document, SearchMatch } from '@build-qube/papyra';
import { ChevronDownIcon, ChevronUpIcon, SearchIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Toggle } from '@/components/ui/toggle';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/** Props for {@link FindBar}. */
export interface FindBarProps {
  /** The open document. */
  doc: Document;
  /** The page on screen, 0-based. The search starts here and works outward. */
  current: number;
  /** What is being searched for. Empty means nothing is. */
  query: string;
  /** Called on every edit to the query. */
  onQuery: (query: string) => void;
  /** Every match found so far, lifted so the page overlay and the results list agree. */
  matches: SearchMatch[];
  /** Called as results stream in, and once more when the search settles. */
  onMatches: (matches: SearchMatch[]) => void;
  /** The result shown as current. */
  active: SearchMatch | null;
  /** Called when the highlighted match changes. */
  onActive: (match: SearchMatch | null) => void;
  /** Called with a 0-based page index when stepping lands on another page. */
  onSelect: (index: number) => void;
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

/**
 * Find in document, as a toolbar button that opens a popover.
 *
 * The search runs here rather than in the sidebar's results panel because this bar is
 * always mounted and that panel is not: on a phone the sidebar is a drawer, and a
 * search owned by a drawer would be cancelled by closing it. Closing the popover
 * keeps the query and its highlights — the results list is still there to read.
 *
 * ⌘F / Ctrl+F opens it while focus is inside the viewer, and only then. A component
 * that takes over the browser's find on a page it merely sits on is a bug for the
 * rest of that page; the page area is focusable so that a click on the document
 * counts as being inside.
 */
export function FindBar({
  doc,
  current,
  query,
  onQuery,
  matches,
  onMatches,
  active,
  onActive,
  onSelect,
}: FindBarProps) {
  const [open, setOpen] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWords, setWholeWords] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [unsearchable, setUnsearchable] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const origin = useRef(current);

  // The search keys on the document and the query, deliberately not on `current`:
  // scrolling must not restart a search. `origin` catches the page at the moment the
  // query changed, which is the page the reader was looking at when they typed.
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
          caseSensitive,
          wholeWords,
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
  }, [doc, query, caseSensitive, wholeWords]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key !== 'f' && event.key !== 'F') return;
      const root = trigger.current?.closest('[data-slot="pdf-viewer"]');
      if (
        !root ||
        !(event.target instanceof Node) ||
        !root.contains(event.target)
      )
        return;
      event.preventDefault();
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const step = (delta: 1 | -1) => {
    if (matches.length === 0) return;
    const at = active ? matches.indexOf(active) : -1;
    const next = matches[(at + delta + matches.length) % matches.length];
    if (!next) return;
    onActive(next);
    if (next.page !== current) onSelect(next.page);
  };

  const position =
    matches.length > 0
      ? `${active ? matches.indexOf(active) + 1 : 0} of ${matches.length}${
          matches.length === LIMIT ? '+' : ''
        }`
      : query.trim() !== '' && !running
        ? 'No matches'
        : '';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={trigger}
        render={
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Find in document"
            className="data-popup-open:bg-muted"
          />
        }
      >
        <SearchIcon />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-1rem)]">
        <div className="flex items-center gap-1.5">
          <InputGroup className="flex-1">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              type="text"
              autoComplete="off"
              aria-label="Find in document"
              placeholder="Find in document…"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }}
            />
            {position && (
              <InputGroupAddon align="inline-end">
                <InputGroupText className="tabular-nums">
                  {position}
                </InputGroupText>
              </InputGroupAddon>
            )}
          </InputGroup>
          <ButtonGroup>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous match"
              disabled={matches.length === 0}
              onClick={() => step(-1)}
            >
              <ChevronUpIcon />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next match"
              disabled={matches.length === 0}
              onClick={() => step(1)}
            >
              <ChevronDownIcon />
            </Button>
          </ButtonGroup>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Toggle
            variant="outline"
            size="sm"
            aria-label="Match case"
            pressed={caseSensitive}
            onPressedChange={setCaseSensitive}
          >
            Match case
          </Toggle>
          <Toggle
            variant="outline"
            size="sm"
            aria-label="Whole words"
            pressed={wholeWords}
            onPressedChange={setWholeWords}
          >
            Whole words
          </Toggle>
          <span className="ml-auto flex items-center gap-1.5">
            {running && <Spinner className="size-3" />}
            {running
              ? `${matches.length} so far`
              : elapsed !== null
                ? `${elapsed.toFixed(0)}ms`
                : 'Nearest page first'}
            {unsearchable > 0 && (
              <Tooltip>
                <TooltipTrigger render={<Badge variant="outline" />}>
                  {unsearchable} page{unsearchable === 1 ? '' : 's'} partly
                  unreadable
                </TooltipTrigger>
                <TooltipContent>
                  These pages draw text with no ToUnicode mapping. Some or all
                  of it cannot be searched, by papyra or anything else without
                  OCR.
                </TooltipContent>
              </Tooltip>
            )}
          </span>
        </div>
      </PopoverContent>
    </Popover>
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
