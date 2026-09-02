import type { SearchMatch } from '@build-qube/papyra';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
} from '@/components/ui/item';

/** Props for {@link Search}. */
export interface SearchProps {
  /** What the results are for. Empty when no search has been run. */
  query: string;
  /** The page on screen, 0-based. */
  current: number;
  /** Called with a 0-based page index when the reader picks a result on another page. */
  onSelect: (index: number) => void;
  /** Every match found so far, lifted so the page overlay can draw them. */
  matches: SearchMatch[];
  /** The result shown as current. */
  active: SearchMatch | null;
  /** Called when the highlighted match changes. */
  onActive: (match: SearchMatch | null) => void;
}

/**
 * Search results as a list of hits with their context.
 *
 * This panel runs nothing. The find bar in the toolbar owns the query and the search
 * — it has to, because on a phone this panel lives in a drawer that unmounts when it
 * closes, and a search that died with it would be a search that never finished. What
 * the list adds over the bar's "3 of 12" is the part pdf.js's find bar lacks: every
 * hit on one screen, with enough context to pick the right one without visiting each.
 */
export function Search({
  query,
  current,
  onSelect,
  matches,
  active,
  onActive,
}: SearchProps) {
  const searching = query.trim() !== '';

  return (
    <>
      <p className="flex-none border-b px-2.5 py-2 text-xs text-muted-foreground">
        {searching
          ? `${matches.length} match${matches.length === 1 ? '' : 'es'} for “${query}”`
          : 'Results from the toolbar’s find bar are listed here.'}
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
