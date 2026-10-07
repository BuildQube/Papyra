import type {
  BorderEdge,
  CellKind,
  CellStyle,
  SheetLayout,
} from '@build-qube/papyra';
import type { CSSProperties } from 'react';

/**
 * One axis of the grid — rows or columns — as positions and sizes.
 *
 * Two implementations, because the common case does not need an array: a CSV's rows
 * are all one height, and a million of them should cost one multiply, not 8 MB.
 */
export interface Axis {
  /** How many rows or columns. */
  readonly count: number;
  /** Total length in pixels. */
  readonly total: number;
  /** Where item `i` starts. */
  start(i: number): number;
  /** Item `i`'s size. 0 for a hidden row or column. */
  size(i: number): number;
  /** The item under `x`, clamped to the axis. */
  at(x: number): number;
}

/** Every item the same size. */
export function uniformAxis(count: number, size: number): Axis {
  return {
    count,
    total: count * size,
    start: (i) => i * size,
    size: () => size,
    at: (x) => Math.max(0, Math.min(count - 1, Math.floor(x / size))),
  };
}

/** Items from their edges: `edges[i]` is where item `i` starts, `edges[count]` the end. */
export function edgesAxis(edges: Float64Array): Axis {
  const count = edges.length - 1;
  return {
    count,
    total: edges[count] ?? 0,
    start: (i) => edges[i] ?? 0,
    size: (i) => (edges[i + 1] ?? 0) - (edges[i] ?? 0),
    at(x) {
      // The last item that starts at or before x. A hidden item is zero wide and
      // shares its start with the next, which this skips past — nothing can be under
      // the pointer that is not drawn.
      let lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((edges[mid] ?? 0) <= x) lo = mid;
        else hi = mid - 1;
      }
      return Math.max(0, lo);
    },
  };
}

/** Prefix sums of sizes, into edges. */
export function toEdges(sizes: ArrayLike<number>): Float64Array {
  const edges = new Float64Array(sizes.length + 1);
  for (let i = 0; i < sizes.length; i++) {
    edges[i + 1] = (edges[i] ?? 0) + (sizes[i] ?? 0);
  }
  return edges;
}

/** Column widths from an xlsx layout: the default, with the file's spans over it. */
export function layoutColumns(layout: SheetLayout, cols: number): Axis {
  const widths = new Float64Array(cols).fill(layout.defaultColWidth);
  for (const span of layout.columns) {
    // A span commonly runs to column 16384; only the part the sheet uses matters.
    const last = Math.min(span.last, cols - 1);
    for (let c = span.first; c <= last; c++) widths[c] = span.width;
  }
  return edgesAxis(toEdges(widths));
}

/** Row heights from an xlsx layout, or a uniform axis when no row has its own. */
export function layoutRows(layout: SheetLayout, rows: number): Axis {
  const custom = layout.rows.filter((r) => r.row < rows);
  if (custom.length === 0) return uniformAxis(rows, layout.defaultRowHeight);
  const heights = new Float64Array(rows).fill(layout.defaultRowHeight);
  for (const r of custom) heights[r.row] = r.height;
  return edgesAxis(toEdges(heights));
}

/** WCAG relative luminance of `0xRRGGBB`, 0 for black to 1 for white. */
export function luminance(rgb: number): number {
  const channel = (shift: number) => {
    const c = ((rgb >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** `0x1F4E79` → `'#1f4e79'`. */
function hex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * The text colour for a cell, or `undefined` to inherit the page's.
 *
 * Excel assumes white paper, and almost every workbook writes its default text
 * colour out explicitly as black. Taken literally, that is black text on a dark
 * theme's background — every cell unreadable. So on a cell with no fill, a colour
 * close to black or to white is read as "the default" and left to the page; a
 * colour that means something — red for a loss, a blue heading — is kept. On a
 * filled cell the fill fixes the background, so the author's colour is right as
 * given, and with none the text takes whichever of black or white reads on the fill.
 */
export function textColor(
  style: CellStyle | undefined,
  formatColor: number | undefined,
): string | undefined {
  const color = formatColor ?? style?.color;
  const fill = style?.fill;
  if (fill !== undefined) {
    if (color !== undefined) return hex(color);
    return luminance(fill) > 0.4 ? '#000000' : '#ffffff';
  }
  if (color === undefined) return undefined;
  const l = luminance(color);
  return l < 0.02 || l > 0.85 ? undefined : hex(color);
}

/** Pixel widths for each Excel border style, and the CSS line that draws it. */
const LINES: Record<BorderEdge['style'], string> = {
  hair: '1px solid',
  thin: '1px solid',
  medium: '2px solid',
  thick: '3px solid',
  dashed: '1px dashed',
  dotted: '1px dotted',
  double: '3px double',
};

/**
 * One border edge as CSS. An automatic or near-black line is drawn in the page's
 * foreground colour, for the reason {@link textColor} gives.
 */
export function borderCss(edge: BorderEdge, filled: boolean): string {
  const near =
    edge.color === undefined || (!filled && luminance(edge.color) < 0.02);
  return `${LINES[edge.style]} ${near ? 'var(--foreground)' : hex(edge.color ?? 0)}`;
}

const JUSTIFY: Record<string, CSSProperties['justifyContent']> = {
  left: 'flex-start',
  center: 'center',
  centerContinuous: 'center',
  right: 'flex-end',
  justify: 'flex-start',
  distributed: 'center',
  fill: 'flex-start',
};

const ALIGN_ITEMS: Record<string, CSSProperties['alignItems']> = {
  top: 'flex-start',
  center: 'center',
  bottom: 'flex-end',
  justify: 'flex-start',
  distributed: 'center',
};

/** Excel's default: numbers and dates right, booleans and errors centred, text left. */
function defaultJustify(kind: CellKind): CSSProperties['justifyContent'] {
  switch (kind) {
    case 'number':
    case 'date':
    case 'duration':
      return 'flex-end';
    case 'bool':
    case 'error':
      return 'center';
    default:
      return 'flex-start';
  }
}

/** One indent level, as Excel draws it: about three characters of the default font. */
const INDENT_PX = 9;

/**
 * Inline styles for a cell: its font, fill, alignment, and the right and bottom
 * borders — which double as the gridlines when the cell has no border of its own.
 * The top and left borders are drawn separately by {@link leadingBorders}, over the
 * neighbour's edge, so a border shared by two cells is one line and not two.
 */
export function cellCss(
  style: CellStyle | undefined,
  kind: CellKind,
  formatColor: number | undefined,
  gridLines: boolean,
): CSSProperties {
  const css: CSSProperties = {
    justifyContent: style?.horizontal
      ? JUSTIFY[style.horizontal]
      : defaultJustify(kind),
    // Excel aligns to the bottom unless told otherwise.
    alignItems: style?.vertical ? ALIGN_ITEMS[style.vertical] : 'flex-end',
  };
  const grid = gridLines
    ? '1px solid color-mix(in oklab, var(--border) 60%, transparent)'
    : undefined;
  const filled = style?.fill !== undefined;
  css.borderRight = style?.borderRight
    ? borderCss(style.borderRight, filled)
    : grid;
  css.borderBottom = style?.borderBottom
    ? borderCss(style.borderBottom, filled)
    : grid;
  if (!style) return css;

  if (style.fill !== undefined) css.background = hex(style.fill);
  const color = textColor(style, formatColor);
  if (color) css.color = color;
  if (style.bold) css.fontWeight = 600;
  if (style.italic) css.fontStyle = 'italic';
  const lines = [style.underline && 'underline', style.strike && 'line-through']
    .filter(Boolean)
    .join(' ');
  if (lines) css.textDecoration = lines;
  if (style.fontScale !== 1) css.fontSize = `${style.fontScale}em`;
  if (style.indent > 0) {
    const pad = 8 + style.indent * INDENT_PX;
    if (style.horizontal === 'right') css.paddingRight = pad;
    else css.paddingLeft = pad;
  }
  if (style.wrap) {
    css.whiteSpace = 'normal';
    css.overflowWrap = 'anywhere';
  }
  return css;
}

/**
 * The top and left borders of a cell, for an overlay one pixel up and to the left
 * of it — onto the neighbour's right and bottom edge, where a shared border lives.
 * `undefined` when the cell has neither.
 */
export function leadingBorders(
  style: CellStyle | undefined,
): CSSProperties | undefined {
  if (!style?.borderTop && !style?.borderLeft) return undefined;
  const filled = style.fill !== undefined;
  const css: CSSProperties = {};
  if (style.borderTop) css.borderTop = borderCss(style.borderTop, filled);
  if (style.borderLeft) css.borderLeft = borderCss(style.borderLeft, filled);
  return css;
}
