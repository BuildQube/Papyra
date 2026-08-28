import type { Document, OutlineNode } from '@build-qube/papyra';
import {
  ChevronRightIcon,
  ListTreeIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { cn } from '@/lib/utils';

/** Props for {@link Outline}. */
export interface OutlineProps {
  /** The open document. */
  doc: Document;
  /** The page on screen, 0-based. Its row is marked selected. */
  current: number;
  /** Called with a 0-based page index when the reader picks a page. */
  onSelect: (index: number) => void;
}

/** The bordered one-liner every sidebar panel opens with. */
const NOTE = 'border-b px-2.5 py-2 text-xs text-muted-foreground';

/**
 * The document outline, as a collapsible tree.
 *
 * Nodes start expanded or collapsed as the document asks (`/Count`'s sign), which is
 * the difference between a usable table of contents and a wall of 400 sheet numbers
 * on a construction set.
 */
export function Outline({ doc, current, onSelect }: OutlineProps) {
  const [tree, setTree] = useState<OutlineNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setError(null);
    const started = performance.now();
    doc
      .outline()
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

  if (error) {
    return (
      <Alert variant="destructive" className="m-2 w-auto">
        <TriangleAlertIcon />
        <AlertTitle>The outline could not be read</AlertTitle>
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
        reading outline…
      </p>
    );
  }
  if (tree.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListTreeIcon />
          </EmptyMedia>
          <EmptyTitle>No outline</EmptyTitle>
          <EmptyDescription>
            This document carries no bookmarks.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const count = countNodes(tree);
  return (
    <>
      <p className={NOTE}>
        {count} {count === 1 ? 'entry' : 'entries'} · {elapsed.toFixed(1)}ms
      </p>
      <ul className="py-1 pb-3">
        {tree.map((node, i) => (
          <OutlineRow
            key={`${node.title}:${i}`}
            node={node}
            depth={0}
            current={current}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </>
  );
}

function OutlineRow({
  node,
  depth,
  current,
  onSelect,
}: {
  node: OutlineNode;
  depth: number;
  /** The page on screen, 0-based. Its row is marked selected. */
  current: number;
  /** Called with a 0-based page index when the reader picks a page. */
  onSelect: (index: number) => void;
}) {
  const [open, setOpen] = useState(node.open);
  const hasChildren = node.children.length > 0;

  const row = (
    <div
      data-active={node.page === current}
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
        disabled={node.page === null && !hasChildren}
        title={describe(node)}
        className="h-auto min-w-0 flex-1 justify-start gap-1.5 px-1 py-1 text-left text-xs font-normal"
        style={{
          fontWeight: node.bold ? 600 : 400,
          fontStyle: node.italic ? 'italic' : 'normal',
        }}
        onClick={() => {
          if (node.page !== null) onSelect(node.page);
          else if (hasChildren) setOpen(!open);
        }}
      >
        <span className="min-w-0 flex-1 truncate">{node.title}</span>
        {node.page !== null && (
          <span className="flex-none text-muted-foreground tabular-nums">
            {node.page + 1}
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
          <OutlineRow
            key={`${child.title}:${i}`}
            node={child}
            depth={depth + 1}
            current={current}
            onSelect={onSelect}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Spell out the destination, since the view is the part a page number loses. */
function describe(node: OutlineNode): string {
  const { dest } = node;
  if (!dest) return `${node.title} — no destination in this document`;
  const parts = [`page ${dest.page + 1}`, dest.kind];
  if (dest.top !== null) parts.push(`top ${dest.top.toFixed(0)}pt`);
  if (dest.left !== null) parts.push(`left ${dest.left.toFixed(0)}pt`);
  if (dest.zoom !== null) parts.push(`${(dest.zoom * 100).toFixed(0)}%`);
  return parts.join(' · ');
}

function countNodes(nodes: readonly OutlineNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}
