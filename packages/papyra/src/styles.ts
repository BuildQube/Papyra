import type {
  BorderEdge as NativeBorderEdge,
  CellStyle as NativeCellStyle,
  SheetLayout as NativeSheetLayout,
} from '@build-qube/papyra-native';

/** How one edge of a border is drawn. Dash-dot variants arrive as `'dashed'`. */
export type BorderStyle =
  | 'thin'
  | 'medium'
  | 'thick'
  | 'dashed'
  | 'dotted'
  | 'double'
  | 'hair';

/** One edge of a cell's border. */
export interface BorderEdge {
  /** The line. */
  style: BorderStyle;
  /** `0xRRGGBB`. Absent means automatic, which Excel draws black. */
  color?: number;
}

/** Horizontal alignment. Absent means Excel's default: text left, numbers right. */
export type HorizontalAlign =
  | 'left'
  | 'center'
  | 'right'
  | 'justify'
  | 'centerContinuous'
  | 'fill'
  | 'distributed';

/** Vertical alignment. Absent means bottom. */
export type VerticalAlign =
  | 'top'
  | 'center'
  | 'bottom'
  | 'justify'
  | 'distributed';

/**
 * How a cell looks, apart from its number format — which is already applied to the
 * text. Sheets share styles by index: see {@link CellWindow.style}.
 *
 * Colours are `0xRRGGBB` numbers; {@link cssColor} turns one into CSS. An absent
 * colour means "automatic", which is the reader's to choose — black on white in
 * Excel, but whatever the page's own text colour is in a dark theme.
 */
export interface CellStyle {
  /** Bold text. */
  bold: boolean;
  /** Italic text. */
  italic: boolean;
  /** Underlined text. */
  underline: boolean;
  /** Struck-through text. */
  strike: boolean;
  /** Font size relative to the workbook's default font: 2 is twice the size. */
  fontScale: number;
  /** Text colour. Absent means automatic. */
  color?: number;
  /** Background. Absent means none. */
  fill?: number;
  /** Top border. */
  borderTop?: BorderEdge;
  /** Right border. */
  borderRight?: BorderEdge;
  /** Bottom border. */
  borderBottom?: BorderEdge;
  /** Left border. */
  borderLeft?: BorderEdge;
  /** Horizontal alignment. */
  horizontal?: HorizontalAlign;
  /** Vertical alignment. */
  vertical?: VerticalAlign;
  /** Wrap text onto further lines within the row's height. */
  wrap: boolean;
  /** Indent level. Excel draws each as roughly three characters. */
  indent: number;
}

/** Columns sharing a width, inclusive at both ends. */
export interface ColumnSpan {
  /** First column, 0-based. */
  first: number;
  /** Last column, inclusive. Often 16383 — "to the end of the sheet". */
  last: number;
  /** Pixels at 96 DPI. 0 means hidden. */
  width: number;
}

/** A row with a height of its own. */
export interface RowSize {
  /** The row, 0-based. */
  row: number;
  /** Pixels at 96 DPI. 0 means hidden. */
  height: number;
}

/**
 * Column widths and row heights as the author left them, in pixels at 96 DPI —
 * Excel's own geometry, so a 64px default column is 64px here.
 */
export interface SheetLayout {
  /** Width of a column with no span of its own. */
  defaultColWidth: number;
  /** Height of a row with no size of its own. */
  defaultRowHeight: number;
  /** Columns with their own width, in the file's order. */
  columns: readonly ColumnSpan[];
  /** Rows with their own height, in row order. */
  rows: readonly RowSize[];
  /**
   * `false` when the author turned gridlines off — usually a report or a
   * dashboard, drawn with borders where lines are meant to be.
   */
  showGridLines: boolean;
}

/** `0x1F4E79` → `'#1f4e79'`. */
export function cssColor(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}

function edge(e: NativeBorderEdge | undefined): BorderEdge | undefined {
  if (!e) return undefined;
  return e.color === undefined || e.color === null
    ? { style: e.style as BorderStyle }
    : { style: e.style as BorderStyle, color: e.color };
}

/** @internal */
export function toCellStyle(s: NativeCellStyle): CellStyle {
  const out: CellStyle = {
    bold: s.bold,
    italic: s.italic,
    underline: s.underline,
    strike: s.strike,
    fontScale: s.fontScale,
    wrap: s.wrap,
    indent: s.indent,
  };
  // Assigned only when present, so a style compares and spreads as the file meant
  // it — `{ color: undefined }` and `{}` are different objects to a test.
  if (s.color != null) out.color = s.color;
  if (s.fill != null) out.fill = s.fill;
  const top = edge(s.borderTop);
  const right = edge(s.borderRight);
  const bottom = edge(s.borderBottom);
  const left = edge(s.borderLeft);
  if (top) out.borderTop = top;
  if (right) out.borderRight = right;
  if (bottom) out.borderBottom = bottom;
  if (left) out.borderLeft = left;
  if (s.horizontal) out.horizontal = s.horizontal as HorizontalAlign;
  if (s.vertical) out.vertical = s.vertical as VerticalAlign;
  return out;
}

/** @internal */
export function toSheetLayout(l: NativeSheetLayout): SheetLayout {
  const columns: ColumnSpan[] = [];
  for (let i = 0; i + 2 < l.cols.length; i += 3) {
    columns.push({
      first: l.cols[i] ?? 0,
      last: l.cols[i + 1] ?? 0,
      width: l.cols[i + 2] ?? 0,
    });
  }
  const rows: RowSize[] = [];
  for (let i = 0; i + 1 < l.rows.length; i += 2) {
    rows.push({ row: l.rows[i] ?? 0, height: l.rows[i + 1] ?? 0 });
  }
  return {
    defaultColWidth: l.defaultColWidth,
    defaultRowHeight: l.defaultRowHeight,
    columns,
    rows,
    showGridLines: l.showGridLines,
  };
}
