import type { Quad, SearchMatch, Viewport } from '@build-qube/papyra';
import { viewportQuad } from '@build-qube/papyra';
import { cn } from '@/lib/utils';

/** Props for {@link Highlights}. */
export interface HighlightsProps {
  /** The matches on this page. */
  matches: readonly SearchMatch[];
  /** The match to draw as current, if it is on this page. */
  active: SearchMatch | null;
  /** Page space to CSS pixels, rotation included — the same viewport links use. */
  pageViewport: Viewport;
  /** Size of the canvas the overlay sits on, in CSS pixels. */
  width: number;
  /** Height of the canvas the overlay sits on, in CSS pixels. */
  height: number;
}

/**
 * Search highlights, drawn as an SVG over the page canvas.
 *
 * Polygons rather than rectangles because papyra reports the exact corners: a
 * drawing's rotated dimension labels get a box at their own angle, which an
 * axis-aligned rectangle would smear across everything nearby. `viewportQuad` keeps
 * that true when the reader turns the view as well — quarter turns move the corners
 * without reordering them, so the polygon never folds over itself.
 */
export function Highlights({
  matches,
  active,
  pageViewport,
  width,
  height,
}: HighlightsProps) {
  if (matches.length === 0) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0 size-full"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <title>Search highlights</title>
      {matches.flatMap((match) =>
        match.quads.map((quad) => (
          // A quad's own corners identify it: two matches never share a position.
          <polygon
            key={points(quad)}
            className={cn(
              'fill-[#ffd54a] [fill-opacity:0.35]',
              match === active && 'fill-[#ff8a3d] [fill-opacity:0.55]',
            )}
            points={points(viewportQuad(quad, pageViewport))}
          />
        )),
      )}
    </svg>
  );
}

function points(quad: Quad): string {
  return (
    `${quad.x0},${quad.y0} ${quad.x1},${quad.y1} ` +
    `${quad.x2},${quad.y2} ${quad.x3},${quad.y3}`
  );
}
