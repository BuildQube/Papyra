import { describe, expect, test } from 'bun:test';
import type { StructEntry } from '@build-qube/papyra-native';
import {
  buildStructTree,
  readingOrder,
  structuredPageString,
  walkStructTree,
} from '../../src/structure.js';
import type { PageText, TextLine } from '../../src/text.js';

/** A flat entry with everything but the fields under test defaulted. */
function entry(
  role: string,
  level: number,
  overrides: Partial<StructEntry> = {},
): StructEntry {
  return {
    role,
    rawRole: role,
    level,
    content: [],
    alt: undefined,
    actualText: undefined,
    lang: undefined,
    title: undefined,
    ...overrides,
  };
}

/** Content on page 0. */
function mc(...mcids: number[]) {
  return mcids.map((mcid) => ({ page: 0, mcid }));
}

/** A line whose geometry is irrelevant to the test. */
function line(text: string, mcid?: number): TextLine {
  return {
    text,
    offsets: new Float32Array([0, text.length]),
    x: 0,
    y: 0,
    dx: 1,
    dy: 0,
    ascent: 9,
    descent: 3,
    ...(mcid === undefined ? {} : { mcid }),
  };
}

function pageText(lines: TextLine[], page = 0): PageText {
  return { page, lines, undecodedGlyphs: 0 };
}

describe('buildStructTree', () => {
  test('rebuilds nesting from levels', () => {
    const tree = buildStructTree([
      entry('Document', 0),
      entry('H1', 1),
      entry('Sect', 1),
      entry('P', 2),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.role).toBe('Document');
    expect(tree[0]?.children.map((n) => n.role)).toEqual(['H1', 'Sect']);
    expect(tree[0]?.children[1]?.children.map((n) => n.role)).toEqual(['P']);
  });

  test('normalises absent attributes to null', () => {
    const [node] = buildStructTree([entry('Figure', 0)]);
    expect(node?.alt).toBeNull();
    expect(node?.actualText).toBeNull();
    expect(node?.lang).toBeNull();
    expect(node?.title).toBeNull();
  });

  test('keeps the raw role beside the mapped one', () => {
    const [node] = buildStructTree([entry('H1', 0, { rawRole: 'Heading1' })]);
    expect(node?.role).toBe('H1');
    expect(node?.rawRole).toBe('Heading1');
  });

  test('clamps a level that skips a step rather than dropping the node', () => {
    // Our own walker cannot emit this; a malformed document should flatten.
    const tree = buildStructTree([entry('Document', 0), entry('P', 5)]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children.map((n) => n.role)).toEqual(['P']);
  });

  test('walks depth-first with depth', () => {
    const tree = buildStructTree([
      entry('Document', 0),
      entry('H1', 1),
      entry('P', 1),
    ]);
    expect(
      [...walkStructTree(tree)].map(({ node, depth }) => [node.role, depth]),
    ).toEqual([
      ['Document', 0],
      ['H1', 1],
      ['P', 1],
    ]);
  });
});

describe('readingOrder', () => {
  /** Two columns drawn interleaved, tagged in the order they should be read. */
  const tree = buildStructTree([
    entry('Document', 0),
    entry('P', 1, { content: mc(0, 2) }),
    entry('P', 1, { content: mc(1, 3) }),
  ]);

  test('puts interleaved content back into declared order', () => {
    const text = pageText([
      line('left one', 0),
      line('right one', 1),
      line('left two', 2),
      line('right two', 3),
    ]);

    expect(readingOrder(text, tree).map(({ line: l }) => l.text)).toEqual([
      'left one',
      'left two',
      'right one',
      'right two',
    ]);
  });

  test('reports the element that claims each line', () => {
    const text = pageText([line('left one', 0), line('right one', 1)]);
    const [first, second] = readingOrder(text, tree);
    expect(first?.node?.role).toBe('P');
    // Different elements, both `P` — identity is what matters, not the role.
    expect(first?.node).not.toBe(second?.node);
  });

  test('keeps several lines inside one element in content-stream order', () => {
    const wrapped = buildStructTree([entry('P', 0, { content: mc(0) })]);
    const text = pageText([
      line('first', 0),
      line('second', 0),
      line('third', 0),
    ]);
    expect(readingOrder(text, wrapped).map(({ line: l }) => l.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  test('places untagged lines last rather than dropping them', () => {
    const text = pageText([
      line('page 7'),
      line('left one', 0),
      line('right one', 1),
    ]);
    const ordered = readingOrder(text, tree);
    expect(ordered.map(({ line: l }) => l.text)).toEqual([
      'left one',
      'right one',
      'page 7',
    ]);
    expect(ordered.at(-1)?.node).toBeNull();
  });

  test('drops untagged lines on request', () => {
    const text = pageText([line('page 7'), line('left one', 0)]);
    expect(
      readingOrder(text, tree, { includeUntagged: false }).map(
        ({ line: l }) => l.text,
      ),
    ).toEqual(['left one']);
  });

  test('ignores content belonging to another page', () => {
    const other = buildStructTree([
      entry('P', 0, { content: [{ page: 1, mcid: 0 }] }),
    ]);
    const text = pageText([line('mine', 0)]);
    // The mcid matches, the page does not, so nothing claims the line.
    expect(readingOrder(text, other)[0]?.node).toBeNull();
  });

  test('leaves an untagged page in content-stream order', () => {
    const text = pageText([line('one'), line('two'), line('three')]);
    expect(readingOrder(text, []).map(({ line: l }) => l.text)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  test('an mcid claimed twice goes to the earlier element', () => {
    const duplicated = buildStructTree([
      entry('H1', 0, { content: mc(0) }),
      entry('P', 0, { content: mc(0) }),
    ]);
    const text = pageText([line('once', 0)]);
    expect(readingOrder(text, duplicated)[0]?.node?.role).toBe('H1');
  });

  test('structuredPageString joins in declared order', () => {
    const text = pageText([
      line('left one', 0),
      line('right one', 1),
      line('left two', 2),
    ]);
    expect(structuredPageString(text, tree)).toBe(
      'left one\nleft two\nright one',
    );
  });
});
