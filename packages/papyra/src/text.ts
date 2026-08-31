import type {
  PageText as NativePageText,
  TextLine as NativeTextLine,
} from '@build-qube/papyra-native';

/**
 * A run of glyphs sharing one baseline.
 *
 * Geometry runs *along the baseline* rather than being a rectangle per character. A
 * page is thousands of glyphs and four numbers each is far more than a search needs;
 * an origin, a direction and a list of distances reconstruct any substring's
 * quadrilateral exactly, and keep working when the text is rotated.
 */
export interface TextLine {
  /** The line's characters, with spaces reinserted between glyph runs. */
  readonly text: string;
  /**
   * Distance along the baseline to the start of each character, plus the end of the
   * last — one entry more than `text.length`.
   */
  readonly offsets: Float32Array;
  /** Start of the baseline, x. */
  readonly x: number;
  /** Start of the baseline, y. */
  readonly y: number;
  /** Unit vector along the baseline, x. `(1, 0)` for ordinary horizontal text. */
  readonly dx: number;
  /** Unit vector along the baseline, y. */
  readonly dy: number;
  /** Extent above the baseline, perpendicular to it. */
  readonly ascent: number;
  /** Extent below the baseline. */
  readonly descent: number;
  /**
   * Marked-content id of the line's **first** glyph, joining this line to the
   * structure tree — see {@link StructNode.content} and {@link readingOrder}.
   *
   * Absent on an untagged page, and on a tagged page for content the document left
   * outside any marked-content sequence, which is where running heads and page
   * numbers usually live.
   *
   * Optional rather than `null` because lines cross the binding as-is rather than
   * being rebuilt one by one — a page is thousands of them — so an absent id arrives
   * as `undefined` and saying otherwise would be a lie about the runtime shape.
   *
   * The *first* glyph rather than all of them: lines are grouped by geometry and
   * tagging does not change that grouping, so a line whose middle switches to a
   * `Span` stays one line. Ordering by the element that starts a line is sound;
   * reading this as "every character here belongs to that element" is not.
   */
  readonly mcid?: number;
}

/**
 * The text of one page.
 *
 * Coordinates are **the page as rendered at 72 DPI**: pixels from the top-left corner
 * with y increasing downwards, page rotation and crop box already applied. That makes
 * them the same space as {@link PageSize}, so lining text up with a rendered bitmap is
 * one multiply — `rendered.width / pageSize.width`, or equivalently `dpi / 72`.
 */
export interface PageText {
  /** 0-based index of the page this text came from. */
  readonly page: number;
  /**
   * The page's lines, in the order the content stream drew them — which is not
   * necessarily reading order, because a PDF is under no obligation to draw text in
   * the order a human reads it.
   */
  readonly lines: readonly TextLine[];
  /**
   * Glyphs the page drew that no encoding could map back to Unicode.
   *
   * Non-zero **alongside lines** is the case worth warning about: a paper whose
   * headings use a standard font and whose body uses an embedded subset with no
   * `ToUnicode` cmap looks searchable and mostly is not. Non-zero with no lines is a
   * page of text nothing can read; zero with no lines is a page with no text, which
   * may be a scan. Telling a user which they are looking at is the difference between
   * "no results" and "this cannot be searched".
   *
   * Weigh it against the characters actually extracted — a few undecodable ornaments
   * are not a lost paragraph.
   */
  readonly undecodedGlyphs: number;
}

/** Four corners, clockwise from the top-left of the text's own orientation. */
export interface Quad {
  /** Top-left, x. */
  readonly x0: number;
  /** Top-left, y. */
  readonly y0: number;
  /** Top-right, x. */
  readonly x1: number;
  /** Top-right, y. */
  readonly y1: number;
  /** Bottom-right, x. */
  readonly x2: number;
  /** Bottom-right, y. */
  readonly y2: number;
  /** Bottom-left, x. */
  readonly x3: number;
  /** Bottom-left, y. */
  readonly y3: number;
}

/** An axis-aligned rectangle. */
export interface Rect {
  /** Left edge. */
  readonly x: number;
  /** Top edge — y increases downwards, so this is the smaller of the two. */
  readonly y: number;
  /** Width. */
  readonly width: number;
  /** Height. */
  readonly height: number;
}

/** @internal */
export function toPageText(page: number, native: NativePageText): PageText {
  return {
    page,
    lines: native.lines as readonly NativeTextLine[] as readonly TextLine[],
    undecodedGlyphs: native.undecodedGlyphs,
  };
}

/** Every character on the page a search can see. */
export function pageString(text: PageText): string {
  return text.lines.map((line) => line.text).join('\n');
}

/** Roughly how much memory a page's text holds, for cache accounting. */
export function pageTextBytes(text: PageText): number {
  let bytes = 64;
  for (const line of text.lines) {
    bytes += line.text.length * 2 + line.offsets.byteLength + 48;
  }
  return bytes;
}

/**
 * The quadrilateral covering `line`'s characters in `[start, end)`.
 *
 * Built from the baseline rather than from a stored rectangle, so rotated text — a
 * drawing's vertical dimension labels, a sideways table header — gets a box at its own
 * angle instead of an axis-aligned one that covers the wrong pixels.
 */
export function lineQuad(line: TextLine, start: number, end: number): Quad {
  const last = line.offsets.length - 1;
  const from = line.offsets[clamp(start, 0, last)] ?? 0;
  const to = line.offsets[clamp(end, 0, last)] ?? from;

  // Rotating the baseline direction a quarter turn gives "up" — negative y, since the
  // space has y increasing downwards.
  const upX = line.dy;
  const upY = -line.dx;

  const ax = line.x + line.dx * from;
  const ay = line.y + line.dy * from;
  const bx = line.x + line.dx * to;
  const by = line.y + line.dy * to;

  return {
    x0: ax + upX * line.ascent,
    y0: ay + upY * line.ascent,
    x1: bx + upX * line.ascent,
    y1: by + upY * line.ascent,
    x2: bx - upX * line.descent,
    y2: by - upY * line.descent,
    x3: ax - upX * line.descent,
    y3: ay - upY * line.descent,
  };
}

/** The smallest upright rectangle containing `quad`. */
export function quadBounds(quad: Quad): Rect {
  const xs = [quad.x0, quad.x1, quad.x2, quad.x3];
  const ys = [quad.y0, quad.y1, quad.y2, quad.y3];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Scale a rect from 72-DPI page space into a render's pixels. */
export function scaleRect(rect: Rect, scale: number): Rect {
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** Scale a quad from 72-DPI page space into a render's pixels. */
export function scaleQuad(quad: Quad, scale: number): Quad {
  return {
    x0: quad.x0 * scale,
    y0: quad.y0 * scale,
    x1: quad.x1 * scale,
    y1: quad.y1 * scale,
    x2: quad.x2 * scale,
    y2: quad.y2 * scale,
    x3: quad.x3 * scale,
    y3: quad.y3 * scale,
  };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
