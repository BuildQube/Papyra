import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { audioRenderer, sniffAudio } from '@/components/file-preview-audio';
import { codeRenderer } from '@/components/file-preview-code';
import { createFilePreview } from '@/components/file-preview-create';
import { csvRenderer } from '@/components/file-preview-csv';
import { imageRenderer, sniffImage } from '@/components/file-preview-image';
import { pdfRenderer, sniffPdf } from '@/components/file-preview-pdf';
import { spreadsheetRenderer } from '@/components/file-preview-spreadsheet';
import { sniffTiff, tiffRenderer } from '@/components/file-preview-tiff';
import { sniffVideo, videoRenderer } from '@/components/file-preview-video';
import {
  acceptOf,
  defineRenderer,
  detect,
  detectHead,
  extensionOf,
  type FileRenderer,
} from '@/lib/file-preview-core';

const ascii = (s: string) => new TextEncoder().encode(s);
const bytes = (...b: number[]) => new Uint8Array(b);
const named = (name: string, type = '') => ({ name, type });

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const ALL = [pdfRenderer, imageRenderer, codeRenderer] as const;

describe('sniffImage', () => {
  test.each([
    ['png', PNG],
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['gif', ascii('GIF89a\x01\x00')],
    ['webp', ascii('RIFF\x00\x00\x00\x00WEBPVP8L')],
    ['avif', ascii('\x00\x00\x00\x20ftypavif')],
    ['ico', bytes(0, 0, 1, 0, 1, 0, 16, 16)],
    ['svg', ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    [
      'svg behind a prolog, comment and doctype',
      ascii(
        '<?xml version="1.0"?>\n<!-- (c) someone -->\n<!DOCTYPE svg PUBLIC "x">\n<svg>',
      ),
    ],
  ])('recognises %s', (_, head) => {
    expect(sniffImage(head)).toBe(true);
  });

  test('recognises a BMP by its DIB header size', () => {
    const head = new Uint8Array(32);
    head.set(ascii('BM'));
    head[14] = 40;
    expect(sniffImage(head)).toBe(true);
  });

  test.each([
    ['text that happens to start with BM', ascii('BMW service history, 2019')],
    ['an HTML page', ascii('<!doctype html><html><svg></svg>')],
    ['an empty file', new Uint8Array()],
    ['a PDF', ascii('%PDF-1.7\n')],
  ])('rejects %s', (_, head) => {
    expect(sniffImage(head)).toBe(false);
  });
});

describe('sniffTiff', () => {
  test.each([
    ['little-endian', bytes(0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0)],
    ['big-endian', bytes(0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8)],
    ['BigTIFF, little-endian', bytes(0x49, 0x49, 0x2b, 0x00, 8, 0, 0, 0)],
    ['BigTIFF, big-endian', bytes(0x4d, 0x4d, 0x00, 0x2b, 0, 8, 0, 0)],
  ])('recognises %s', (_, head) => {
    expect(sniffTiff(head)).toBe(true);
  });

  test.each([
    // Mixed byte orders are not a TIFF, whatever the magic number.
    ['mixed byte order', bytes(0x49, 0x49, 0x00, 0x2a)],
    ['text that happens to start with II', ascii('II* is not an asterisk')],
    ['a truncated header', bytes(0x49, 0x49, 0x2a)],
    ['a PNG', PNG],
  ])('rejects %s', (_, head) => {
    expect(sniffTiff(head)).toBe(false);
  });

  test('a TIFF is not an image to the image renderer, whatever its MIME type', () => {
    const head = bytes(0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0);
    // The browser cannot draw it, so `image/*` must not claim it.
    const alone = detectHead(named('scan.tif', 'image/tiff'), head, [
      imageRenderer,
    ]);
    expect(alone.status).toBe('unsupported');
    // With the TIFF renderer listed anywhere, it wins on the bytes.
    const both = detectHead(named('scan.tif', 'image/tiff'), head, [
      imageRenderer,
      tiffRenderer,
    ]);
    expect(both.status === 'ok' && both.renderer.id).toBe('tiff');
  });

  test('bytes win over the name in both directions', () => {
    const tiff = bytes(0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8);
    const renamed = detectHead(named('scan.pdf'), tiff, [
      pdfRenderer,
      tiffRenderer,
    ]);
    expect(renamed.status === 'ok' && renamed.renderer.id).toBe('tiff');
    const fake = detectHead(named('scan.tiff', 'image/tiff'), PNG, [
      tiffRenderer,
    ]);
    expect(fake.status).toBe('unsupported');
  });
});

describe('sniffPdf', () => {
  test('finds the header at the start', () => {
    expect(sniffPdf(ascii('%PDF-1.7\n%\xe2\xe3'))).toBe(true);
  });

  test('finds the header behind leading junk, as Acrobat does', () => {
    expect(sniffPdf(ascii('﻿X-Gateway: scanned\r\n%PDF-1.4'))).toBe(true);
  });

  test('does not take a near miss', () => {
    expect(sniffPdf(ascii('% PDF-1.7 is a format'))).toBe(false);
    expect(sniffPdf(ascii('%PDF'))).toBe(false);
  });
});

/** An ISO-BMFF head: a box size, `ftyp`, then the major brand. */
const ftyp = (brand: string) =>
  ascii(`\x00\x00\x00\x20ftyp${brand}\x00\x00\x00\x00`);
const EBML = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81);
const oggWith = (codec: string) =>
  ascii(`OggS\x00\x02${'\x00'.repeat(22)}\x01${codec}`);

describe('sniffVideo and sniffAudio', () => {
  test.each([
    ['mp4', ftyp('isom'), true, false],
    ['quicktime', ftyp('qt  '), true, false],
    ['webm', EBML, true, false],
    ['ogg theora', oggWith('theora'), true, false],
    ['m4a', ftyp('M4A '), false, true],
    ['ogg opus', oggWith('OpusHead'), false, true],
    ['mp3 with ID3', ascii('ID3\x04\x00'), false, true],
    ['mp3 frame', bytes(0xff, 0xfb, 0x90, 0x00), false, true],
    ['aac adts', bytes(0xff, 0xf1, 0x50, 0x80), false, true],
    ['wav', ascii('RIFF\x00\x00\x00\x00WAVEfmt '), false, true],
    ['flac', ascii('fLaC\x00\x00\x00\x22'), false, true],
    // Formats sharing a container or a sync word with these must not be claimed.
    ['avif', ftyp('avif'), false, false],
    ['heic', ftyp('heic'), false, false],
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0), false, false],
    ['webp', ascii('RIFF\x00\x00\x00\x00WEBPVP8L'), false, false],
    ['avi', ascii('RIFF\x00\x00\x00\x00AVI LIST'), false, false],
    ['a reserved mpeg header', bytes(0xff, 0xe0, 0x00, 0x00), false, false],
  ])('%s: video %p, audio %p', (_, head, video, audio) => {
    expect(sniffVideo(head)).toBe(video);
    expect(sniffAudio(head)).toBe(audio);
  });

  test('the image, video and audio renderers split one container between them', () => {
    const all = [imageRenderer, videoRenderer, audioRenderer] as const;
    const id = (head: Uint8Array) => {
      const d = detectHead(named('x'), head, all);
      return d.status === 'ok' ? d.renderer.id : d.status;
    };
    expect(id(ftyp('avif'))).toBe('image');
    expect(id(ftyp('mp42'))).toBe('video');
    expect(id(ftyp('M4A '))).toBe('audio');
  });
});

describe('detectHead', () => {
  test('bytes win over the name: a PNG called notes.txt is an image', () => {
    const d = detectHead(named('notes.txt', 'text/plain'), PNG, ALL);
    expect(d.status === 'ok' && d.renderer.id).toBe('image');
  });

  test('a page renamed to .png is not an image', () => {
    const html = ascii('<!doctype html><script>alert(1)</script>');
    const d = detectHead(named('photo.png', 'image/png'), html, ALL);
    expect(d.status).toBe('unsupported');
  });

  test('a binary named like source code is not code', () => {
    const d = detectHead(
      named('main.ts'),
      bytes(0x7f, 0x45, 0x4c, 0x46, 0),
      ALL,
    );
    expect(d.status).toBe('unsupported');
  });

  test('text matches by extension, and by MIME type', () => {
    const text = ascii('export const x = 1;\n');
    const byExt = detectHead(named('x.ts'), text, ALL);
    const byMime = detectHead(named('README', 'text/plain'), text, ALL);
    expect(byExt.status === 'ok' && byExt.renderer.id).toBe('code');
    expect(byMime.status === 'ok' && byMime.renderer.id).toBe('code');
  });

  test('a disallowed format is refused, not reinterpreted', () => {
    // An SVG is text with an extension `code` does not claim — but even one it did
    // would be refused: what a file *is* does not depend on what is allowed.
    const svg = ascii('<svg></svg>');
    const d = detectHead(named('logo.svg'), svg, ALL, ['code']);
    expect(d.status).toBe('blocked');
    expect(d.status === 'blocked' && d.renderer.id).toBe('image');
  });

  test('list order is priority', () => {
    const json = defineRenderer({
      id: 'json',
      label: 'JSON',
      extensions: ['.json'],
      mimes: [],
      text: true,
      load: async () => () => null,
    });
    const tree = defineRenderer({
      id: 'tree',
      label: 'JSON tree',
      extensions: ['.json'],
      mimes: [],
      text: true,
      load: async () => () => null,
    });
    const head = ascii('{"a": 1}');
    const id = (list: Parameters<typeof detectHead>[2]) => {
      const d = detectHead(named('a.json'), head, list);
      return d.status === 'ok' && d.renderer.id;
    };
    // Between peers claiming the same extension, the first listed wins.
    expect(id([json, tree])).toBe('json');
    expect(id([tree, json])).toBe('tree');
    // `code` is a fallback, so it is not a peer: it loses in either position.
    expect(id([codeRenderer, json])).toBe('json');
    expect(id([json, codeRenderer])).toBe('json');
  });

  test('a MIME type with parameters still matches', () => {
    const d = detectHead(
      named('data', 'application/json; charset=utf-8'),
      ascii('{}'),
      ALL,
    );
    expect(d.status === 'ok' && d.renderer.id).toBe('code');
  });
});

describe('detectHead, spreadsheets and CSV', () => {
  const id = (
    file: { name: string; type: string },
    head: Uint8Array,
    renderers: readonly FileRenderer[],
  ) => {
    const d = detectHead(file, head, renderers);
    return d.status === 'ok' ? d.renderer.id : d.status;
  };
  const CSV = ascii('a,b\n1,2\n');

  test('a wildcard MIME type loses to an exact one, wherever it is listed', () => {
    // `code` claims `text/*`. Listed first it used to take every `text/csv`.
    expect(
      id(named('export', 'text/csv'), CSV, [codeRenderer, csvRenderer]),
    ).toBe('csv');
    expect(
      id(named('notes', 'text/plain'), CSV, [codeRenderer, csvRenderer]),
    ).toBe('code');
  });

  test('the extension beats a MIME type the OS got wrong', () => {
    // Windows with Excel installed reports every .csv as an Excel workbook.
    const file = named('data.csv', 'application/vnd.ms-excel');
    expect(id(file, CSV, [spreadsheetRenderer, csvRenderer])).toBe('csv');
  });

  test('UTF-16 text is still a CSV, NULs and all', () => {
    const utf16 = bytes(0xff, 0xfe, 0x61, 0, 0x2c, 0, 0x62, 0);
    expect(id(named('unicode.csv'), utf16, [codeRenderer, csvRenderer])).toBe(
      'csv',
    );
  });

  test('workbooks match by name, since their containers are shared', () => {
    // An OLE compound file is an .xls, a .doc or an .msg; the name decides.
    const cfb = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    const all = [pdfRenderer, imageRenderer, spreadsheetRenderer] as const;
    const d = detectHead(named('budget.xls'), cfb, all);
    expect(d.status === 'ok' && d.renderer.id).toBe('spreadsheet');
    expect(detectHead(named('letter.doc'), cfb, all).status).toBe(
      'unsupported',
    );
  });
});

test('detect reads the head of a real File', async () => {
  const file = new File([PNG, new Uint8Array(4096)], 'scan.dat');
  const d = await detect(file, ALL);
  expect(d.status === 'ok' && d.renderer.id).toBe('image');
});

test('extensionOf ignores dotfiles and folds case', () => {
  expect(extensionOf('Report.PDF')).toBe('.pdf');
  expect(extensionOf('archive.tar.gz')).toBe('.gz');
  expect(extensionOf('.env')).toBe('');
  expect(extensionOf('Makefile')).toBe('');
});

test('acceptOf lists only what is allowed', () => {
  expect(acceptOf(ALL, ['pdf'])).toBe('application/pdf,.pdf');
  expect(acceptOf(ALL)).toContain('image/*');
});

describe('laziness', () => {
  // The whole point of the split: holding a renderer must not pull in its view. A
  // static import of the view (or of papyra, or shiki) from a descriptor would put
  // it in every bundle that lists the format, used or not.
  test.each([
    'file-preview-pdf',
    'file-preview-image',
    'file-preview-code',
    'file-preview-video',
    'file-preview-audio',
    'file-preview-spreadsheet',
    'file-preview-csv',
    'file-preview-tiff',
    'file-preview-markdown',
  ])('%s imports only the core statically', async (name) => {
    const source = await readFile(
      join(import.meta.dir, '../../src/components', `${name}.ts`),
      'utf8',
    );
    const imports = new Bun.Transpiler({ loader: 'ts' }).scanImports(source);
    const statics = imports
      .filter((i) => i.kind === 'import-statement')
      .map((i) => i.path);
    const dynamics = imports
      .filter((i) => i.kind === 'dynamic-import')
      .map((i) => i.path);
    expect(statics).toEqual(['@/lib/file-preview-core']);
    // Relative, so it survives `shadcn add` untouched: the two files install side
    // by side, and an alias inside `import()` is not one the CLI promises to rewrite.
    expect(dynamics).toEqual([`./${name}-view`]);
  });

  // Not the PDF view: loading it loads papyra, which loads the addon, which this
  // job does not have.
  test.each([
    imageRenderer,
    codeRenderer,
  ])('$id loads a component', async (renderer) => {
    expect(typeof (await renderer.load())).toBe('function');
  });
});

describe('createFilePreview', () => {
  test('returns a component', () => {
    expect(typeof createFilePreview([imageRenderer, codeRenderer])).toBe(
      'function',
    );
  });

  test('throws on a duplicate id, for callers the type check did not reach', () => {
    const loose: readonly (typeof imageRenderer)[] = [
      imageRenderer,
      imageRenderer,
    ];
    expect(() => createFilePreview(loose)).toThrow('duplicate renderer id');
  });
});

/**
 * Compile-time only: `typecheck` runs over this file and fails if an expected error
 * disappears. Never called — calling a component outside React would render it.
 */
const typeChecks = () => {
  const Preview = createFilePreview([pdfRenderer, imageRenderer]);
  const props = { files: [] as File[] };

  Preview({ ...props, allow: ['pdf', 'image'] });
  // @ts-expect-error -- 'code' was not passed to createFilePreview
  Preview({ ...props, allow: ['code'] });
  // @ts-expect-error -- not a renderer anywhere
  Preview({ ...props, allow: ['docx'] });

  // @ts-expect-error -- two renderers claim 'image'
  createFilePreview([imageRenderer, pdfRenderer, imageRenderer]);

  // An id survives `defineRenderer` as a literal, not as `string`.
  const custom = defineRenderer({
    id: 'csv',
    label: 'CSV',
    extensions: ['.csv'],
    mimes: ['text/csv'],
    text: true,
    load: async () => () => null,
  });
  const WithCsv = createFilePreview([custom, codeRenderer]);
  WithCsv({ ...props, allow: ['csv'] });
  // @ts-expect-error -- 'pdf' is not in this preview
  WithCsv({ ...props, allow: ['pdf'] });

  // A streaming renderer's view takes a URL, not a File, and mixes into one list.
  const video = defineRenderer({
    id: 'video',
    label: 'Video',
    extensions: ['.mp4'],
    mimes: ['video/*'],
    input: 'url',
    load: async () => (p: { url: string; refresh: () => Promise<string> }) =>
      void p,
  });
  const Mixed = createFilePreview([video, imageRenderer]);
  Mixed({ ...props, allow: ['video', 'image'] });
  // @ts-expect-error -- a URL view cannot ask for a File
  defineRenderer({
    id: 'bad',
    label: 'Bad',
    extensions: [],
    mimes: [],
    input: 'url',
    load: async () => (p: { file: File }) => void p,
  });
};

test('the allow list is typed from the renderers (see typecheck)', () => {
  expect(typeChecks).toBeFunction();
});
