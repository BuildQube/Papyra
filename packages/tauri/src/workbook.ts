import {
  openWorkbookWith,
  type PdfSource,
  type SheetSource,
  type Workbook,
  type WorkbookOptions,
  type WorkbookSource,
} from '@build-qube/papyra/core';
import { invoke } from '@tauri-apps/api/core';
import { closeDocument, command } from './host.js';

type NativeWindow = ReturnType<SheetSource['window']>;

/** The plugin's answer to `open_workbook`. */
interface Opened extends Omit<WorkbookSource, 'sheet' | 'close'> {
  id: number;
}

/** The plugin's answer to `sheet`: everything but the cells, in JSON. */
interface SheetMeta extends Omit<SheetSource, 'window' | 'merges' | 'layout'> {
  merges: number[];
  layout: {
    defaultColWidth: number;
    defaultRowHeight: number;
    cols: number[];
    rows: number[];
    showGridLines: boolean;
  } | null;
}

/**
 * A window as `pack` in the plugin's `tables.rs` lays it out: four u32s, then each
 * array aligned for a view straight over the buffer, then the text as UTF-8.
 */
function unpack(buffer: ArrayBuffer): NativeWindow {
  const [rowStart = 0, colStart = 0, rows = 0, cols = 0] = new Uint32Array(
    buffer,
    0,
    4,
  );
  const n = rows * cols;
  let at = 16;
  const take = <T>(make: (at: number) => T, bytes: number): T => {
    const out = make(at);
    at += bytes;
    return out;
  };
  const kinds = take((a) => new Uint8Array(buffer, a, n), n);
  at = Math.ceil(at / 8) * 8;
  const numbers = take((a) => new Float64Array(buffer, a, n), n * 8);
  const colors = take((a) => new Uint32Array(buffer, a, n), n * 4);
  const offsets = take((a) => new Uint32Array(buffer, a, n + 1), (n + 1) * 4);
  const styles = take((a) => new Uint16Array(buffer, a, n), n * 2);
  const text = new TextDecoder().decode(new Uint8Array(buffer, at));
  return {
    rowStart,
    colStart,
    rows,
    cols,
    kinds,
    numbers,
    text,
    offsets,
    styles,
    colors,
  };
}

/**
 * `[rowStart, rowEnd) x [colStart, colEnd)` of a window holding the whole sheet,
 * clamped to it: what papyra's `Sheet.window` asks the addon for, answered here
 * without a round trip.
 */
function slice(
  all: NativeWindow,
  rowStart: number,
  rowEnd: number,
  colStart: number,
  colEnd: number,
): NativeWindow {
  const r1 = Math.min(rowEnd, all.rows);
  const c1 = Math.min(colEnd, all.cols);
  const r0 = Math.min(rowStart, r1);
  const c0 = Math.min(colStart, c1);
  const rows = r1 - r0;
  const cols = c1 - c0;
  const n = rows * cols;
  const out = {
    rowStart: r0,
    colStart: c0,
    rows,
    cols,
    kinds: new Uint8Array(n),
    numbers: new Float64Array(n),
    styles: new Uint16Array(n),
    colors: new Uint32Array(n),
    offsets: new Uint32Array(n + 1),
    text: '',
  };
  const parts: string[] = [];
  let length = 0;
  for (let r = 0; r < rows; r++) {
    const from = (r0 + r) * all.cols + c0;
    const to = from + cols;
    const into = r * cols;
    out.kinds.set(all.kinds.subarray(from, to), into);
    out.numbers.set(all.numbers.subarray(from, to), into);
    out.styles.set(all.styles.subarray(from, to), into);
    out.colors.set(all.colors.subarray(from, to), into);
    const base = all.offsets[from] ?? 0;
    for (let c = 0; c < cols; c++) {
      out.offsets[into + c] = length + (all.offsets[from + c] ?? 0) - base;
    }
    const end = all.offsets[to] ?? base;
    parts.push(all.text.slice(base, end));
    length += end - base;
  }
  out.offsets[n] = length;
  out.text = parts.join('');
  return out;
}

/**
 * papyra's `openWorkbook`, parsed in the Tauri app's host process through
 * `tauri-plugin-papyra` with its `tables` feature, and allowed by `papyra:tables`.
 *
 * Resolves to papyra's own `Workbook`, so `spreadsheetRenderer.with({ open:
 * openWorkbook })` and `csvRenderer`'s show it unchanged. A grid reads a sheet's
 * cells synchronously, a window per frame, and IPC is not synchronous — so each
 * sheet's cells come over **whole**, in one binary call when the sheet is first
 * read, and windows are cut from that copy. That is about 19 bytes a cell plus its
 * text, held in the host and here: a million cells is ~25 MB, and the default
 * 8-million-cell cap ~150 MB or more. On a phone, pass a lower `maxCells`.
 *
 * The workbook stays in the host until `close()`.
 */
export function openWorkbook(
  source: PdfSource,
  options: WorkbookOptions = {},
): Promise<Workbook> {
  return openWorkbookWith(
    async (bytes, options) => {
      const { id, ...book } = await invoke<Opened>(
        command('open_workbook'),
        bytes,
        {
          headers: {
            // JSON in a header: ASCII, so percent-encoded like the password.
            'x-papyra-options': encodeURIComponent(JSON.stringify(options)),
          },
        },
      );
      return {
        ...book,
        async sheet(index) {
          const meta = await invoke<SheetMeta>(command('sheet'), { id, index });
          const all = unpack(
            await invoke<ArrayBuffer>(command('window'), {
              id,
              sheet: index,
              rowStart: 0,
              rowEnd: meta.rows,
              colStart: 0,
              colEnd: meta.cols,
            }),
          );
          return {
            ...meta,
            merges: Uint32Array.from(meta.merges),
            layout: meta.layout && {
              ...meta.layout,
              cols: Float64Array.from(meta.layout.cols),
              rows: Float64Array.from(meta.layout.rows),
            },
            window: (r0, r1, c0, c1) => slice(all, r0, r1, c0, c1),
          };
        },
        close: () => closeDocument(id),
      };
    },
    source,
    options,
  );
}
