import type { Document, Quad, StructNode } from '@build-qube/papyra';
import { lineQuad, readingOrder } from '@build-qube/papyra';
import { ChevronRightIcon, NetworkIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/** Props for {@link Structure}. */
export interface StructureProps {
  /** The open document. */
  doc: Document;
  /** The page on screen, 0-based. The order view describes this page. */
  current: number;
  /** Called with a 0-based page index when the reader picks an element. */
  onSelect: (index: number) => void;
  /**
   * Called with the picked element's content, for the page overlay to outline.
   *
   * Page and quads travel together because a quad is meaningless without the page it
   * is measured on; `null` clears the selection.
   */
  onHighlight: (page: number | null, quads: readonly Quad[]) => void;
}

/** The bordered one-liner every sidebar panel opens with. */
const NOTE = 'border-b px-2.5 py-2 text-xs text-muted-foreground';

/**
 * The document structure tree, and what it does to reading order.
 *
 * Two views of one thing. The tree is the document's own account of itself — which
 * runs are headings, which are table cells — and picking a node outlines its content
 * on the page. The order view is the part that cannot be seen any other way: a PDF
 * may draw its text in any order it likes, and on a tagged document this is the only
 * place the intended one exists.
 */
export function Structure({
  doc,
  current,
  onSelect,
  onHighlight,
}: StructureProps) {
  const [tree, setTree] = useState<StructNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [picked, setPicked] = useState<StructNode | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setError(null);
    setPicked(null);
    const started = performance.now();
    doc
      .structTree()
      .then((nodes) => {
        if (cancelled) return;
        setElapsed(performance.now() - started);
        setTree(nodes);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // Clearing on unmount matters: the panel stays mounted across tab changes, but a
  // new document must not leave the previous one's outline on the page.
  useEffect(() => () => onHighlight(null, []), [onHighlight]);

  async function pick(node: StructNode) {
    setPicked(node);
    const page = node.content[0]?.page;
    if (page === undefined) {
      onHighlight(null, []);
      return;
    }
    onSelect(page);
    // The quads come from the page's own text, so this is a cache hit after the
    // first pick on a page — `pageText` is memoised per page inside the document.
    const text = await doc.pageText(page);
    const mine = new Set(
      node.content.filter((c) => c.page === page).map((c) => c.mcid),
    );
    onHighlight(
      page,
      text.lines
        .filter((line) => line.mcid !== undefined && mine.has(line.mcid))
        // The whole line: `offsets` has one entry per character plus the end, so its
        // last index is the end of the line whatever the text is made of.
        .map((line) => lineQuad(line, 0, line.offsets.length - 1)),
    );
  }

  if (error) {
    return (
      <Alert variant="destructive" className="m-2 w-auto">
        <TriangleAlertIcon />
        <AlertTitle>The structure tree could not be read</AlertTitle>
        <AlertDescription className="font-mono text-xs">
          {error}
        </AlertDescription>
      </Alert>
    );
  }
  if (!tree) {
    return (
      <p className={cn(NOTE, 'flex items-center gap-2')}>
        <Spinner className="size-3" />
        reading structure…
      </p>
    );
  }
  if (tree.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <NetworkIcon />
          </EmptyMedia>
          <EmptyTitle>Not tagged</EmptyTitle>
          <EmptyDescription>
            This document carries no structure tree, which is the common case.
            Text is still extracted — it just arrives in the order the page
            draws it.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const count = countNodes(tree);
  return (
    <Tabs defaultValue="tree" className="min-h-0 flex-1 gap-0">
      <TabsList variant="line" className="w-full flex-none rounded-none px-0">
        <TabsTrigger value="tree">Tags</TabsTrigger>
        <TabsTrigger value="order">Reading order</TabsTrigger>
      </TabsList>

      <TabsContent value="tree" keepMounted className="min-h-0 overflow-y-auto">
        <p className={NOTE}>
          {count} {count === 1 ? 'element' : 'elements'} · {elapsed.toFixed(1)}
          ms
        </p>
        <ul className="py-1 pb-3">
          {tree.map((node, i) => (
            <StructRow
              key={`${node.role}:${i}`}
              node={node}
              depth={0}
              picked={picked}
              onPick={pick}
            />
          ))}
        </ul>
      </TabsContent>

      <TabsContent
        value="order"
        keepMounted
        className="min-h-0 overflow-y-auto"
      >
        <ReadingOrder doc={doc} tree={tree} page={current} />
      </TabsContent>
    </Tabs>
  );
}

function StructRow({
  node,
  depth,
  picked,
  onPick,
}: {
  node: StructNode;
  depth: number;
  /** The element the reader picked, marked selected. */
  picked: StructNode | null;
  /** Called when this row is chosen. */
  onPick: (node: StructNode) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const label = node.title ?? node.alt ?? node.actualText;

  const row = (
    <div
      data-active={node === picked}
      className="flex items-baseline gap-0.5 border-l-2 border-transparent data-[active=true]:border-primary data-[active=true]:bg-primary/10"
      style={{ paddingLeft: `${6 + depth * 14}px` }}
    >
      {hasChildren ? (
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={open ? 'Collapse' : 'Expand'}
              className="size-4 text-muted-foreground"
            />
          }
        >
          <ChevronRightIcon
            className={cn('transition-transform', open && 'rotate-90')}
          />
        </CollapsibleTrigger>
      ) : (
        <span className="size-4 flex-none" />
      )}
      <Button
        variant="ghost"
        disabled={node.content.length === 0 && !hasChildren}
        title={describe(node)}
        className="h-auto min-w-0 flex-1 justify-start gap-1.5 px-1 py-1 text-left text-xs font-normal"
        onClick={() => {
          if (node.content.length > 0) onPick(node);
          else if (hasChildren) setOpen(!open);
        }}
      >
        <Badge
          variant="secondary"
          className="flex-none px-1 py-0 font-mono text-[10px]"
        >
          {node.role}
        </Badge>
        {label && <span className="min-w-0 flex-1 truncate">{label}</span>}
        {/* The document's own tag, when it differs — the `/RoleMap` at work, and the
            only place a reader can see that `Workbook` really means `Document`. */}
        {node.rawRole !== node.role && (
          <span className="flex-none font-mono text-[10px] text-muted-foreground">
            {node.rawRole}
          </span>
        )}
      </Button>
    </div>
  );

  if (!hasChildren) return <li>{row}</li>;

  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<li />}>
      {row}
      <CollapsibleContent render={<ul />}>
        {node.children.map((child, i) => (
          <StructRow
            key={`${child.role}:${i}`}
            node={child}
            depth={depth + 1}
            picked={picked}
            onPick={onPick}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One page's lines, as drawn and as the document says to read them.
 *
 * The count of moved lines is the whole point of the view: it is the difference
 * between the two orderings stated as a number, and on a form or a two-column paper
 * it is most of the page.
 */
function ReadingOrder({
  doc,
  tree,
  page,
}: {
  doc: Document;
  tree: readonly StructNode[];
  page: number;
}) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [ordered, setOrdered] = useState<{ text: string; role: string }[]>([]);
  const [declared, setDeclared] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLines(null);
    doc.pageText(page).then(
      (text) => {
        if (cancelled) return;
        setLines(text.lines.map((line) => line.text));
        setOrdered(
          readingOrder(text, tree).map(({ line, node }) => ({
            text: line.text,
            role: node?.role ?? '—',
          })),
        );
      },
      () => !cancelled && setLines([]),
    );
    return () => {
      cancelled = true;
    };
  }, [doc, tree, page]);

  const moved = useMemo(() => {
    if (!lines) return 0;
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== ordered[i]?.text) n++;
    }
    return n;
  }, [lines, ordered]);

  if (!lines) {
    return (
      <p className={cn(NOTE, 'flex items-center gap-2')}>
        <Spinner className="size-3" />
        reading page…
      </p>
    );
  }
  if (lines.length === 0) {
    return <p className={NOTE}>This page has no text.</p>;
  }

  const shown = declared ? ordered : lines.map((text) => ({ text, role: '' }));
  return (
    <>
      <div className={cn(NOTE, 'flex items-center justify-between gap-2')}>
        <span>
          {moved > 0 ? (
            <>
              <strong className="font-medium text-foreground">{moved}</strong>{' '}
              of {lines.length} lines move
            </>
          ) : (
            <>page {page + 1} reads as drawn</>
          )}
        </span>
        <Button
          variant="outline"
          size="xs"
          onClick={() => setDeclared(!declared)}
        >
          {declared ? 'Reading order' : 'As drawn'}
        </Button>
      </div>
      <ol className="py-1 pb-3">
        {shown.map((entry, i) => (
          <li
            // Position is the identity here: the same text appears twice on a form,
            // and which slot it sits in is exactly what the view is about.
            key={`${i}:${entry.text}`}
            className="flex items-baseline gap-1.5 px-2.5 py-0.5 text-xs"
          >
            <span className="w-6 flex-none text-right font-mono text-[10px] text-muted-foreground tabular-nums">
              {i + 1}
            </span>
            {entry.role && (
              <span className="w-8 flex-none truncate font-mono text-[10px] text-muted-foreground">
                {entry.role}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{entry.text}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function describe(node: StructNode): string {
  const parts = [node.role];
  if (node.rawRole !== node.role) parts.push(`(tagged ${node.rawRole})`);
  if (node.lang) parts.push(node.lang);
  if (node.content.length > 0) {
    parts.push(
      `${node.content.length} run${node.content.length === 1 ? '' : 's'}`,
    );
  }
  return parts.join(' · ');
}

function countNodes(nodes: readonly StructNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}
