import type {
  OutlineDestination as NativeDestination,
  OutlineEntry as NativeEntry,
} from '@build-qube/papyra-native';

/** How a destination positions the page in the window (PDF 32000-1, 12.3.2.2). */
export type DestinationKind =
  | 'XYZ'
  | 'Fit'
  | 'FitH'
  | 'FitV'
  | 'FitR'
  | 'FitB'
  | 'FitBH'
  | 'FitBV';

/**
 * Where an outline entry points.
 *
 * Coordinates are PDF points measured from the page's bottom-left corner — the same
 * space as {@link PageSize} — so converting to rendered pixels is
 * `(pt / 72) * dpi`. `null` means "leave this axis as it is", which is how the spec
 * spells a destination that scrolls vertically but not horizontally.
 */
export interface OutlineDestination {
  /** 0-based page index. */
  readonly page: number;
  /** Which of the eight positioning modes the destination uses. */
  readonly kind: DestinationKind;
  /** Left edge, for `'XYZ'`, `'FitV'`, `'FitBV'` and `'FitR'`. */
  readonly left: number | null;
  /** Top edge, for `'XYZ'`, `'FitH'`, `'FitBH'` and `'FitR'`. */
  readonly top: number | null;
  /** Right edge. Only ever set for `'FitR'`. */
  readonly right: number | null;
  /** Bottom edge. Only ever set for `'FitR'`. */
  readonly bottom: number | null;
  /** Only ever set for `'XYZ'`. A zoom of 0 means "unchanged" and reads as `null`. */
  readonly zoom: number | null;
}

/** A node in the document outline. */
export interface OutlineNode {
  /** The entry's label, already decoded from UTF-16, UTF-8 or PDFDocEncoding. */
  readonly title: string;
  /**
   * `null` for a container that groups children without pointing anywhere itself, and
   * for entries whose action leaves this document (a URL, or another file).
   */
  readonly dest: OutlineDestination | null;
  /** `dest.page`, hoisted — the only field most viewers need. */
  readonly page: number | null;
  /** The document asks for this title to be drawn bold. */
  readonly bold: boolean;
  /** The document asks for this title to be drawn italic. */
  readonly italic: boolean;
  /** The document asks for this node to start expanded. */
  readonly open: boolean;
  /** Nested entries, empty for a leaf. */
  readonly children: OutlineNode[];
}

const KINDS = new Set<string>([
  'XYZ',
  'Fit',
  'FitH',
  'FitV',
  'FitR',
  'FitB',
  'FitBH',
  'FitBV',
]);

/** napi omits absent numbers rather than nulling them; normalise to one shape. */
function destination(
  dest: NativeDestination | undefined,
): OutlineDestination | null {
  if (!dest) return null;
  return {
    page: dest.page,
    // Unknown view kinds are read as `Fit` in Rust, so this only guards against a
    // binding and a wrapper that have drifted apart.
    kind: (KINDS.has(dest.kind) ? dest.kind : 'Fit') as DestinationKind,
    left: dest.left ?? null,
    top: dest.top ?? null,
    right: dest.right ?? null,
    bottom: dest.bottom ?? null,
    zoom: dest.zoom ?? null,
  };
}

/**
 * Rebuild the tree from the flat pre-order list the bindings return.
 *
 * A stack indexed by level is enough because pre-order guarantees a node's parent is
 * the most recent node one level shallower. Levels that skip a step cannot come from
 * our own walker, but are clamped rather than trusted — a malformed document should
 * produce a flatter outline, not a crash.
 */
export function buildOutlineTree(
  entries: readonly NativeEntry[],
): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  for (const entry of entries) {
    const dest = destination(entry.dest);
    const node: OutlineNode = {
      title: entry.title,
      dest,
      page: dest?.page ?? null,
      bold: entry.bold,
      italic: entry.italic,
      open: entry.open,
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

/** Walk an outline depth-first, yielding each node with its depth. */
export function* walkOutline(
  nodes: readonly OutlineNode[],
  depth = 0,
): Generator<{
  /** The entry. */
  node: OutlineNode;
  /** How deep it sits, 0 for a root. Useful as an indent. */
  depth: number;
}> {
  for (const node of nodes) {
    yield { node, depth };
    yield* walkOutline(node.children, depth + 1);
  }
}
