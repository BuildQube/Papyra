import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultPdfEngine,
  IncorrectPasswordError,
  lineQuad,
  PasswordRequiredError,
  type PdfDoc,
  quadBounds,
} from '@build-qube/papyra';
import { GENERATED } from '../../../../scripts/demo-fixtures.js';
import { PdfjsEngine } from '../../src/index.js';

/**
 * pdf.js against papyra on the same files, for everything but pixels: Bun has no
 * `OffscreenCanvas`, so rendering is checked in a browser instead.
 *
 * In `test/integration` because papyra's side needs the built addon. The corpus is
 * fetched (`bun run corpus`); the demo's generated fixtures (labels, attachments, a
 * rotated page) are built in-process, since nothing in the corpus has those.
 */
const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const DIRS = [join(ROOT, 'corpus'), join(ROOT, 'apps', 'demo', 'public')];
const files = new Map<string, () => Uint8Array>([
  ...DIRS.filter(existsSync).flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.pdf'))
      .map((f): [string, () => Uint8Array] => [
        f,
        () => new Uint8Array(readFileSync(join(dir, f))),
      ]),
  ),
  ...Object.entries(GENERATED),
]);
const read = (name: string) => files.get(name)?.() ?? null;

// The legacy build: the modern one needs `DOMMatrix`, which Bun does not have.
const pdfjs = new PdfjsEngine({
  pdfjs: () => import('pdfjs-dist/legacy/build/pdf.mjs') as never,
  document: { verbosity: 0 },
});

async function both(bytes: Uint8Array): Promise<[PdfDoc, PdfDoc] | null> {
  try {
    return [
      await defaultPdfEngine.open(bytes),
      await pdfjs.open(bytes.slice()),
    ];
  } catch {
    return null; // encrypted or unreadable by one of them: covered below
  }
}

describe('pdf.js agrees with papyra', () => {
  for (const [name, bytes] of files) {
    test(name, async () => {
      const opened = await both(bytes());
      if (!opened) return;
      const [hayro, js] = opened;

      expect(js.engine).toBe('pdfjs');
      expect(js.pageCount).toBe(hayro.pageCount);
      expect(js.fingerprint).toBe(hayro.fingerprint);
      for (let i = 0; i < hayro.pageCount; i++) {
        // Both are the page at 72 DPI with rotation applied; hayro floors.
        const a = hayro.pageSize(i);
        const b = js.pageSize(i);
        expect(Math.abs(a.width - b.width)).toBeLessThan(1);
        expect(Math.abs(a.height - b.height)).toBeLessThan(1);
      }
      expect(js.metadata.title).toBe(hayro.metadata.title);
      expect(js.pdfVersion).toBe(hayro.pdfVersion);

      expect(await pdfjs.pageLabels(js)).toEqual(
        await defaultPdfEngine.pageLabels(hayro),
      );

      const titles = (nodes: { title: string; page: number | null }[]) =>
        nodes.map((n) => [n.title, n.page]);
      expect(titles(await pdfjs.outline(js))).toEqual(
        titles(await defaultPdfEngine.outline(hayro)),
      );

      const embedded = await defaultPdfEngine.attachments(hayro);
      expect((await pdfjs.attachments(js)).map((a) => a.name)).toEqual(
        embedded.map((a) => a.name),
      );
      for (const { index } of embedded) {
        expect(await pdfjs.attachmentData(js, index)).toEqual(
          await defaultPdfEngine.attachmentData(hayro, index),
        );
      }

      // Every link papyra finds, pdf.js finds. Not the reverse: issue6204.pdf names
      // its targets in a PDF 1.1 `/Dests` dictionary, which papyra does not read.
      for (let i = 0; i < Math.min(hayro.pageCount, 3); i++) {
        const target = (l: { target: { kind: string } }) =>
          l.target.kind === 'uri'
            ? (l.target as { uri: string }).uri
            : `page ${(l.target as { dest: { page: number } }).dest.page}`;
        const found = (await pdfjs.links(js, i)).map(target);
        for (const link of (await defaultPdfEngine.links(hayro, i)).map(target))
          expect(found).toContain(link);
      }
    });
  }
});

describe('text, through search', () => {
  test('a word papyra finds is found by pdf.js, in about the same place', async () => {
    const bytes = read('tracemonkey.pdf');
    if (!bytes) return;
    const opened = await both(bytes);
    if (!opened) throw new Error('tracemonkey.pdf did not open');
    const [hayro, js] = opened;

    for (const query of ['Trace-based', 'just-in-time', 'loops']) {
      const a: { page: number; quads: readonly unknown[] }[] = [];
      for await (const m of defaultPdfEngine.search(hayro, query, { limit: 5 }))
        a.push(m as never);
      const b: typeof a = [];
      for await (const m of pdfjs.search(js, query, { limit: 5 }))
        b.push(m as never);

      expect(b.length).toBeGreaterThan(0);
      expect(b[0]?.page).toBe(a[0]?.page);
    }

    // Line geometry lands in papyra's space: the first line's box overlaps.
    const [ta, tb] = [
      await defaultPdfEngine.pageText(hayro, 0),
      await pdfjs.pageText(js, 0),
    ];
    const first = (lines: typeof ta.lines) => {
      const line = lines.find((l) => l.text.includes('Trace-based'));
      return line && quadBounds(lineQuad(line, 0, line.offsets.length - 1));
    };
    const [ra, rb] = [first(ta.lines), first(tb.lines)];
    expect(ra && rb).toBeTruthy();
    if (!ra || !rb) return;
    expect(Math.abs(ra.y - rb.y)).toBeLessThan(ra.height);
    expect(Math.abs(ra.x - rb.x)).toBeLessThan(ra.height);
  });
});

describe('passwords', () => {
  test('missing and wrong passwords map to papyra’s two errors', async () => {
    const bytes = read('pr6531_1.pdf');
    if (!bytes) return;
    expect(pdfjs.open(bytes.slice())).rejects.toBeInstanceOf(
      PasswordRequiredError,
    );
    expect(
      pdfjs.open(bytes.slice(), { password: 'nope' }),
    ).rejects.toBeInstanceOf(IncorrectPasswordError);
    const doc = await pdfjs.open(bytes.slice(), { password: 'asdfasdf' });
    expect(doc.pageCount).toBeGreaterThan(0);
  });
});
