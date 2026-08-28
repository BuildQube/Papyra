import type { Document, PageLink } from '@build-qube/papyra';
import { scaleRect } from '@build-qube/papyra';
import { useEffect, useState } from 'react';

interface Props {
  doc: Document;
  index: number;
  /** Page-space (72 DPI) to CSS-pixel scale — the same one highlights use. */
  scale: number;
  onSelect: (index: number) => void;
}

/**
 * Link annotations, as real anchors and buttons over the page canvas.
 *
 * hayro already draws a link's appearance into the bitmap, so before this the demo
 * showed links and did nothing when you clicked them. What was missing was never the
 * pixels, it was knowing where the regions are — which is exactly what `doc.links`
 * added.
 *
 * Positions come from `scaleRect`, the same 72-DPI page space the search highlights
 * use, so a link sits on its own glyphs at any zoom and on a rotated page.
 *
 * These are focusable elements rather than hit-testing on a click handler: a keyboard
 * can then tab through a table of contents, and a URI link gets the browser's own
 * status bar and context menu for free.
 */
export function Links({ doc, index, scale, onSelect }: Props) {
  const [links, setLinks] = useState<readonly PageLink[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLinks([]);
    doc.links(index).then(
      (next) => !cancelled && setLinks(next),
      () => !cancelled && setLinks([]),
    );
    return () => {
      cancelled = true;
    };
  }, [doc, index]);

  if (links.length === 0) return null;

  return (
    <div className="links">
      {links.map((link) => {
        const { x, y, width, height } = scaleRect(link.rect, scale);
        const style = { left: x, top: y, width, height };
        const key = `${link.rect.x},${link.rect.y},${target(link)}`;

        if (link.target.kind === 'uri') {
          const { uri } = link.target;
          return (
            <a
              key={key}
              className="link-hit"
              style={style}
              href={uri}
              target="_blank"
              // `noopener` matters: the target page must not get a handle on the
              // window that opened it.
              rel="noreferrer noopener"
              title={link.alt ?? uri}
            >
              <span className="sr-only">{link.alt ?? uri}</span>
            </a>
          );
        }

        const { page } = link.target.dest;
        return (
          <button
            key={key}
            type="button"
            className="link-hit"
            style={style}
            onClick={() => onSelect(page)}
            title={link.alt ?? `Page ${page + 1}`}
          >
            <span className="sr-only">
              {link.alt ?? `Go to page ${page + 1}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A stable-enough key: two links never share both a corner and a target. */
function target(link: PageLink): string {
  return link.target.kind === 'uri'
    ? link.target.uri
    : `p${link.target.dest.page}`;
}
