import type { Quad, SearchMatch } from '@build-qube/papyra';

interface Props {
  matches: readonly SearchMatch[];
  /** The match to draw as current, if it is on this page. */
  active: SearchMatch | null;
  /** Page-space (72 DPI) to rendered-pixel scale. */
  scale: number;
  /** Size of the canvas the overlay sits on, in CSS pixels. */
  width: number;
  height: number;
}

/**
 * Search highlights, drawn as an SVG over the page canvas.
 *
 * Polygons rather than rectangles because papyra reports the exact corners: a
 * drawing's rotated dimension labels get a box at their own angle, which an
 * axis-aligned rectangle would smear across everything nearby.
 */
export function Highlights({ matches, active, scale, width, height }: Props) {
  if (matches.length === 0) return null;

  return (
    <svg
      className="highlights"
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
            key={points(quad, 1)}
            className={match === active ? 'hit active' : 'hit'}
            points={points(quad, scale)}
          />
        )),
      )}
    </svg>
  );
}

function points(quad: Quad, s: number): string {
  return (
    `${quad.x0 * s},${quad.y0 * s} ${quad.x1 * s},${quad.y1 * s} ` +
    `${quad.x2 * s},${quad.y2 * s} ${quad.x3 * s},${quad.y3 * s}`
  );
}
