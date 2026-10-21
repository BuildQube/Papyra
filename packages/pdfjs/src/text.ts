import type { TextLine } from '@build-qube/papyra/core';

/** The part of a pdf.js `TextItem` this reads. */
export interface PdfjsTextItem {
  readonly str: string;
  /** Text space to PDF user space, `[a, b, c, d, e, f]`. */
  readonly transform: readonly number[];
  /** Advance along the baseline, in user space. */
  readonly width: number;
  readonly fontName: string;
  readonly hasEOL: boolean;
}

/** The part of a pdf.js font style this reads: ascent and descent per unit size. */
export interface PdfjsTextStyle {
  readonly ascent: number;
  readonly descent: number;
}

type Matrix = readonly number[];

function multiply(m: Matrix, n: Matrix): number[] {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = m;
  const [g = 0, h = 0, i = 0, j = 0, k = 0, l = 0] = n;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

/** A line being assembled: its geometry, and its characters' offsets so far. */
interface Open {
  text: string;
  offsets: number[];
  x: number;
  y: number;
  dx: number;
  dy: number;
  ascent: number;
  descent: number;
  size: number;
  /** Distance along the baseline where the last character ended. */
  end: number;
}

function close(line: Open): TextLine {
  return {
    text: line.text,
    offsets: Float32Array.from([...line.offsets, line.end]),
    x: line.x,
    y: line.y,
    dx: line.dx,
    dy: line.dy,
    ascent: line.ascent,
    descent: line.descent,
  };
}

/**
 * pdf.js text items as papyra's lines, in papyra's space.
 *
 * `viewport` is the page's `getViewport({ scale: 1 }).transform`, which maps user
 * space to the page as rendered at 72 DPI — top-left origin, rotation applied — the
 * space hayro's text lands in, so highlights and links line up the same either way.
 *
 * pdf.js gives an item one width, not one per glyph, so a character's offset is an
 * even share of its item's. Highlights are exact at item edges and approximate inside
 * them. Items are joined into a line while they continue along one baseline, with a
 * space put back where they leave a gap, so a phrase split across items — a font
 * change mid-sentence — is still found by search.
 */
export function linesFromItems(
  items: readonly PdfjsTextItem[],
  styles: Readonly<Record<string, PdfjsTextStyle | undefined>>,
  viewport: Matrix,
): TextLine[] {
  const lines: TextLine[] = [];
  let open: Open | null = null;

  for (const item of items) {
    if (item.str.length > 0) {
      const m = multiply(viewport, item.transform);
      const [a = 0, b = 0, c = 0, d = 0, x = 0, y = 0] = m;
      const run = Math.hypot(a, b);
      const size = Math.hypot(c, d);
      if (run > 0 && size > 0) {
        const dx = a / run;
        const dy = b / run;
        // `width` is in user space; the viewport at scale 1 keeps lengths.
        const width = item.width;
        const along = open
          ? (x - open.x) * open.dx + (y - open.y) * open.dy
          : 0;
        const across = open
          ? Math.abs((x - open.x) * open.dy - (y - open.y) * open.dx)
          : 0;
        const continues =
          open !== null &&
          dx * open.dx + dy * open.dy > 0.999 &&
          across < 0.3 * open.size &&
          along > open.end - 0.5 * open.size &&
          along - open.end < 3 * open.size;

        if (!continues) {
          if (open) lines.push(close(open));
          const style = styles[item.fontName];
          open = {
            text: '',
            offsets: [],
            x,
            y,
            dx,
            dy,
            ascent: size * (style?.ascent ?? 0.8),
            descent: size * Math.abs(style?.descent ?? -0.2),
            size,
            end: 0,
          };
        }
        const line = open as Open;
        const start = continues ? along : 0;
        const gap = start - line.end;
        if (
          continues &&
          gap > 0.15 * line.size &&
          !/\s$/.test(line.text) &&
          !/^\s/.test(item.str)
        ) {
          line.text += ' ';
          line.offsets.push(line.end);
        }
        const step = width / item.str.length;
        for (let i = 0; i < item.str.length; i++) {
          line.offsets.push(start + step * i);
        }
        line.text += item.str;
        line.end = start + width;
      }
    }
    if (item.hasEOL && open) {
      lines.push(close(open));
      open = null;
    }
  }
  if (open) lines.push(close(open));
  return lines;
}
