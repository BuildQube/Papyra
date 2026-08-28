import type { Document, SearchMatch } from '@build-qube/papyra';
import { useEffect, useState } from 'react';
import { Outline } from '@/components/pdf-outline';
import { Search } from '@/components/pdf-search';
import { Thumbnails } from '@/components/pdf-thumbnails';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

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
}: Props) {
  const [tab, setTab] = useState<Tab>('pages');
  const [hasOutline, setHasOutline] = useState<boolean | null>(null);

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
          Outline
          {hasOutline === false && (
            <span className="text-muted-foreground/50">—</span>
          )}
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
        <Thumbnails doc={doc} current={current} onSelect={onSelect} />
      </TabsContent>
      <TabsContent
        value="outline"
        keepMounted
        className="min-h-0 overflow-y-auto"
      >
        <Outline doc={doc} current={current} onSelect={onSelect} />
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
