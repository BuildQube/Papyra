import type { Document, OutlineNode } from '@build-qube/papyra';
import { useEffect, useState } from 'react';

interface Props {
  doc: Document;
  current: number;
  onSelect: (index: number) => void;
}

/**
 * The document outline, as a collapsible tree.
 *
 * Nodes start expanded or collapsed as the document asks (`/Count`'s sign), which is
 * the difference between a usable table of contents and a wall of 400 sheet numbers
 * on a construction set.
 */
export function Outline({ doc, current, onSelect }: Props) {
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

  if (error) return <p className="panel-note error">{error}</p>;
  if (!tree) return <p className="panel-note muted">reading outline…</p>;
  if (tree.length === 0) {
    return <p className="panel-note muted">This document has no outline.</p>;
  }

  const count = countNodes(tree);
  return (
    <>
      <p className="panel-note muted">
        {count} {count === 1 ? 'entry' : 'entries'} · {elapsed.toFixed(1)}ms
      </p>
      <ul className="outline">
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
  current: number;
  onSelect: (index: number) => void;
}) {
  const [open, setOpen] = useState(node.open);
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <div
        className={
          node.page === current ? 'outline-row selected' : 'outline-row'
        }
        style={{ paddingLeft: `${6 + depth * 14}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="twisty"
            aria-expanded={open}
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={() => setOpen(!open)}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="twisty" />
        )}
        <button
          type="button"
          className="outline-title"
          // A container that points nowhere still toggles, which is what a viewer
          // does — the row is not dead, it just has no page of its own.
          disabled={node.page === null && !hasChildren}
          title={describe(node)}
          style={{
            fontWeight: node.bold ? 600 : 400,
            fontStyle: node.italic ? 'italic' : 'normal',
          }}
          onClick={() => {
            if (node.page !== null) onSelect(node.page);
            else if (hasChildren) setOpen(!open);
          }}
        >
          <span className="outline-label">{node.title}</span>
          {node.page !== null && (
            <span className="outline-page">{node.page + 1}</span>
          )}
        </button>
      </div>
      {hasChildren && open && (
        <ul>
          {node.children.map((child, i) => (
            <OutlineRow
              key={`${child.title}:${i}`}
              node={child}
              depth={depth + 1}
              current={current}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
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
