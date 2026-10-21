import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode, type RenderedPage } from '../../src/index.js';
import { officeEngine, PapyraOfficeEngine } from '../../src/office.js';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const docx = () =>
  readFileSync(join(ROOT, 'apps', 'demo', 'public', 'sample.docx'));
const pptx = () =>
  readFileSync(
    join(ROOT, 'crates', 'papyra-office', 'tests', 'fixtures', 'sample.pptx'),
  );

const render = (
  doc: Parameters<typeof officeEngine.render>[0],
  index: number,
  options: Parameters<typeof officeEngine.render>[2] = {},
) => officeEngine.render(doc, index, options).promise as Promise<RenderedPage>;

describe('officeEngine', () => {
  test('paginates a Word document and sizes by fitWidth', async () => {
    const doc = await officeEngine.open(docx());
    expect(doc.engine).toBe('papyra-office');
    expect(doc.kind).toBe('word');
    expect(doc.pageCount).toBe(2);
    expect(doc.capabilities.links).toBe(false);
    expect(doc.pageSize(0)).toEqual({ width: 612, height: 792 });
    const page = await render(doc, 0, { fitWidth: 800 });
    expect(page.width).toBe(800);
    expect(page.height).toBe(Math.ceil((792 * 800) / 612));
    const png = await encode(page, { format: 'png' });
    expect(png.bytes.byteLength).toBeGreaterThan(1000);
  });

  test('draws a deck', async () => {
    const deck = await officeEngine.open(pptx());
    expect(deck.kind).toBe('slides');
    expect(deck.pageCount).toBeGreaterThan(1);
    const slide = await render(deck, 1, { dpi: 36 });
    expect([slide.width, slide.height]).toEqual([480, 270]);
  });

  test('refuses a workbook, and pages that do not exist', async () => {
    const xlsx = readFileSync(
      join(ROOT, 'apps', 'demo', 'public', 'sample.xlsx'),
    );
    await expect(officeEngine.open(xlsx)).rejects.toThrow(
      /not a Word document/,
    );
    const doc = await officeEngine.open(docx());
    expect(() => officeEngine.render(doc, 2)).toThrow(RangeError);
    expect(() => officeEngine.render(doc, 0, { dpi: 72 * 100 })).toThrow(
      /fitWidth/,
    );
  });

  test('queues, coalesces and caches like a PDF', async () => {
    const doc = await officeEngine.open(pptx());
    const a = officeEngine.render(doc, 0, { fitWidth: 400, priority: 1 });
    const b = officeEngine.render(doc, 0, { fitWidth: 400 });
    expect(a.key).toBe(b.key);
    a.setPriority(0);
    const [pa, pb] = await Promise.all([a.promise, b.promise]);
    expect(pa).toBe(pb);
    const again = officeEngine.render(doc, 0, { fitWidth: 400 });
    expect(again.cached).toBe(true);
    expect(await again.promise).toBe(pa);
  });

  test('a document belongs to the engine that opened it, until closed', async () => {
    const doc = await officeEngine.open(docx());
    expect(() => new PapyraOfficeEngine().render(doc, 0)).toThrow(
      /another engine/,
    );
    await officeEngine.close(doc);
    expect(() => officeEngine.render(doc, 0)).toThrow(/closed/);
  });
});
