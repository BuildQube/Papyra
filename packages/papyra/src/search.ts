import {
  lineQuad,
  type PageText,
  type Quad,
  quadBounds,
  type Rect,
  type TextLine,
} from './text.js';

/** How loosely a query is allowed to match. Shared by {@link findRanges} and search. */
export interface MatchOptions {
  /** Default `false`. */
  caseSensitive?: boolean;
  /**
   * Treat `e` and `é` as the same letter. Default `true`.
   *
   * Users type what is on their keyboard, and a document written in French or German
   * is otherwise unsearchable to most of them.
   */
  ignoreDiacritics?: boolean;
  /** Require the match to start and end at a word boundary. Default `false`. */
  wholeWords?: boolean;
}

/** One occurrence of the query on a page. */
export interface SearchMatch {
  /** 0-based index of the page the hit is on. */
  readonly page: number;
  /** The matched text exactly as the document writes it. */
  readonly text: string;
  /** Surrounding text, for showing the hit in a results list. */
  readonly context: string;
  /** Where the match sits inside {@link context}. */
  readonly contextStart: number;
  /** End of the match inside {@link context}, exclusive. */
  readonly contextEnd: number;
  /**
   * One quadrilateral per line the match covers — more than one when a phrase runs
   * over a line break. Coordinates are 72-DPI page space; see {@link PageText}.
   */
  readonly quads: readonly Quad[];
  /** {@link quads}, as upright bounding boxes. */
  readonly rects: readonly Rect[];
}

/** How much of the surrounding line to keep either side of a hit. */
const CONTEXT_PADDING = 40;

/**
 * A page's characters, folded for comparison, with a map back to where each came from.
 *
 * The map is what makes folding safe. Case folding and ligature expansion both change
 * length — `ﬁ` becomes two characters, `ß` becomes two — so a match position in the
 * folded string is not a position in the original. Recording the origin of every
 * folded character keeps the two in step.
 */
interface Folded {
  text: string;
  /** `origin[i]` is the index in the source string that folded character `i` came from. */
  origin: number[];
}

/** Ligatures that carry no `ToUnicode` mapping arrive as a single character. */
const LIGATURES: Record<string, string> = {
  ﬀ: 'ff',
  ﬁ: 'fi',
  ﬂ: 'fl',
  ﬃ: 'ffi',
  ﬄ: 'ffl',
  ﬅ: 'st',
  ﬆ: 'st',
  Æ: 'AE',
  æ: 'ae',
  Œ: 'OE',
  œ: 'oe',
};

const COMBINING = /\p{M}/gu;

function fold(source: string, options: MatchOptions): Folded {
  const { caseSensitive = false, ignoreDiacritics = true } = options;
  let text = '';
  const origin: number[] = [];

  for (let i = 0; i < source.length; i++) {
    let piece = source[i] as string;

    // A line break is a place where a phrase may continue, not a barrier. Searching
    // for "dynamic languages" should find a title broken across two lines.
    if (piece === '\n' || piece === '\t') piece = ' ';

    piece = LIGATURES[piece] ?? piece;
    if (ignoreDiacritics) {
      piece = piece.normalize('NFD').replace(COMBINING, '');
      // A character that is *only* a combining mark folds away entirely.
      if (piece === '') continue;
    }
    if (!caseSensitive) piece = piece.toLowerCase();

    for (const c of piece) {
      text += c;
      origin.push(i);
    }
  }

  return { text, origin };
}

/** Collapse runs of whitespace so "Hello  World" matches "Hello World". */
function squash(folded: Folded): Folded {
  let text = '';
  const origin: number[] = [];
  let previousWasSpace = false;

  for (let i = 0; i < folded.text.length; i++) {
    const c = folded.text[i] as string;
    const isSpace = c === ' ';
    if (isSpace && previousWasSpace) continue;
    text += isSpace ? ' ' : c;
    origin.push(folded.origin[i] as number);
    previousWasSpace = isSpace;
  }
  return { text, origin };
}

const WORD = /[\p{L}\p{N}_]/u;

function isBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return true;
  return !WORD.test(text[index] as string);
}

/**
 * Where the query occurs in a page's text, as `[start, end)` in the *source* string.
 *
 * Exported for testing and for callers that hold their own page text.
 */
export function findRanges(
  source: string,
  query: string,
  options: MatchOptions = {},
): Array<[number, number]> {
  const needle = squash(fold(query, options)).text.trim();
  if (needle === '') return [];

  const haystack = squash(fold(source, options));
  const ranges: Array<[number, number]> = [];

  let at = 0;
  for (;;) {
    const found = haystack.text.indexOf(needle, at);
    if (found === -1) break;
    const end = found + needle.length;

    if (
      !options.wholeWords ||
      (isBoundary(haystack.text, found - 1) && isBoundary(haystack.text, end))
    ) {
      const start = haystack.origin[found] as number;
      // `end` is exclusive, so the last folded character's origin is the last source
      // character the match covers — and a source character may fold to several.
      const lastSource = haystack.origin[end - 1] as number;
      ranges.push([start, lastSource + 1]);
    }
    // Advance past the start, not past the end: overlapping occurrences of a
    // repetitive query ("aa" in "aaa") are still two hits.
    at = found + 1;
  }

  return ranges;
}

/** Which line a page-string index falls in, and where within it. */
interface Position {
  line: number;
  offset: number;
}

function locate(lines: readonly TextLine[], index: number): Position | null {
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as TextLine;
    const end = start + line.text.length;
    if (index < end) return { line: i, offset: index - start };
    // +1 for the '\n' the page string joins lines with.
    start = end + 1;
  }
  return null;
}

/**
 * Find `query` in one page's already-extracted text.
 *
 * Matching runs over the whole page rather than line by line, so a phrase broken
 * across a line break still matches — and comes back with one quadrilateral per line
 * it covers, which is what a highlight needs.
 */
export function searchPageText(
  text: PageText,
  query: string,
  options: MatchOptions = {},
): SearchMatch[] {
  const source = text.lines.map((line) => line.text).join('\n');
  const matches: SearchMatch[] = [];

  for (const [start, end] of findRanges(source, query, options)) {
    const from = locate(text.lines, start);
    // `end` is exclusive; step back to a character that is really inside the match.
    const to = locate(text.lines, end - 1);
    if (!from || !to) continue;

    const quads: Quad[] = [];
    for (let i = from.line; i <= to.line; i++) {
      const line = text.lines[i] as TextLine;
      const first = i === from.line ? from.offset : 0;
      const last = i === to.line ? to.offset + 1 : line.text.length;
      if (last > first) quads.push(lineQuad(line, first, last));
    }
    if (quads.length === 0) continue;

    const contextStart = Math.max(0, start - CONTEXT_PADDING);
    matches.push({
      page: text.page,
      text: source.slice(start, end),
      context: source
        .slice(contextStart, end + CONTEXT_PADDING)
        .replace(/\n/g, ' '),
      contextStart: start - contextStart,
      contextEnd: end - contextStart,
      quads,
      rects: quads.map(quadBounds),
    });
  }

  return matches;
}
