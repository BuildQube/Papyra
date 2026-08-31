import type {
  StructEntry as NativeEntry,
  MarkedContent as NativeMarkedContent,
} from '@build-qube/papyra-native';
import type { PageText, TextLine } from './text.js';

/**
 * One run of page content owned by a {@link StructNode}.
 *
 * The pair is what makes the join work: a marked-content id is only unique within a
 * single page's content stream, so an id on its own addresses nothing.
 */
export interface MarkedContent {
  /** 0-based page index. */
  readonly page: number;
  /** Matches {@link TextLine.mcid} on that page. */
  readonly mcid: number;
}

/**
 * A node in the document structure tree.
 *
 * A tagged PDF states what its content *means* — which runs are a heading, which are
 * a table cell — and, more usefully than either, what order it is meant to be read
 * in. Nothing else in a PDF carries that: {@link PageText.lines} is content-stream
 * order, which interleaves the columns of a two-column page.
 */
export interface StructNode {
  /**
   * Standard structure type: `'Document'`, `'H1'`, `'P'`, `'Table'`, `'TD'`,
   * `'Figure'`, and the rest of ISO 32000-1's set.
   *
   * Already resolved through the document's `/RoleMap`, so a file that tags its
   * headings `Heading1` and maps that onto `H1` reports `'H1'` here. Word and
   * InDesign both emit such files, so matching on {@link StructNode.rawRole} instead
   * misses a large share of real tagged documents.
   */
  readonly role: string;
  /**
   * The document's own tag, before `/RoleMap`. Equal to {@link StructNode.role}
   * unless the document remapped it.
   */
  readonly rawRole: string;
  /**
   * Content this element owns directly, in the order the tree declares it.
   *
   * Empty for a pure container — a `Sect` whose text all belongs to the `P`s beneath
   * it — which is most interior nodes.
   */
  readonly content: readonly MarkedContent[];
  /** `/Alt`: replacement text for a figure, and the only text an image has. */
  readonly alt: string | null;
  /**
   * `/ActualText`: text that replaces the content rather than describing it, which is
   * how a document spells out a ligature or a decorative glyph.
   */
  readonly actualText: string | null;
  /** `/Lang`: a BCP 47 tag overriding the document language for this subtree. */
  readonly lang: string | null;
  /** `/T`: a human-readable title for the element, such as a table's caption. */
  readonly title: string | null;
  /** Nested elements, empty for a leaf. */
  readonly children: StructNode[];
}

/**
 * Rebuild the tree from the flat pre-order list the bindings return.
 *
 * The same stack-by-level pass {@link buildOutlineTree} uses, and correct for the same
 * reason: pre-order guarantees a node's parent is the most recent node one level
 * shallower. A level that skips a step cannot come from our own walker, and is clamped
 * rather than trusted — a malformed document should flatten, not crash.
 */
export function buildStructTree(entries: readonly NativeEntry[]): StructNode[] {
  const roots: StructNode[] = [];
  const stack: StructNode[] = [];

  for (const entry of entries) {
    const node: StructNode = {
      role: entry.role,
      rawRole: entry.rawRole,
      content: entry.content as readonly NativeMarkedContent[],
      alt: entry.alt ?? null,
      actualText: entry.actualText ?? null,
      lang: entry.lang ?? null,
      title: entry.title ?? null,
      children: [],
    };

    const level = Math.min(entry.level, stack.length);
    stack.length = level;
    const parent = stack[level - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }

  return roots;
}

/** Walk a structure tree depth-first, yielding each node with its depth. */
export function* walkStructTree(
  nodes: readonly StructNode[],
  depth = 0,
): Generator<{
  /** The element. */
  node: StructNode;
  /** How deep it sits, 0 for a root. */
  depth: number;
}> {
  for (const node of nodes) {
    yield { node, depth };
    yield* walkStructTree(node.children, depth + 1);
  }
}

/** One line of a page, with the structure element that claims it. */
export interface OrderedLine {
  /** The line, exactly as {@link PageText} reported it. */
  readonly line: TextLine;
  /**
   * The element whose content the line's first glyph sits in, or `null` for a line
   * the structure tree does not account for.
   */
  readonly node: StructNode | null;
}

/**
 * Put a page's lines into the reading order the document declares.
 *
 * This is the payoff of a tagged PDF and the one thing geometry cannot recover: on a
 * two-column page the content stream may draw both columns interleaved, and no line
 * grouping fixes that, because the drawing order genuinely is what it is. The
 * structure tree states the intended order outright.
 *
 * Lines are keyed by their first glyph's {@link TextLine.mcid}, so a line is placed by
 * the element that *starts* it. Ties — several lines inside one `P`, which is the
 * normal case for a wrapped paragraph — keep their original relative order, so within
 * an element the result is still the content stream's sequence. That is what makes
 * this safe on a document whose tagging is partial.
 *
 * Lines with no structure element go **last**, rather than being dropped: untagged
 * content is usually a running head or a page number, and losing it silently would be
 * worse than putting it at the end. Pass `includeUntagged: false` to drop them.
 *
 * Returns the lines in content-stream order, unchanged, when the page has no tagged
 * content at all — an untagged document is the common case and should not come back
 * empty or reshuffled.
 */
export function readingOrder(
  text: PageText,
  tree: readonly StructNode[],
  options: {
    /** Keep lines no element claims, at the end. Defaults to `true`. */
    readonly includeUntagged?: boolean;
  } = {},
): OrderedLine[] {
  const { includeUntagged = true } = options;

  // Pre-order position of the element owning each mcid on this page. Built once per
  // call: a tagged document tags every paragraph, so this is the whole tree, and
  // doing it per line would be quadratic on exactly the documents that use it.
  const owner = new Map<number, { node: StructNode; order: number }>();
  let order = 0;
  for (const { node } of walkStructTree(tree)) {
    const position = order++;
    for (const content of node.content) {
      if (content.page !== text.page) continue;
      // First writer wins: an mcid claimed twice is malformed, and the earlier
      // element is the one pre-order would have reached first anyway.
      if (!owner.has(content.mcid)) {
        owner.set(content.mcid, { node, order: position });
      }
    }
  }

  const ordered = text.lines.map((line, index) => {
    const found = line.mcid === undefined ? undefined : owner.get(line.mcid);
    return {
      line,
      node: found?.node ?? null,
      // Untagged lines sort after every tagged one.
      order: found?.order ?? Number.POSITIVE_INFINITY,
      index,
    };
  });

  if (owner.size === 0) {
    return includeUntagged
      ? ordered.map(({ line, node }) => ({ line, node }))
      : [];
  }

  // `index` breaks ties, which keeps the sort stable across engines rather than
  // relying on the specification's guarantee holding for every runtime we ship on.
  ordered.sort((a, b) => a.order - b.order || a.index - b.index);

  return ordered
    .filter((entry) => includeUntagged || entry.node !== null)
    .map(({ line, node }) => ({ line, node }));
}

/**
 * Every character of a page in declared reading order, one line per entry.
 *
 * The structure-aware counterpart to {@link pageString}; identical to it on an
 * untagged page.
 */
export function structuredPageString(
  text: PageText,
  tree: readonly StructNode[],
): string {
  return readingOrder(text, tree)
    .map(({ line }) => line.text)
    .join('\n');
}
