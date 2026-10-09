import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from '../../src/index.js';
import { openOffice } from '../../src/office.js';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const docx = () =>
  readFileSync(join(ROOT, 'apps', 'demo', 'public', 'sample.docx'));
const pptx = () =>
  readFileSync(
    join(ROOT, 'crates', 'papyra-office', 'tests', 'fixtures', 'sample.pptx'),
  );

describe('openOffice', () => {
  test('paginates a Word document and sizes by fitWidth', async () => {
    const doc = await openOffice(docx());
    expect(doc.kind).toBe('word');
    expect(doc.pageCount).toBe(2);
    expect(doc.pageSize(0)).toEqual({ width: 612, height: 792 });
    const page = await doc.renderPage(0, { fitWidth: 800 });
    expect(page.width).toBe(800);
    expect(page.height).toBe(Math.ceil((792 * 800) / 612));
    // A page from here is a page anywhere else in papyra.
    const png = await encode(page, { format: 'png' });
    expect(png.bytes.byteLength).toBeGreaterThan(1000);
  });

  test('draws a deck', async () => {
    const deck = await openOffice(pptx());
    expect(deck.kind).toBe('slides');
    expect(deck.pageCount).toBeGreaterThan(1);
    const slide = await deck.renderPage(1, { scale: 0.5 });
    expect([slide.width, slide.height]).toEqual([480, 270]);
  });

  test('refuses a workbook, and pages that do not exist', async () => {
    const xlsx = readFileSync(
      join(ROOT, 'apps', 'demo', 'public', 'sample.xlsx'),
    );
    await expect(openOffice(xlsx)).rejects.toThrow(/not a Word document/);
    const doc = await openOffice(docx());
    await expect(doc.renderPage(2)).rejects.toBeInstanceOf(RangeError);
    await expect(doc.renderPage(0, { scale: 100 })).rejects.toThrow(/fitWidth/);
  });

  test('render() queues, coalesces and caches like a PDF', async () => {
    const doc = await openOffice(pptx());
    const a = doc.render(0, { fitWidth: 400, priority: 1 });
    const b = doc.render(0, { fitWidth: 400 });
    expect(a.key).toBe(b.key);
    a.setPriority(0);
    const [pa, pb] = await Promise.all([a.promise, b.promise]);
    expect(pa).toBe(pb);
    const again = doc.render(0, { fitWidth: 400 });
    expect(again.cached).toBe(true);
    expect(await again.promise).toBe(pa);
    expect(() => doc.render(0, { dpi: 72 * 100 })).toThrow(RangeError);
  });
});
