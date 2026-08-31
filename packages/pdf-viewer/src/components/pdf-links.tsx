import type { Document, PageLink, Viewport } from '@build-qube/papyra';
import { viewportRect } from '@build-qube/papyra';
import { useEffect, useState } from 'react';

/** Props for {@link Links}. */
export interface LinksProps {
  /** The open document. */
  doc: Document;
  /** The 0-based page whose annotations to read. */
  index: number;
  /**
   * Page space to CSS pixels, rotation included — the same viewport highlights use.
   *
   * A viewport rather than a bare scale because a rotated view has to turn the hit
   * regions with the pixels. Getting this wrong does not look broken, it just puts
   * every link a quarter turn from its own glyphs.
   */
  pageViewport: Viewport;
  /** Called with a 0-based page index when the reader picks a page. */
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
 * Positions come from `viewportRect`, the same mapping the search highlights use, so a
 * link sits on its own glyphs at any zoom, on a page the document itself rotated, and
 * at any angle the reader has turned the view to.
 *
 * These are focusable elements rather than hit-testing on a click handler: a keyboard
 * can then tab through a table of contents, and a URI link gets the browser's own
 * status bar and context menu for free.
 */
export function Links({ doc, index, pageViewport, onSelect }: LinksProps) {
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
    <div className="pointer-events-none absolute inset-0">
      {links.map((link) => {
        const { x, y, width, height } = viewportRect(link.rect, pageViewport);
        const style = { left: x, top: y, width, height };
        const key = `${link.rect.x},${link.rect.y},${target(link)}`;

        if (link.target.kind === 'uri') {
          const { uri } = link.target;
          return (
            <a
              key={key}
              className="pointer-events-auto absolute cursor-pointer rounded-xs border-0 bg-transparent p-0 ring-1 ring-transparent ring-inset transition-[background-color,box-shadow] duration-100 hover:bg-primary/20 hover:ring-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
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
            className="pointer-events-auto absolute cursor-pointer rounded-xs border-0 bg-transparent p-0 ring-1 ring-transparent ring-inset transition-[background-color,box-shadow] duration-100 hover:bg-primary/20 hover:ring-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
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
