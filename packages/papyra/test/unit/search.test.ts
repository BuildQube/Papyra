import { describe, expect, test } from 'bun:test';
import { findRanges, searchPageText } from '../../src/search.js';
import type { PageText, TextLine } from '../../src/text.js';

/**
 * A line of 10pt-wide characters on a 12pt baseline, so offsets and quads are
 * predictable arithmetic rather than font metrics.
 */
function line(text: string, x: number, y: number): TextLine {
  return {
    text,
    offsets: new Float32Array(
      Array.from({ length: text.length + 1 }, (_, i) => i * 10),
    ),
    x,
    y,
    dx: 1,
    dy: 0,
    ascent: 9,
    descent: 3,
  };
}

function page(...lines: TextLine[]): PageText {
  return { page: 0, lines, undecodedGlyphs: 0 };
}

describe('findRanges', () => {
  test('finds every occurrence, in source coordinates', () => {
    expect(findRanges('a cat and a cat', 'cat')).toEqual([
      [2, 5],
      [12, 15],
    ]);
  });

  test('is case-insensitive by default and exact when asked', () => {
    expect(findRanges('The Cat', 'cat')).toEqual([[4, 7]]);
    expect(findRanges('The Cat', 'cat', { caseSensitive: true })).toEqual([]);
    expect(findRanges('The Cat', 'Cat', { caseSensitive: true })).toEqual([
      [4, 7],
    ]);
  });

  test('folds diacritics by default, and respects them when asked', () => {
    // Users type what is on their keyboard.
    expect(findRanges('année', 'annee')).toEqual([[0, 5]]);
    expect(findRanges('année', 'ANNEE')).toEqual([[0, 5]]);
    expect(findRanges('année', 'annee', { ignoreDiacritics: false })).toEqual(
      [],
    );
    expect(findRanges('année', 'année', { ignoreDiacritics: false })).toEqual([
      [0, 5],
    ]);
  });

  test('a folded match still reports the source range it covers', () => {
    // 'ﬁ' is one source character standing for two folded ones. Reporting the folded
    // length would slice the wrong substring out of the original.
    const ranges = findRanges('the ﬁle', 'file');
    expect(ranges).toEqual([[4, 7]]);
    expect('the ﬁle'.slice(4, 7)).toBe('ﬁle');
  });

  test('matches across a line break', () => {
    // The page string joins lines with a newline; a phrase does not stop at one.
    expect(findRanges('for Dynamic\nLanguages', 'dynamic languages')).toEqual([
      [4, 21],
    ]);
  });

  test('collapses runs of whitespace', () => {
    expect(findRanges('Hello   World', 'hello world')).toEqual([[0, 13]]);
  });

  test('whole words rejects a partial hit', () => {
    expect(findRanges('unsearchable', 'search')).toEqual([[2, 8]]);
    expect(findRanges('unsearchable', 'search', { wholeWords: true })).toEqual(
      [],
    );
    expect(findRanges('a search here', 'search', { wholeWords: true })).toEqual(
      [[2, 8]],
    );
  });

  test('finds overlapping occurrences', () => {
    expect(findRanges('aaa', 'aa')).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  test('an empty or whitespace query matches nothing', () => {
    expect(findRanges('anything', '')).toEqual([]);
    expect(findRanges('anything', '   ')).toEqual([]);
  });
});

describe('searchPageText', () => {
  test('places a quad over the matched characters', () => {
    const hits = searchPageText(page(line('the cat sat', 100, 200)), 'cat');
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    // 'cat' is characters 4..7, so 40pt to 70pt along a baseline starting at x=100.
    expect(hit?.rects[0]).toEqual({
      x: 140,
      y: 191,
      width: 30,
      height: 12,
    });
  });

  test('a match spanning two lines gets one quad per line', () => {
    const hits = searchPageText(
      page(line('for Dynamic', 100, 50), line('Languages', 100, 70)),
      'dynamic languages',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.quads).toHaveLength(2);
    expect(hits[0]?.rects[0]?.y).toBe(41);
    expect(hits[0]?.rects[1]?.y).toBe(61);
    // The second quad covers the whole of the second line.
    expect(hits[0]?.rects[1]?.width).toBe(90);
  });

  test('reports the document spelling, not the query', () => {
    const hits = searchPageText(page(line('année 2019', 0, 0)), 'ANNEE');
    expect(hits[0]?.text).toBe('année');
  });

  test('carries context with the match located inside it', () => {
    const hits = searchPageText(
      page(line('the quick brown fox jumps', 0, 0)),
      'brown',
    );
    const hit = hits[0];
    expect(hit).toBeDefined();
    expect(hit?.context.slice(hit.contextStart, hit.contextEnd)).toBe('brown');
  });

  test('a rotated line gets a quad at its own angle', () => {
    const upright: TextLine = { ...line('cat', 100, 200), dx: 0, dy: 1 };
    const hits = searchPageText(page(upright), 'cat');
    const quad = hits[0]?.quads[0];
    expect(quad).toBeDefined();
    // Running downwards, the box extends 30pt in y and 12pt in x.
    const rect = hits[0]?.rects[0];
    expect(rect?.width).toBe(12);
    expect(rect?.height).toBe(30);
  });

  test('no match yields nothing', () => {
    expect(searchPageText(page(line('the cat', 0, 0)), 'dog')).toEqual([]);
  });
});
