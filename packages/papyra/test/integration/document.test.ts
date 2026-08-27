import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { open } from '../../src/index.js';

/**
 * These need the compiled addon and the corpus, which is why they live apart from
 * `test/unit`: CI's `unit-test` job runs the pure units with no Rust toolchain and no
 * build, and importing the wrapper's entrypoint here would load the native binding and
 * fail that job. `bun run test:integration` runs these, against a real artifact.
 *
 * Fixtures come from pdf.js's regression suite, fetched rather than vendored
 * (`bun run corpus`). Skip rather than fail when it is absent, so a fresh clone can
 * still run them without a network round trip.
 */
const CORPUS = join(import.meta.dir, '..', '..', '..', '..', 'corpus');
const has = (name: string) => existsSync(join(CORPUS, name));
const load = (name: string) => open(readFileSync(join(CORPUS, name)));

const describeWithCorpus = has('basicapi.pdf') ? describe : describe.skip;

describeWithCorpus('outline, against real documents', () => {
  test('reads a nested outline with style flags', async () => {
    const doc = await load('basicapi.pdf');
    const tree = await doc.outline();

    expect(tree.map((n) => n.title)).toEqual(['INDEX', 'Chapter 1']);
    expect(tree[1]?.bold).toBe(true);
    expect(tree[1]?.children.map((n) => n.title)).toEqual(['Paragraph 1.1']);
    expect(tree[1]?.children[0]?.page).toBe(2);
  });

  test('keeps an entry whose action leaves the document, with no destination', async () => {
    const doc = await load('issue3214.pdf');
    const tree = await doc.outline();

    const url = tree.find((n) => n.title.includes('google.com'));
    expect(url).toBeDefined();
    expect(url?.dest).toBeNull();
    // The rest of the outline still resolves.
    expect(tree.filter((n) => n.page !== null)).toHaveLength(4);
    expect(tree[0]?.bold).toBe(true);
    expect(tree[1]?.italic).toBe(true);
  });

  test('resolves named destinations written as both names and strings', async () => {
    const doc = await load('issue19474.pdf');
    const tree = await doc.outline();
    expect(tree.map((n) => n.page)).toEqual([0, 1, 2]);
  });

  test('reads an XYZ view whose zoom is absent', async () => {
    const doc = await load('issue18408_reduced.pdf');
    const tree = await doc.outline();
    expect(tree[0]?.dest).toMatchObject({ kind: 'XYZ', top: 705, zoom: null });
  });

  test('reads a FitH view whose top is absent', async () => {
    const doc = await load('bug1907000_reduced.pdf');
    const tree = await doc.outline();
    expect(tree[0]?.dest).toMatchObject({ kind: 'FitH', top: null });
  });

  test('a document with no outline resolves to an empty array', async () => {
    const doc = await load('tracemonkey.pdf');
    expect(await doc.outline()).toEqual([]);
  });

  test('the walk is memoised', async () => {
    const doc = await load('basicapi.pdf');
    expect(await doc.outline()).toBe(await doc.outline());
  });
});

describeWithCorpus('text and search, against real documents', () => {
  test('extracts a page of a paper, spaces and all', async () => {
    const doc = await load('tracemonkey.pdf');
    const text = await doc.pageText(0);

    expect(text.lines[0]?.text).toBe(
      'Trace-based Just-in-Time Type Specialization for Dynamic',
    );
    expect(text.undecodedGlyphs).toBe(0);
    // Justified body text positions words rather than emitting space glyphs; if that
    // is not put back the whole line becomes one unsearchable word.
    const body = text.lines.map((l) => l.text).join(' ');
    expect(body).toContain('traditional compilers need to emit generic code');
  });

  test('finds a phrase broken across a line break, with a quad per line', async () => {
    const doc = await load('tracemonkey.pdf');
    const hits = [];
    for await (const hit of doc.search('dynamic languages', { limit: 1 })) {
      hits.push(hit);
    }
    expect(hits).toHaveLength(1);
    // The title reads "… for Dynamic" / "Languages".
    expect(hits[0]?.quads).toHaveLength(2);
    expect(hits[0]?.text).toBe('Dynamic\nLanguages');
  });

  test('folds diacritics so a plain keyboard finds accented text', async () => {
    const doc = await load('160F-2019.pdf');
    const hits = [];
    for await (const hit of doc.search('annee')) hits.push(hit);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toBe('année');
  });

  test('reports text it cannot decode rather than claiming there is none', async () => {
    // A CID font with no ToUnicode cmap: the page has visible text that no encoding
    // maps back to Unicode. "No results" and "not searchable" are different answers.
    const doc = await load('arial_unicode_en_cidfont.pdf');
    const text = await doc.pageText(0);
    expect(text.lines).toHaveLength(0);
    expect(text.undecodedGlyphs).toBeGreaterThan(0);
  });

  test('a page that draws no text at all reports neither', async () => {
    const doc = await load('cmykjpeg.pdf');
    const text = await doc.pageText(0);
    expect(text.lines).toHaveLength(0);
    expect(text.undecodedGlyphs).toBe(0);
  });

  test('text coordinates line up with the rendered page', async () => {
    // Extraction reports 72-DPI page space, so scaling by the render's own ratio has
    // to land inside the bitmap. Getting this wrong puts every highlight elsewhere.
    const doc = await load('tracemonkey.pdf');
    const size = doc.pageSize(0);
    const rendered = await doc.renderPage(0, { fitWidth: 800 });
    const scale = rendered.width / size.width;

    const text = await doc.pageText(0);
    for (const line of text.lines) {
      expect(line.x * scale).toBeGreaterThanOrEqual(0);
      expect(line.x * scale).toBeLessThanOrEqual(rendered.width);
      expect(line.y * scale).toBeGreaterThanOrEqual(0);
      expect(line.y * scale).toBeLessThanOrEqual(rendered.height);
    }
  });

  test('search honours the page order it is given', async () => {
    const doc = await load('tracemonkey.pdf');
    const pages: number[] = [];
    // No limit: a common word fills a single page with more hits than any limit
    // worth setting, which would stop the search before it reached the second page.
    for await (const hit of doc.search('trace', { order: [5, 2] })) {
      pages.push(hit.page);
    }
    expect(new Set(pages)).toEqual(new Set([5, 2]));
    expect(pages).toEqual([...pages].sort((a, b) => b - a));
  });

  test('limit stops the search early', async () => {
    const doc = await load('tracemonkey.pdf');
    const hits = [];
    for await (const hit of doc.search('the', { limit: 3 })) hits.push(hit);
    expect(hits).toHaveLength(3);
  });

  test('indexText fills the cache so a later search never extracts', async () => {
    const doc = await load('tracemonkey.pdf');
    await doc.indexText();
    const before = doc.textCache.misses;
    for await (const _ of doc.search('trace')) {
      // drain
    }
    expect(doc.textCache.misses).toBe(before);
    expect(doc.textCache.entries).toBe(doc.pageCount);
  });

  test('an empty query searches nothing', async () => {
    const doc = await load('tracemonkey.pdf');
    const hits = [];
    for await (const hit of doc.search('   ')) hits.push(hit);
    expect(hits).toEqual([]);
  });
});
