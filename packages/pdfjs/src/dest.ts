import type {
  DestinationKind,
  OutlineDestination,
} from '@build-qube/papyra/core';

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

/** A coordinate pdf.js left as `null`, or something that is not a number at all. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * An explicit destination as pdf.js returns it — `[pageRef, { name }, ...args]` — as
 * papyra's {@link OutlineDestination}, with the arguments named the way hayro names
 * them. Coordinates stay in PDF user space, as papyra's do.
 *
 * `pageIndex` resolves the first element, which is a page reference in a well-formed
 * file and a bare page number in some that are not. Null for anything that does not
 * resolve: a destination is a pointer into the file, and the file may be wrong.
 */
export async function toDestination(
  explicit: readonly unknown[] | null,
  pageIndex: (ref: unknown) => Promise<number>,
): Promise<OutlineDestination | null> {
  if (!explicit) return null;
  const [ref, mode, ...args] = explicit;
  const kind = (mode as { name?: unknown } | null)?.name;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null;

  let page: number;
  try {
    page = typeof ref === 'number' ? ref : await pageIndex(ref);
  } catch {
    return null;
  }

  const [a = null, b = null, c = null, d = null] = args.map(num);
  const none = {
    left: null,
    top: null,
    right: null,
    bottom: null,
    zoom: null,
  };
  const at = (fields: Partial<OutlineDestination>): OutlineDestination => ({
    page,
    kind: kind as DestinationKind,
    ...none,
    ...fields,
  });
  switch (kind) {
    case 'XYZ':
      // A zoom of 0 means "unchanged", which papyra reports as null.
      return at({ left: a, top: b, zoom: c === 0 ? null : c });
    case 'FitH':
    case 'FitBH':
      return at({ top: a });
    case 'FitV':
    case 'FitBV':
      return at({ left: a });
    case 'FitR':
      return at({ left: a, bottom: b, right: c, top: d });
    default:
      return at({});
  }
}
