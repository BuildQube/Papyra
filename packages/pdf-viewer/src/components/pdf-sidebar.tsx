import type { Document, Quad, Rotation, SearchMatch } from '@build-qube/papyra';
import { useEffect, useState } from 'react';
import { Outline } from '@/components/pdf-outline';
import { Search } from '@/components/pdf-search';
import { Structure } from '@/components/pdf-structure';
import { Thumbnails } from '@/components/pdf-thumbnails';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Tab = 'pages' | 'outline' | 'structure' | 'search';

/**
 * How a tab says its panel has nothing in it.
 *
 * Dimming the label rather than appending a marker: with four tabs the strip is 16px
 * wider than the 240px column for every marker shown, and a document with neither an
 * outline nor a structure tree shows two.
 *
 * On a child span rather than the trigger, because the trigger owns its own colour
 * across three states and a utility on it loses the cascade to whichever of those
 * applies. A span inherits nothing it has been given itself.
 */
const ABSENT = 'text-muted-foreground/50';

/** Props for {@link Sidebar}. */
export interface SidebarProps {
  /** The open document. */
  doc: Document;
  /** The page on screen, 0-based. Its row is marked selected. */
  current: number;
  /** Called with a 0-based page index when the reader picks a page. */
  onSelect: (index: number) => void;
  /** Search results, lifted so the page overlay and this list agree. */
  matches: SearchMatch[];
  /** Called as results stream in, and once more when the search settles. */
  onMatches: (matches: SearchMatch[]) => void;
  /** The result shown as current. */
  active: SearchMatch | null;
  /** Called when the highlighted match changes. */
  onActive: (match: SearchMatch | null) => void;
  /** Quarter turns the thumbnails are shown at, so the strip matches the page. */
  rotation?: Rotation;
  /** Called with the picked structure element's content, for the page overlay. */
  onHighlight: (page: number | null, quads: readonly Quad[]) => void;
}

/**
 * Pages, outline and search share one column, as they do in every real viewer.
 *
 * Every panel stays mounted: the thumbnail strip streams its renders in and the
 * search holds its results, and unmounting would throw both away on a tab change.
 * That is what `keepMounted` buys — a `Tabs.Panel` unmounts its children by default,
 * which would restart a 400-page thumbnail stream every time you looked at the
 * outline.
 */
export function Sidebar({
  doc,
  current,
  onSelect,
  matches,
  onMatches,
  active,
  onActive,
  rotation = 0,
  onHighlight,
}: SidebarProps) {
  const [tab, setTab] = useState<Tab>('pages');
  const [hasOutline, setHasOutline] = useState<boolean | null>(null);
  const [hasStructure, setHasStructure] = useState<boolean | null>(null);

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

  // Only ever dims the tab label. Opening on Structure would be wrong even when the
  // document has one: a reader looking for a table of contents wants the outline, and
  // a tag tree is a developer's view of the same document.
  useEffect(() => {
    let cancelled = false;
    setHasStructure(null);
    doc.structTree().then(
      (tree) => !cancelled && setHasStructure(tree.length > 0),
      () => !cancelled && setHasStructure(false),
    );
    return () => {
      cancelled = true;
    };
  }, [doc]);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as Tab)}
      render={<aside />}
      className="w-60 flex-none gap-0 overflow-hidden border-r bg-card"
    >
      <TabsList
        variant="line"
        className="w-full flex-none rounded-none border-b px-0"
      >
        <TabsTrigger value="pages">Pages</TabsTrigger>
        <TabsTrigger value="outline">
          <span className={hasOutline === false ? ABSENT : undefined}>
            Outline
          </span>
        </TabsTrigger>
        <TabsTrigger value="structure">
          <span className={hasStructure === false ? ABSENT : undefined}>
            Tags
          </span>
        </TabsTrigger>
        <TabsTrigger value="search">
          Search
          {matches.length > 0 && (
            <Badge variant="secondary">{matches.length}</Badge>
          )}
        </TabsTrigger>
      </TabsList>

      <TabsContent
        value="pages"
        keepMounted
        className="min-h-0 overflow-y-auto"
      >
        <Thumbnails
          doc={doc}
          current={current}
          onSelect={onSelect}
          rotation={rotation}
        />
      </TabsContent>
      <TabsContent
        value="outline"
        keepMounted
        className="min-h-0 overflow-y-auto"
      >
        <Outline doc={doc} current={current} onSelect={onSelect} />
      </TabsContent>
      <TabsContent
        value="structure"
        keepMounted
        className="flex min-h-0 flex-col overflow-hidden"
      >
        <Structure
          doc={doc}
          current={current}
          onSelect={onSelect}
          onHighlight={onHighlight}
        />
      </TabsContent>
      <TabsContent
        value="search"
        keepMounted
        className="flex min-h-0 flex-col overflow-y-auto"
      >
        <Search
          doc={doc}
          current={current}
          onSelect={onSelect}
          matches={matches}
          onMatches={onMatches}
          active={active}
          onActive={onActive}
        />
      </TabsContent>
    </Tabs>
  );
}
