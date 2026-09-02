import type { Document, Quad, Rotation, SearchMatch } from '@build-qube/papyra';
import {
  ChevronDownIcon,
  LayoutGridIcon,
  ListTreeIcon,
  PaperclipIcon,
  SearchIcon,
  TagsIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Attachments } from '@/components/pdf-attachments';
import { Outline } from '@/components/pdf-outline';
import { Search } from '@/components/pdf-search';
import { Structure } from '@/components/pdf-structure';
import { Thumbnails } from '@/components/pdf-thumbnails';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type Panel = 'pages' | 'outline' | 'structure' | 'attachments' | 'search';

/** Props for {@link Sidebar}. */
export interface SidebarProps {
  /** The open document. */
  doc: Document;
  /** The page on screen, 0-based. Its row is marked selected. */
  current: number;
  /** Called with a 0-based page index when the reader picks a page. */
  onSelect: (index: number) => void;
  /** What the find bar is searching for, so the results panel can say so. */
  query: string;
  /** Search results, lifted so the page overlay and this list agree. */
  matches: SearchMatch[];
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
 * Asks the document whether it has any of a thing, without reading the thing.
 *
 * Null until answered, so a menu item can be neither enabled nor disabled while the
 * document is still being asked — flashing "no outline" at a document that has one
 * is worse than a moment of not saying.
 */
function useHas(
  doc: Document,
  read: (doc: Document) => Promise<{ length: number }>,
): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHas(null);
    read(doc).then(
      (found) => !cancelled && setHas(found.length > 0),
      () => !cancelled && setHas(false),
    );
    return () => {
      cancelled = true;
    };
  }, [doc, read]);
  return has;
}

const readOutline = (doc: Document) => doc.outline();
const readStructure = (doc: Document) => doc.structTree();
const readAttachments = (doc: Document) => doc.attachments();

/**
 * Pages, outline, tags, attachments and search results share one column, chosen
 * from a menu rather than a strip of tabs.
 *
 * A strip is a fixed cost in width — five labels do not fit in 240px, and the column
 * is now resizable, so no width can be assumed. A menu is one button wide whatever
 * the column is, and a panel the document does not have is a disabled item with its
 * name still legible, rather than a tab dimmed to a shade that has to be explained.
 * It is also what pdf.js moved to, for the same reason.
 *
 * It fills whatever holds it and draws no border of its own: the layout puts it in
 * a resizable column on a wide viewer and a drawer on a narrow one, and the edge
 * between it and the page belongs to that frame, not to this.
 *
 * Every panel stays mounted, hidden rather than removed: the thumbnail strip streams
 * its renders in and the results list holds its scroll, and unmounting would throw
 * both away on a switch — a 400-page thumbnail stream restarting every time you
 * looked at the outline.
 */
export function Sidebar({
  doc,
  current,
  onSelect,
  query,
  matches,
  active,
  onActive,
  rotation = 0,
  onHighlight,
}: SidebarProps) {
  const [panel, setPanel] = useState<Panel>('pages');
  const hasOutline = useHas(doc, readOutline);
  const hasStructure = useHas(doc, readStructure);
  const hasAttachments = useHas(doc, readAttachments);

  // Open on the outline when there is one: a document that declares its own
  // structure is easier to navigate by it than by pictures of its pages.
  useEffect(() => {
    setPanel(hasOutline ? 'outline' : 'pages');
  }, [hasOutline]);

  const panels: {
    key: Panel;
    label: string;
    icon: typeof LayoutGridIcon;
    has: boolean | null;
    count?: number;
  }[] = [
    { key: 'pages', label: 'Pages', icon: LayoutGridIcon, has: true },
    { key: 'outline', label: 'Outline', icon: ListTreeIcon, has: hasOutline },
    { key: 'structure', label: 'Tags', icon: TagsIcon, has: hasStructure },
    {
      key: 'attachments',
      label: 'Attachments',
      icon: PaperclipIcon,
      has: hasAttachments,
    },
    {
      key: 'search',
      label: 'Search results',
      icon: SearchIcon,
      has: true,
      count: matches.length,
    },
  ];
  const shown = panels.find((p) => p.key === panel) ?? panels[0];
  const ShownIcon = shown?.icon ?? LayoutGridIcon;

  return (
    <aside className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-card">
      <div className="flex flex-none items-center border-b px-1.5 py-1">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label="Sidebar panel"
                className="data-popup-open:bg-muted"
              />
            }
          >
            <ShownIcon />
            {shown?.label}
            {shown?.key === 'search' && matches.length > 0 && (
              <Badge variant="secondary">{matches.length}</Badge>
            )}
            <ChevronDownIcon className="text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <DropdownMenuRadioGroup
              value={panel}
              onValueChange={(value) => setPanel(value as Panel)}
            >
              {panels.map(({ key, label, icon: Icon, has, count }) => (
                <DropdownMenuRadioItem
                  key={key}
                  value={key}
                  disabled={has === false}
                >
                  <Icon />
                  {label}
                  {has === false ? (
                    <DropdownMenuShortcut>none</DropdownMenuShortcut>
                  ) : (
                    count !== undefined &&
                    count > 0 && (
                      <DropdownMenuShortcut>{count}</DropdownMenuShortcut>
                    )
                  )}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div
        hidden={panel !== 'pages'}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <Thumbnails
          doc={doc}
          current={current}
          onSelect={onSelect}
          rotation={rotation}
        />
      </div>
      <div
        hidden={panel !== 'outline'}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <Outline doc={doc} current={current} onSelect={onSelect} />
      </div>
      <div
        hidden={panel !== 'structure'}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <Structure
          doc={doc}
          current={current}
          onSelect={onSelect}
          onHighlight={onHighlight}
        />
      </div>
      <div
        hidden={panel !== 'attachments'}
        className="min-h-0 flex-1 overflow-y-auto p-2"
      >
        <Attachments doc={doc} />
      </div>
      <div
        hidden={panel !== 'search'}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        <Search
          query={query}
          current={current}
          onSelect={onSelect}
          matches={matches}
          active={active}
          onActive={onActive}
        />
      </div>
    </aside>
  );
}
