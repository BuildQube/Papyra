import { describe, expect, test } from 'bun:test';
import type { OutlineEntry } from '@build-qube/papyra-native';
import { buildOutlineTree, walkOutline } from '../../src/outline.js';

/** A flat entry with everything but the fields under test defaulted. */
function entry(
  title: string,
  level: number,
  overrides: Partial<OutlineEntry> = {},
): OutlineEntry {
  return {
    title,
    level,
    dest: undefined,
    bold: false,
    italic: false,
    open: false,
    ...overrides,
  };
}

const at = (page: number) => ({ page, kind: 'Fit' });

describe('buildOutlineTree', () => {
  test('nests by level, preserving order', () => {
    const tree = buildOutlineTree([
      entry('Part One', 0),
      entry('Chapter A', 1),
      entry('Section i', 2),
      entry('Chapter B', 1),
      entry('Part Two', 0),
    ]);

    expect(tree.map((n) => n.title)).toEqual(['Part One', 'Part Two']);
    expect(tree[0]?.children.map((n) => n.title)).toEqual([
      'Chapter A',
      'Chapter B',
    ]);
    expect(tree[0]?.children[0]?.children.map((n) => n.title)).toEqual([
      'Section i',
    ]);
  });

  test('closes several levels at once', () => {
    const tree = buildOutlineTree([
      entry('a', 0),
      entry('b', 1),
      entry('c', 2),
      entry('d', 3),
      entry('e', 0),
    ]);
    expect(tree).toHaveLength(2);
    expect(tree[1]?.title).toBe('e');
    expect(tree[1]?.children).toEqual([]);
  });

  test('clamps a level that skips a step rather than dropping the node', () => {
    // Our own walker increments one level at a time, so this only arises if a
    // binding and a wrapper drift apart. Flatter is the safe failure.
    const tree = buildOutlineTree([entry('a', 0), entry('b', 5)]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children.map((n) => n.title)).toEqual(['b']);
  });

  test('a first entry below level 0 still becomes a root', () => {
    const tree = buildOutlineTree([entry('orphan', 3)]);
    expect(tree.map((n) => n.title)).toEqual(['orphan']);
  });

  test('hoists the destination page and normalises absent numbers to null', () => {
    const tree = buildOutlineTree([
      entry('one', 0, { dest: { page: 4, kind: 'XYZ', top: 640 } }),
    ]);
    expect(tree[0]?.page).toBe(4);
    expect(tree[0]?.dest).toEqual({
      page: 4,
      kind: 'XYZ',
      left: null,
      top: 640,
      right: null,
      bottom: null,
      zoom: null,
    });
  });

  test('a destination-less entry is kept, with a null page', () => {
    const tree = buildOutlineTree([
      entry('Sheets', 0),
      entry('A101', 1, { dest: at(1) }),
    ]);
    expect(tree[0]?.dest).toBeNull();
    expect(tree[0]?.page).toBeNull();
    expect(tree[0]?.children[0]?.page).toBe(1);
  });

  test('carries the presentation flags through', () => {
    const tree = buildOutlineTree([
      entry('styled', 0, { bold: true, italic: true, open: true }),
    ]);
    expect(tree[0]).toMatchObject({ bold: true, italic: true, open: true });
  });

  test('falls back to Fit for a kind the wrapper does not know', () => {
    const tree = buildOutlineTree([
      entry('odd', 0, { dest: { page: 0, kind: 'Sideways' } }),
    ]);
    expect(tree[0]?.dest?.kind).toBe('Fit');
  });

  test('an empty outline is an empty array', () => {
    expect(buildOutlineTree([])).toEqual([]);
  });
});

describe('walkOutline', () => {
  test('yields depth-first with depths', () => {
    const tree = buildOutlineTree([
      entry('a', 0),
      entry('b', 1),
      entry('c', 2),
      entry('d', 0),
    ]);
    expect([...walkOutline(tree)].map((e) => [e.node.title, e.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 0],
    ]);
  });
});
