import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IncorrectPasswordError,
  lineQuad,
  open,
  PasswordError,
  PasswordRequiredError,
  quadBounds,
} from '../../src/index.js';

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

describeWithCorpus('metadata, labels and links, against real documents', () => {
  test('reads the information dictionary', async () => {
    const doc = await load('basicapi.pdf');
    expect(doc.metadata.title).toBe('Basic API Test');
    expect(doc.metadata.author).toBe('Brendan Dahl');
    expect(doc.metadata.creator).toBe('pdf.js');
    expect(doc.metadata.producer).toContain('TCPDF');
  });

  test('dates come back parseable', async () => {
    const doc = await load('basicapi.pdf');
    // The point of converting to ISO 8601 at all: `new Date` has to accept it.
    expect(Number.isNaN(Date.parse(doc.metadata.created ?? ''))).toBe(false);
    expect(doc.metadata.created).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/,
    );
  });

  test('reads the version from the header', async () => {
    // tracemonkey.pdf is `%PDF-1.4` with no catalog override.
    expect((await load('tracemonkey.pdf')).pdfVersion).toBe('1.4');
  });

  test('the catalog version wins over the header', async () => {
    // basicapi.pdf has a `%PDF-1.6` header and `/Version /1.7` in its catalog, which
    // is how a file saved by a later tool reports what it was last written as rather
    // than what it was created as. Reading the header alone would say 1.6.
    expect((await load('basicapi.pdf')).pdfVersion).toBe('1.7');
  });

  test('a field the document never wrote is null, not an empty string', async () => {
    const doc = await load('tracemonkey.pdf');
    expect(doc.metadata.title).toBeNull();
    expect(doc.metadata.creator).toBe('TeX');
  });

  test('reads page labels when the document defines them', async () => {
    const doc = await load('TAMReview.pdf');
    const labels = await doc.pageLabels();
    expect(labels).toHaveLength(doc.pageCount);
    expect(labels.slice(0, 3)).toEqual(['1', '2', '3']);
  });

  test('a document with no page labels resolves to an empty array', async () => {
    // Empty rather than a synthesised 1..n, so a caller can tell the document said
    // nothing and fall back to the index itself.
    expect(await (await load('tracemonkey.pdf')).pageLabels()).toEqual([]);
  });

  test('reads internal links with their destinations', async () => {
    const doc = await load('basicapi.pdf');
    const links = await doc.links(0);
    expect(links.length).toBeGreaterThan(0);

    const internal = links.filter((l) => l.target.kind === 'internal');
    expect(internal.length).toBeGreaterThan(0);
    for (const link of internal) {
      if (link.target.kind !== 'internal') continue;
      expect(link.target.dest.page).toBeLessThan(doc.pageCount);
    }
  });

  test('reads a uri link', async () => {
    const doc = await load('basicapi.pdf');
    const uris = (await doc.links(2)).flatMap((l) =>
      l.target.kind === 'uri' ? [l.target.uri] : [],
    );
    expect(uris).toContain('http://www.tcpdf.org');
  });

  test('link rects land on the text they belong to', async () => {
    // The whole point of mapping through the render transform. A link over a table
    // of contents entry has to overlap that entry's own glyphs, in one shared space.
    const doc = await load('basicapi.pdf');
    const [links, text] = [await doc.links(0), await doc.pageText(0)];
    const link = links.find((l) => l.target.kind === 'internal');
    expect(link).toBeDefined();
    if (!link) return;

    const { rect } = link;
    const overlapping = text.lines.filter((line) => {
      const bounds = quadBounds(lineQuad(line, 0, line.text.length));
      return (
        bounds.x < rect.x + rect.width &&
        bounds.x + bounds.width > rect.x &&
        bounds.y < rect.y + rect.height &&
        bounds.y + bounds.height > rect.y
      );
    });
    expect(overlapping.length).toBeGreaterThan(0);
    expect(overlapping[0]?.text).toContain('Chapter 1');
  });

  test('a page with no links resolves to an empty array', async () => {
    expect(await (await load('tracemonkey.pdf')).links(1)).toEqual([]);
  });

  test('links are cached, so a second read is the same array', async () => {
    const doc = await load('basicapi.pdf');
    expect(await doc.links(0)).toBe(await doc.links(0));
  });

  test('two reads in flight at once share one task', async () => {
    const doc = await load('basicapi.pdf');
    const [a, b] = await Promise.all([doc.links(0), doc.links(0)]);
    expect(a).toBe(b);
  });

  test('the same bytes always fingerprint the same, different bytes do not', async () => {
    const [a, b, other] = await Promise.all([
      load('basicapi.pdf'),
      load('basicapi.pdf'),
      load('tracemonkey.pdf'),
    ]);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(other.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

describeWithCorpus('encrypted documents', () => {
  const encrypted = () => readFileSync(join(CORPUS, 'pr6531_1.pdf'));

  test('asks for a password when none was given', async () => {
    const failure = await open(encrypted()).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PasswordRequiredError);
    expect(failure).toBeInstanceOf(PasswordError);
    expect((failure as PasswordError).retry).toBe(false);
  });

  test('says the password was wrong when one was', async () => {
    // The distinction a viewer needs: the same dialog, opened cold or with an error.
    const failure = await open(encrypted(), { password: 'nope' }).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(IncorrectPasswordError);
    expect((failure as PasswordError).retry).toBe(true);
  });

  test('the message never leaks the tag the bindings travel through', async () => {
    const failure = (await open(encrypted()).catch(
      (e: unknown) => e,
    )) as PasswordError;
    expect(failure.message).not.toContain('papyra/');
  });

  test('opens with the right password', async () => {
    const doc = await open(encrypted(), { password: 'asdfasdf' });
    expect(doc.pageCount).toBeGreaterThan(0);
  });
});
