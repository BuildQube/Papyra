import {
  type CellKind,
  type CellWindow,
  columnName,
  EncryptedWorkbookError,
  type MergedRange,
  openWorkbook,
  type Sheet,
  type Workbook,
  type WorkbookOptions,
} from '@build-qube/papyra';
import { LockIcon, Table2Icon } from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PdfIsolationGuard } from '@/components/pdf-isolation-guard';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/** Every row is one line. Wrapped text would need a measured height per row. */
const ROW_HEIGHT = 24;
/** Header row height, and the minimum row-number column width. */
const HEADER = 24;
/** Column widths are estimated from content; these bound the estimate. */
const MIN_COL_WIDTH = 64;
const MAX_COL_WIDTH = 320;
const DEFAULT_COL_WIDTH = 96;
/**
 * Rough width of one `text-xs` character, for the estimate. Generous on purpose:
 * Inter's capitals and digits run wider than its average, and a column a few
 * pixels too wide costs nothing where one too narrow truncates every value.
 */
const CHAR_WIDTH = 7.5;
/** Cell padding plus a little air, so the widest value does not touch the border. */
const CELL_PADDING = 24;
/**
 * Rows read from each end to estimate column widths. Both ends, because a column
 * of ids or running totals is at its widest at the bottom.
 */
const SAMPLE_ROWS = 100;
/** Rows and columns drawn beyond the edge, so a scroll does not show a blank strip. */
const OVERSCAN = 4;

/**
 * The largest scroll extent used, in pixels.
 *
 * Browsers cap an element's size — Firefox at about 17.9 million pixels — and a
 * million-row CSV at 24px a row is 24 million. Past this the scrollbar maps onto the
 * sheet proportionally instead, so the last row is still reachable; a pixel of
 * scrollbar is then more than a pixel of sheet, which no one dragging a scrollbar
 * over a million rows will notice.
 */
const MAX_EXTENT = 8_000_000;

/** Props for {@link WorkbookView}. */
export interface WorkbookViewProps {
  /** The spreadsheet or delimited text file. */
  file: File;
  /** Passed to papyra's `openWorkbook` — a delimiter or an encoding to force. */
  options?: WorkbookOptions;
  /** Merged onto the root. */
  className?: string;
}

type State =
  | { status: 'opening' }
  | { status: 'open'; book: Workbook }
  | { status: 'encrypted' }
  | { status: 'failed'; error: unknown };

/**
 * A spreadsheet file, opened by papyra and shown a sheet at a time.
 *
 * Shared by the spreadsheet and CSV renderers, which differ only in the files they
 * claim. Opening reads the sheet names; a sheet's cells are parsed the first time its
 * tab is chosen. Formats are not applied yet, so a currency cell reads `1234.5` and
 * a date reads `2024-03-15`.
 */
export function WorkbookView(props: WorkbookViewProps) {
  return (
    <PdfIsolationGuard>
      <OpenedWorkbook {...props} />
    </PdfIsolationGuard>
  );
}

function OpenedWorkbook({ file, options, className }: WorkbookViewProps) {
  const [state, setState] = useState<State>({ status: 'opening' });

  useEffect(() => {
    let live = true;
    setState({ status: 'opening' });
    openWorkbook(file, options).then(
      (book) => live && setState({ status: 'open', book }),
      (error: unknown) => {
        if (!live) return;
        setState(
          error instanceof EncryptedWorkbookError
            ? { status: 'encrypted' }
            : { status: 'failed', error },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [file, options]);

  switch (state.status) {
    case 'opening':
      return <Centered />;
    case 'open':
      return <WorkbookTabs book={state.book} className={className} />;
    case 'encrypted':
      return (
        <Notice
          description={file.name}
          icon={<LockIcon />}
          // No password prompt, unlike a PDF: the whole package is encrypted and
          // there is no decryption to hand a password to.
          title="This workbook is password-protected"
        />
      );
    case 'failed':
      // To the preview's error boundary, which offers the file as a download.
      throw state.error;
  }
}

function WorkbookTabs({
  book,
  className,
}: {
  book: Workbook;
  className?: string | undefined;
}) {
  // The tabs Excel would show. A hidden sheet is the author's decision, and a
  // "very hidden" one is unreachable without a macro; both are counted, not shown.
  const tabs = book.sheets
    .map((info, index) => ({ ...info, index }))
    .filter((s) => s.visibility === 'visible');
  const hidden = book.sheets.length - tabs.length;
  const [active, setActive] = useState(tabs[0]?.index ?? 0);
  const [sheet, setSheet] = useState<{ index: number; sheet: Sheet }>();
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let live = true;
    book.sheet(active).then(
      (s) => live && setSheet({ index: active, sheet: s }),
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [book, active]);

  if (error) throw error;
  const info = book.sheets[active];
  const current = sheet?.index === active ? sheet.sheet : undefined;

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {!current ? (
        <Centered />
      ) : info && info.kind !== 'worksheet' ? (
        <Notice
          description={`“${info.name}” is a ${info.kind}, which has no cells to show.`}
          icon={<Table2Icon />}
          title="Nothing to show"
        />
      ) : current.rows === 0 ? (
        <Notice
          description={current.name}
          icon={<Table2Icon />}
          title="This sheet is empty"
        />
      ) : (
        <SheetGrid key={active} sheet={current} />
      )}
      <div className="flex min-h-9 items-center gap-3 border-t bg-muted/40 px-2 text-xs text-muted-foreground">
        {tabs.length > 1 && (
          <Tabs
            className="min-w-0 flex-1 overflow-x-auto"
            onValueChange={(v) => setActive(Number(v))}
            value={String(active)}
          >
            <TabsList variant="line">
              {tabs.map((t) => (
                <TabsTrigger key={t.index} value={String(t.index)}>
                  {t.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        <span className="ml-auto shrink-0 tabular-nums">
          {describe(book, current, hidden)}
        </span>
      </div>
    </div>
  );
}

const DELIMITER_NAMES: Record<string, string> = {
  ',': 'comma',
  ';': 'semicolon',
  '\t': 'tab',
  '|': 'pipe',
};

/**
 * The status line. For delimited text it names the encoding and delimiter, because
 * both were guessed — and a wrong guess reads as mojibake or as one wide column,
 * which is easier to diagnose when the guess is on screen.
 */
function describe(
  book: Workbook,
  sheet: Sheet | undefined,
  hidden: number,
): string {
  const parts: string[] = [];
  if (sheet) {
    parts.push(
      `${sheet.rows.toLocaleString()} × ${sheet.cols.toLocaleString()}`,
    );
  }
  if (book.encoding) parts.push(book.encoding);
  if (book.delimiter !== undefined) {
    const name = DELIMITER_NAMES[book.delimiter] ?? `“${book.delimiter}”`;
    parts.push(`${name}-separated`);
  }
  if (hidden > 0) parts.push(`${hidden} hidden`);
  return parts.join(' · ');
}

function Centered() {
  return (
    <div className="grid min-h-0 flex-1 place-items-center">
      <Spinner />
    </div>
  );
}

function Notice({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription className="wrap-anywhere">
          {description}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** Props for {@link SheetGrid}. */
export interface SheetGridProps {
  /** A sheet from papyra's `Workbook.sheet`. */
  sheet: Sheet;
  /** Merged onto the scroll container. */
  className?: string;
}

/**
 * Left edges of every column, plus the right edge of the last, from the text in the
 * first and last rows. calamine does not read column widths, so this is a guess sized to the
 * content — the same thing Excel's double-click on a column border does.
 */
function columnEdges(sheet: Sheet): Float64Array {
  const head = sheet.window({
    rowStart: 0,
    rowEnd: Math.min(sheet.rows, SAMPLE_ROWS),
  });
  const tail = sheet.window({
    rowStart: Math.max(head.rowEnd, sheet.rows - SAMPLE_ROWS),
    rowEnd: sheet.rows,
  });
  const edges = new Float64Array(sheet.cols + 1);
  for (let c = 0; c < sheet.cols; c++) {
    let longest = 0;
    for (const sample of [head, tail]) {
      for (let r = sample.rowStart; r < sample.rowEnd; r++) {
        longest = Math.max(longest, sample.text(r, c).length);
      }
    }
    const width =
      longest === 0
        ? DEFAULT_COL_WIDTH
        : Math.min(
            MAX_COL_WIDTH,
            Math.max(MIN_COL_WIDTH, longest * CHAR_WIDTH + CELL_PADDING),
          );
    edges[c + 1] = (edges[c] ?? 0) + width;
  }
  return edges;
}

/** The last index `i` with `edges[i] <= x`. */
function columnAt(edges: Float64Array, x: number): number {
  let lo = 0;
  let hi = edges.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((edges[mid] ?? 0) <= x) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/**
 * Map a scroll position onto the sheet. Identity until the sheet outgrows
 * {@link MAX_EXTENT}, proportional after.
 */
function logical(
  scroll: number,
  extent: number,
  physical: number,
  view: number,
): number {
  if (physical >= extent || physical <= view) return scroll;
  return (scroll * (extent - view)) / (physical - view);
}

const ALIGN: Record<CellKind, string> = {
  empty: '',
  number: 'justify-end tabular-nums',
  date: 'justify-end tabular-nums',
  duration: 'justify-end tabular-nums',
  bool: 'justify-center',
  error: 'justify-center text-destructive',
  text: '',
};

/**
 * One sheet as a scrolling grid, drawing only what is on screen.
 *
 * Every frame reads one window from papyra — a synchronous copy of the visible
 * cells, a few hundred of them — and draws those, the headers, and any merged
 * region that crosses the view. Nothing else exists in the DOM, so a million rows
 * cost what twenty do.
 */
export function SheetGrid({ sheet, className }: SheetGridProps) {
  const scroller = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const edges = useMemo(() => columnEdges(sheet), [sheet]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const frame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) setScroll({ left: el.scrollLeft, top: el.scrollTop });
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const gutter = Math.max(
    HEADER + 16,
    String(sheet.rows).length * CHAR_WIDTH + 16,
  );
  const bodyWidth = Math.max(0, size.width - gutter);
  const bodyHeight = Math.max(0, size.height - HEADER);
  const fullWidth = edges[sheet.cols] ?? 0;
  const fullHeight = sheet.rows * ROW_HEIGHT;
  const physWidth = Math.min(fullWidth, MAX_EXTENT);
  const physHeight = Math.min(fullHeight, MAX_EXTENT);
  const x = logical(scroll.left, fullWidth, physWidth, bodyWidth);
  const y = logical(scroll.top, fullHeight, physHeight, bodyHeight);

  const rowStart = Math.max(0, Math.floor(y / ROW_HEIGHT) - OVERSCAN);
  const rowEnd = Math.min(
    sheet.rows,
    Math.ceil((y + bodyHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const colStart = Math.max(0, columnAt(edges, x) - 1);
  const colEnd = Math.min(sheet.cols, columnAt(edges, x + bodyWidth) + 2);

  const cells = useMemo(
    () => sheet.window({ rowStart, rowEnd, colStart, colEnd }),
    [sheet, rowStart, rowEnd, colStart, colEnd],
  );

  // Merges crossing the view. Their value lives in the top-left cell, which may be
  // scrolled off, so each is drawn whole from its own one-cell read.
  const merges = useMemo(
    () =>
      sheet.merges.filter(
        (m) =>
          m.row < rowEnd &&
          m.lastRow >= rowStart &&
          m.col < colEnd &&
          m.lastCol >= colStart,
      ),
    [sheet, rowStart, rowEnd, colStart, colEnd],
  );
  const covered = (r: number, c: number) =>
    merges.some(
      (m) => r >= m.row && r <= m.lastRow && c >= m.col && c <= m.lastCol,
    );

  const left = (c: number) => gutter + (edges[c] ?? 0) - x;
  const top = (r: number) => HEADER + r * ROW_HEIGHT - y;
  const width = (c: number, last = c) =>
    (edges[last + 1] ?? 0) - (edges[c] ?? 0);

  const body: ReactNode[] = [];
  for (let r = cells.rowStart; r < cells.rowEnd; r++) {
    for (let c = cells.colStart; c < cells.colEnd; c++) {
      if (merges.length > 0 && covered(r, c)) continue;
      body.push(
        <GridCell
          cells={cells}
          col={c}
          key={`${r}:${c}`}
          row={r}
          style={{
            left: left(c),
            top: top(r),
            width: width(c),
            height: ROW_HEIGHT,
          }}
        />,
      );
    }
  }
  for (const m of merges) {
    body.push(
      <MergedCell
        key={`m${m.row}:${m.col}`}
        merge={m}
        sheet={sheet}
        style={{
          left: left(m.col),
          top: top(m.row),
          width: width(m.col, m.lastCol),
          height: (m.lastRow - m.row + 1) * ROW_HEIGHT,
        }}
      />,
    );
  }

  const header =
    'absolute flex items-center justify-center border-r border-b bg-muted text-[11px] font-medium text-muted-foreground';
  const columns: ReactNode[] = [];
  for (let c = cells.colStart; c < cells.colEnd; c++) {
    columns.push(
      <div
        className={header}
        key={c}
        style={{ left: left(c), top: 0, width: width(c), height: HEADER }}
      >
        {columnName(c)}
      </div>,
    );
  }
  const rows: ReactNode[] = [];
  for (let r = cells.rowStart; r < cells.rowEnd; r++) {
    rows.push(
      <div
        className={cn(header, 'justify-end px-2 tabular-nums')}
        key={r}
        style={{ left: 0, top: top(r), width: gutter, height: ROW_HEIGHT }}
      >
        {r + 1}
      </div>,
    );
  }

  return (
    <section
      aria-label={`${sheet.name}: ${sheet.rows.toLocaleString()} rows by ${sheet.cols.toLocaleString()} columns`}
      className={cn(
        'relative min-h-0 flex-1 overflow-auto bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        className,
      )}
      onScroll={onScroll}
      ref={scroller}
      // Focusable so the arrow keys and Page Down scroll it without a mouse.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must be reachable by keyboard to be scrolled by it.
      tabIndex={0}
    >
      {/* The scroll extent. The layer inside sticks to the viewport and draws
          everything at logical coordinates, which is what lets the extent be
          capped without the content following the cap. */}
      <div
        className="relative"
        style={{ width: gutter + physWidth, height: HEADER + physHeight }}
      >
        <div
          className="sticky top-0 left-0 overflow-hidden text-xs"
          style={{ width: size.width, height: size.height }}
        >
          {body}
          <div className="absolute inset-x-0 top-0 z-10" style={{ height: 0 }}>
            {columns}
          </div>
          <div className="absolute inset-y-0 left-0 z-10" style={{ width: 0 }}>
            {rows}
          </div>
          <div
            className={cn(header, 'z-20')}
            style={{ left: 0, top: 0, width: gutter, height: HEADER }}
          />
        </div>
      </div>
    </section>
  );
}

const CELL =
  'absolute flex items-center overflow-hidden border-r border-b border-border/60 px-2 whitespace-nowrap';

function GridCell({
  cells,
  row,
  col,
  style,
}: {
  cells: CellWindow;
  row: number;
  col: number;
  style: CSSProperties;
}) {
  const kind = cells.kind(row, col);
  const text = kind === 'empty' ? '' : cells.text(row, col);
  return (
    <div
      className={cn(CELL, ALIGN[kind])}
      style={style}
      title={text || undefined}
    >
      <span className="truncate">{text}</span>
    </div>
  );
}

function MergedCell({
  sheet,
  merge,
  style,
}: {
  sheet: Sheet;
  merge: MergedRange;
  style: CSSProperties;
}) {
  const one = sheet.window({
    rowStart: merge.row,
    rowEnd: merge.row + 1,
    colStart: merge.col,
    colEnd: merge.col + 1,
  });
  const kind = one.kind(merge.row, merge.col);
  const text = one.text(merge.row, merge.col);
  return (
    <div
      className={cn(CELL, 'bg-background', ALIGN[kind])}
      style={style}
      title={text || undefined}
    >
      <span className="truncate">{text}</span>
    </div>
  );
}
