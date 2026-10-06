import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codeRenderer } from '@/components/file-preview-code';
import { createFilePreview } from '@/components/file-preview-create';
import { imageRenderer, sniffImage } from '@/components/file-preview-image';
import { pdfRenderer, sniffPdf } from '@/components/file-preview-pdf';
import {
  acceptOf,
  defineRenderer,
  detect,
  detectHead,
  extensionOf,
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
    const head = ascii('{"a": 1}');
    const first = detectHead(named('a.json'), head, [json, codeRenderer]);
    const second = detectHead(named('a.json'), head, [codeRenderer, json]);
    expect(first.status === 'ok' && first.renderer.id).toBe('json');
    expect(second.status === 'ok' && second.renderer.id).toBe('code');
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
};

test('the allow list is typed from the renderers (see typecheck)', () => {
  expect(typeChecks).toBeFunction();
});
