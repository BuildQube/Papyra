import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  EncryptedWorkbookError,
  IncorrectPasswordError,
  PasswordRequiredError,
} from '@build-qube/papyra/core';

/**
 * `TauriEngine` against a stand-in for the plugin: Tauri's IPC is mocked, and so is
 * the page fetch. The plugin's own side is tested in Rust; this checks the contract
 * between them — which commands, which arguments, which shapes.
 *
 * In `test/integration` only because it imports `@build-qube/papyra/core`, which
 * needs papyra's TypeScript built; it needs no addon and no corpus.
 */
type Call = { cmd: string; args: unknown; options?: unknown };
const calls: Call[] = [];
let answers: Record<string, (args: unknown) => unknown> = {};

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: unknown, options?: unknown) => {
    calls.push({ cmd, args, options });
    const answer = answers[cmd];
    if (!answer) throw new Error(`no answer for ${cmd}`);
    return answer(args);
  },
  convertFileSrc: (path: string, protocol: string) =>
    `${protocol}://localhost/${path}`,
}));

const { TauriEngine, TauriOfficeEngine, openTiff, openWorkbook } = await import(
  '../../src/index.js'
);

/** Answer every `fetch` with an RGBA page, and record the URLs asked for. */
async function fetching<T>(
  run: (urls: string[]) => Promise<T>,
  width = 4,
  height = 2,
): Promise<T> {
  const urls: string[] = [];
  const fetched = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return new Response(new Uint8Array(width * height * 4), {
      headers: { 'x-width': String(width), 'x-height': String(height) },
    });
  }) as never;
  try {
    return await run(urls);
  } finally {
    globalThis.fetch = fetched;
  }
}

const OPENED = {
  id: 7,
  sizes: [
    [612, 792],
    [792, 612],
  ],
  info: { title: 'Plans', author: null },
  pdfVersion: '1.7',
};

beforeEach(() => {
  calls.length = 0;
  answers = { 'plugin:papyra|open': () => OPENED };
});

describe('TauriEngine', () => {
  test('is available only inside a Tauri WebView', () => {
    expect(new TauriEngine().availability().ok).toBe(false);
    Object.assign(globalThis, { __TAURI_INTERNALS__: {} });
    expect(new TauriEngine().availability().ok).toBe(true);
    delete (globalThis as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
  });

  test('opens by sending the bytes as the body, and the password as a header', async () => {
    const engine = new TauriEngine();
    const doc = await engine.open(new Uint8Array([1, 2, 3]), {
      password: 'pässwort',
    });
    const [open] = calls;
    expect(open?.cmd).toBe('plugin:papyra|open');
    expect(open?.args).toEqual(new Uint8Array([1, 2, 3]));
    expect(open?.options).toEqual({
      headers: { 'x-papyra-password': 'p%C3%A4sswort' },
    });

    expect(doc.engine).toBe('tauri');
    expect(doc.pageCount).toBe(2);
    expect(doc.pageSize(1)).toEqual({ width: 792, height: 612 });
    expect(doc.metadata.title).toBe('Plans');
    expect(doc.metadata.author).toBeNull();
    expect(doc.pdfVersion).toBe('1.7');
    expect(doc.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test('a tagged password failure becomes papyra’s typed error', async () => {
    const engine = new TauriEngine();
    answers['plugin:papyra|open'] = () => {
      throw 'papyra/password-required this PDF is password-protected';
    };
    expect(engine.open(new Uint8Array())).rejects.toBeInstanceOf(
      PasswordRequiredError,
    );
    answers['plugin:papyra|open'] = () => {
      throw 'papyra/incorrect-password the supplied password is incorrect';
    };
    expect(engine.open(new Uint8Array())).rejects.toBeInstanceOf(
      IncorrectPasswordError,
    );
  });

  test('renders by fetching the page from the papyra protocol', async () => {
    const urls: string[] = [];
    const fetched = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(new Uint8Array(612 * 792 * 4), {
        headers: { 'x-width': '612', 'x-height': '792' },
      });
    }) as never;
    try {
      const engine = new TauriEngine({ format: 'rgba' });
      const doc = await engine.open(new Uint8Array());
      const page = await engine.render(doc, 0, {
        fitWidth: 612,
        annotations: false,
      }).promise;
      expect(urls).toEqual([
        'papyra://localhost/7/0?dpi=72&annots=0&format=rgba',
      ]);
      expect(page).toMatchObject({ width: 612, height: 792, stride: 2448 });
      expect('data' in page && page.data.byteLength).toBe(612 * 792 * 4);
    } finally {
      globalThis.fetch = fetched;
    }
  });

  test('a failed page render rejects with the host’s message', async () => {
    const fetched = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('page 9 out of range', { status: 422 })) as never;
    try {
      const engine = new TauriEngine();
      const doc = await engine.open(new Uint8Array());
      expect(engine.render(doc, 1).promise).rejects.toThrow(
        'page 9 out of range',
      );
    } finally {
      globalThis.fetch = fetched;
    }
  });

  test('reads text, links and the outline through the plugin’s commands', async () => {
    answers['plugin:papyra|page_text'] = () => ({
      lines: [
        {
          text: 'hi',
          offsets: [0, 5, 10],
          x: 1,
          y: 2,
          dx: 1,
          dy: 0,
          ascent: 8,
          descent: 2,
        },
      ],
      undecodedGlyphs: 0,
    });
    answers['plugin:papyra|links'] = () => [
      { x0: 0, y0: 0, x1: 10, y1: 5, uri: 'https://example.com', alt: null },
    ];
    answers['plugin:papyra|outline'] = () => [
      {
        title: 'One',
        level: 0,
        dest: null,
        bold: false,
        italic: false,
        open: true,
      },
      {
        title: 'Two',
        level: 1,
        dest: null,
        bold: false,
        italic: false,
        open: true,
      },
    ];
    const engine = new TauriEngine();
    const doc = await engine.open(new Uint8Array());

    const text = await engine.pageText(doc, 1);
    expect(text.page).toBe(1);
    expect(text.lines[0]?.offsets).toBeInstanceOf(Float32Array);
    expect(calls.at(-1)).toMatchObject({ args: { id: 7, index: 1 } });

    const [link] = await engine.links(doc, 0);
    expect(link?.target).toEqual({ kind: 'uri', uri: 'https://example.com' });

    const outline = await engine.outline(doc);
    expect(outline[0]?.children[0]?.title).toBe('Two');
  });

  test('reads labels, attachments and the structure tree through the plugin’s commands', async () => {
    answers['plugin:papyra|page_labels'] = () => ['i', 'ii'];
    answers['plugin:papyra|attachments'] = () => [
      { name: 'factur-x.xml', mediaType: 'text/xml', size: 3 },
      { name: 'notes.txt' },
    ];
    answers['plugin:papyra|attachment_data'] = () =>
      new Uint8Array([104, 105]).buffer;
    const entry = { content: [], alt: null, actualText: null, lang: null };
    answers['plugin:papyra|struct_tree'] = () => [
      {
        ...entry,
        level: 0,
        role: 'Document',
        rawRole: 'Document',
        title: null,
      },
      { ...entry, level: 1, role: 'Sect', rawRole: 'Column', title: 'Left' },
      { ...entry, level: 0, role: 'P', rawRole: 'P', title: null },
    ];
    const engine = new TauriEngine();
    const doc = await engine.open(new Uint8Array());

    expect(await engine.pageLabels(doc)).toEqual(['i', 'ii']);

    const files = await engine.attachments(doc);
    expect(files.map((f) => [f.index, f.name, f.mediaType, f.size])).toEqual([
      [0, 'factur-x.xml', 'text/xml', 3],
      [1, 'notes.txt', null, null],
    ]);

    const bytes = await engine.attachmentData(doc, 1);
    expect(bytes).toEqual(new Uint8Array([104, 105]));
    expect(calls.at(-1)).toMatchObject({
      cmd: 'plugin:papyra|attachment_data',
      args: { id: 7, index: 1 },
    });

    const tree = await engine.structTree(doc);
    expect(tree.map((n) => n.role)).toEqual(['Document', 'P']);
    expect(tree[0]?.children[0]).toMatchObject({
      role: 'Sect',
      rawRole: 'Column',
      title: 'Left',
    });
  });

  test('closing the document releases it in the host, and can be awaited', async () => {
    answers['plugin:papyra|close'] = () => null;
    const engine = new TauriEngine();
    const doc = await engine.open(new Uint8Array());
    await engine.close(doc);
    expect(calls.at(-1)).toMatchObject({
      cmd: 'plugin:papyra|close',
      args: { id: 7 },
    });
  });

  test('a close the host refuses rejects, rather than vanishing', async () => {
    answers['plugin:papyra|close'] = () => {
      throw 'papyra: host gone';
    };
    const engine = new TauriEngine();
    const doc = await engine.open(new Uint8Array());
    expect(engine.close(doc)).rejects.toBe('papyra: host gone');
    // The handle is closed on this side either way.
    expect(() => engine.render(doc, 0)).toThrow('closed');
  });
});

describe('openTiff', () => {
  const PAGE = {
    width: 1700,
    height: 2200,
    xDpi: 200,
    yDpi: 200,
    compression: 'ccitt-g4',
    bitsPerSample: 1,
    samplesPerPixel: 1,
    orientation: 1,
  };

  test('opens in the host and decodes pages over the protocol, as PNG by default', async () => {
    answers['plugin:papyra|open_tiff'] = () => ({ id: 3, pages: [PAGE] });
    const decoded: unknown[] = [];
    Object.assign(globalThis, {
      createImageBitmap: async (blob: Blob) => {
        decoded.push(blob);
        return { width: 4, height: 2 };
      },
    });
    try {
      const tiff = await openTiff(new Uint8Array([1, 2]));
      expect(calls[0]).toMatchObject({
        cmd: 'plugin:papyra|open_tiff',
        args: new Uint8Array([1, 2]),
      });
      // papyra's own TiffImage, normalising the plugin's napi-shaped pages.
      expect(tiff.pageCount).toBe(1);
      expect(tiff.pages[0]?.dpi).toEqual({ x: 200, y: 200 });

      const page = await fetching((urls) =>
        tiff.renderPage(0, { maxWidth: 800.7 }).then((page) => {
          expect(urls).toEqual([
            'papyra://localhost/3/0?maxWidth=800&format=png',
          ]);
          return page;
        }),
      );
      expect(page).toEqual({ width: 4, height: 2 } as never);
      expect(decoded).toHaveLength(1);
      expect(tiff.renderPage(1)).rejects.toThrow(RangeError);
    } finally {
      delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    }
  });

  test('sends RGBA when asked, and closes in the host', async () => {
    answers['plugin:papyra|open_tiff'] = () => ({ id: 3, pages: [PAGE] });
    answers['plugin:papyra|close'] = () => null;
    const tiff = await openTiff(new Uint8Array(), { format: 'rgba' });
    await fetching(async (urls) => {
      const page = await tiff.renderPage(0, { maxPixels: 1e6 });
      expect(urls).toEqual([
        'papyra://localhost/3/0?maxPixels=1000000&format=rgba',
      ]);
      expect('data' in page && page.data.byteLength).toBe(32);
    });
    await tiff.close();
    expect(calls.at(-1)).toMatchObject({
      cmd: 'plugin:papyra|close',
      args: { id: 3 },
    });
  });

  test('refuses sizes the host could not read, before asking it', async () => {
    answers['plugin:papyra|open_tiff'] = () => ({ id: 3, pages: [PAGE] });
    const tiff = await openTiff(new Uint8Array(), { format: 'rgba' });
    await fetching(async (urls) => {
      expect(tiff.renderPage(0, { maxWidth: 1e21 })).rejects.toThrow(
        RangeError,
      );
      expect(tiff.renderPage(0, { maxPixels: 0.5 })).rejects.toThrow(
        RangeError,
      );
      expect(urls).toEqual([]);
    });
  });
});

/**
 * A window as the plugin's `pack` lays it out, built here from rows of strings so a
 * test can say what each cell holds.
 */
function pack(rows: string[][]): ArrayBuffer {
  const cols = rows[0]?.length ?? 0;
  const n = rows.length * cols;
  const text = rows.flat().join('');
  const utf8 = new TextEncoder().encode(text);
  const kindsEnd = 16 + n;
  const numbersAt = Math.ceil(kindsEnd / 8) * 8;
  const colorsAt = numbersAt + n * 8;
  const offsetsAt = colorsAt + n * 4;
  const stylesAt = offsetsAt + (n + 1) * 4;
  const textAt = stylesAt + n * 2;
  const buffer = new ArrayBuffer(textAt + utf8.length);
  new Uint32Array(buffer, 0, 4).set([0, 0, rows.length, cols]);
  const kinds = new Uint8Array(buffer, 16, n);
  const numbers = new Float64Array(buffer, numbersAt, n);
  const colors = new Uint32Array(buffer, colorsAt, n);
  const offsets = new Uint32Array(buffer, offsetsAt, n + 1);
  const styles = new Uint16Array(buffer, stylesAt, n);
  let at = 0;
  rows.flat().forEach((cell, i) => {
    kinds[i] = cell ? 2 : 0;
    numbers[i] = i;
    colors[i] = i + 100;
    styles[i] = i % 3;
    offsets[i] = at;
    at += cell.length;
  });
  offsets[n] = at;
  new Uint8Array(buffer, textAt).set(utf8);
  return buffer;
}

describe('openWorkbook', () => {
  const ROWS = [
    ['Item', 'Qty', 'Ünit'],
    ['', '12', 'kg'],
    ['Bolt', '', 'pcs'],
  ];
  beforeEach(() => {
    answers['plugin:papyra|open_workbook'] = () => ({
      id: 5,
      format: 'csv',
      sheets: [{ name: 'Sheet1', kind: 'worksheet', visibility: 'visible' }],
      encoding: 'UTF-8',
      delimiter: ',',
    });
    answers['plugin:papyra|sheet'] = () => ({
      name: 'Sheet1',
      rows: 3,
      cols: 3,
      truncated: false,
      merges: [0, 0, 0, 1],
      styles: [
        {
          bold: true,
          italic: false,
          underline: false,
          strike: false,
          fontScale: 1,
          wrap: false,
          indent: 0,
          color: null,
        },
      ],
      layout: {
        defaultColWidth: 64,
        defaultRowHeight: 20,
        cols: [0, 1, 80],
        rows: [],
        showGridLines: false,
      },
    });
    answers['plugin:papyra|window'] = () => pack(ROWS);
  });

  test('reads a window that arrives as a number array, as postMessage IPC sends it', async () => {
    answers['plugin:papyra|window'] = () => [...new Uint8Array(pack(ROWS))];
    const sheet = await (await openWorkbook(new Uint8Array())).sheet(0);
    const w = sheet.window({ rowStart: 0, rowEnd: 3 });
    expect(w.text(0, 2)).toBe('Ünit');
    expect(w.number(2, 2)).toBe(8);
  });

  test('sends the options in a header, and reads names from the file', async () => {
    const file = new File(['a\tb'], 'export.tsv');
    const book = await openWorkbook(file, { maxCells: 1000 });
    const [open] = calls;
    expect(open?.cmd).toBe('plugin:papyra|open_workbook');
    expect(open?.options).toEqual({
      headers: {
        'x-papyra-options': encodeURIComponent(
          JSON.stringify({ maxCells: 1000, format: 'tsv' }),
        ),
      },
    });
    expect(book.format).toBe('csv');
    expect(book.delimiter).toBe(',');
  });

  test('fetches a sheet whole once, and cuts windows from it', async () => {
    const book = await openWorkbook(new Uint8Array());
    const sheet = await book.sheet(0);
    expect(calls.map((c) => c.cmd)).toEqual([
      'plugin:papyra|open_workbook',
      'plugin:papyra|sheet',
      'plugin:papyra|window',
    ]);
    expect(calls.at(-1)?.args).toEqual({
      id: 5,
      sheet: 0,
      rowStart: 0,
      rowEnd: 3,
      colStart: 0,
      colEnd: 3,
    });
    expect(sheet.merges).toEqual([{ row: 0, col: 0, lastRow: 0, lastCol: 1 }]);
    expect(sheet.styles[0]).toEqual({
      bold: true,
      italic: false,
      underline: false,
      strike: false,
      fontScale: 1,
      wrap: false,
      indent: 0,
    });
    expect(sheet.layout?.columns).toEqual([{ first: 0, last: 1, width: 80 }]);

    const w = sheet.window({ rowStart: 1, rowEnd: 9, colStart: 1, colEnd: 3 });
    expect([w.rowStart, w.colStart, w.rows, w.cols]).toEqual([1, 1, 2, 2]);
    expect(w.text(1, 1)).toBe('12');
    expect(w.text(1, 2)).toBe('kg');
    expect(w.text(2, 1)).toBe('');
    expect(w.kind(2, 1)).toBe('empty');
    expect(w.text(2, 2)).toBe('pcs');
    expect(w.number(2, 2)).toBe(8);
    expect(w.style(2, 2)).toBe(2);
    // Outside the window, as papyra's own reads it.
    expect(w.text(0, 0)).toBe('');
    const all = sheet.window({ rowStart: 0, rowEnd: 3 });
    expect(all.text(0, 2)).toBe('Ünit');
    expect(all.text(2, 0)).toBe('Bolt');

    // A second read of the sheet is papyra's cache, not another fetch.
    await book.sheet(0);
    expect(calls).toHaveLength(3);
  });

  test('an encrypted workbook is papyra’s typed error, and closing frees it', async () => {
    answers['plugin:papyra|open_workbook'] = () => {
      throw 'papyra/encrypted-workbook the workbook is encrypted';
    };
    expect(openWorkbook(new Uint8Array())).rejects.toBeInstanceOf(
      EncryptedWorkbookError,
    );
    answers['plugin:papyra|open_workbook'] = () => ({
      id: 5,
      format: 'xlsx',
      sheets: [],
      encoding: null,
      delimiter: null,
    });
    answers['plugin:papyra|close'] = () => null;
    const book = await openWorkbook(new Uint8Array());
    await book.close();
    expect(calls.at(-1)).toMatchObject({
      cmd: 'plugin:papyra|close',
      args: { id: 5 },
    });
  });
});

describe('TauriOfficeEngine', () => {
  test('opens through the office plugin and renders over the shared protocol', async () => {
    answers['plugin:papyra-office|open'] = () => ({
      id: 9,
      kind: 'slides',
      sizes: [[960, 540]],
    });
    answers['plugin:papyra|close'] = () => null;
    const engine = new TauriOfficeEngine({ format: 'rgba' });
    const doc = await engine.open(new Uint8Array([7]));
    expect(calls[0]).toMatchObject({
      cmd: 'plugin:papyra-office|open',
      args: new Uint8Array([7]),
    });
    expect(doc.kind).toBe('slides');
    expect(doc.pageSize(0)).toEqual({ width: 960, height: 540 });
    expect(doc.capabilities.links).toBe(false);

    await fetching(async (urls) => {
      await engine.render(doc, 0, { fitWidth: 1920 }).promise;
      expect(urls).toEqual(['papyra://localhost/9/0?dpi=144&format=rgba']);
    });
    await engine.close(doc);
    expect(calls.at(-1)).toMatchObject({
      cmd: 'plugin:papyra|close',
      args: { id: 9 },
    });
  });

  test('registers fonts with the host', async () => {
    answers['plugin:papyra-office|add_font'] = () => 2;
    expect(await new TauriOfficeEngine().addFont(new Uint8Array([1]))).toBe(2);
    expect(calls.at(-1)?.cmd).toBe('plugin:papyra-office|add_font');
  });
});
