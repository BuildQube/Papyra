/**
 * Exercises the compiled binding directly — no wrapper, no build step.
 *
 * CI runs this once per target, against the artifact downloaded for that target,
 * with the same command every time. Only the environment differs: the WASI job
 * sets NAPI_RS_FORCE_WASI, and PAPYRA_EXPECT_RUNTIME asserts which flavour the
 * generated loader actually picked.
 *
 * Written against `node:test`, which both Node and Bun run, because the WASI
 * flavour only works under Node — Bun's `node:wasi` has no `initialize()`, so the
 * emnapi reactor module cannot start there.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { backendName, PdfDocument, runtime } from '../index.js';

const corpus = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../corpus/${name}`, import.meta.url)),
  );

const load = (name: string) => PdfDocument.load(corpus(name));

describe('compiled binding', () => {
  before(() => {
    console.log(`runtime: ${runtime()}  backend: ${backendName()}`);
  });

  test('loaded the flavour this job is meant to exercise', () => {
    const expected = process.env.PAPYRA_EXPECT_RUNTIME;
    if (!expected) return;
    assert.equal(
      runtime(),
      expected,
      `expected the ${expected} runtime, got ${runtime()} — the loader fell back ` +
        'instead of using the artifact under test',
    );
  });

  test('reports a backend', () => {
    assert.equal(backendName(), 'hayro');
  });

  test('loads a document and reads its geometry', () => {
    const doc = load('TAMReview.pdf');
    assert.equal(doc.pageCount, 23);
    assert.deepEqual(doc.pageSize(0), { width: 595, height: 842 });
  });

  test('renders a page synchronously', () => {
    const page = load('TAMReview.pdf').renderPage(0, 96);
    assert.equal(page.format, 'rgba8');
    assert.equal(page.width, 793);
    assert.equal(page.height, 1122);
    assert.equal(page.stride, page.width * 4);
    assert.equal(page.data.length, page.stride * page.height);
    // A blank render is the classic silent failure: the call succeeds, the bitmap
    // is the right shape, and every pixel is white.
    assert.ok(
      page.data.some((byte, i) => i % 4 !== 3 && byte !== 0xff),
      'page rendered fully white — nothing was painted',
    );
  });

  test('renders a page off-thread', async () => {
    const doc = load('TAMReview.pdf');
    const [sync, async] = [
      doc.renderPage(1, 96),
      await doc.renderPageAsync(1, 96),
    ];
    assert.deepEqual(
      { w: async.width, h: async.height },
      { w: sync.width, h: sync.height },
    );
    assert.deepEqual(
      async.data,
      sync.data,
      'async render differs from sync render',
    );
  });

  // The rayon path, which is where wasm differs most from native: the pool has to
  // be built explicitly there or it silently collapses to one thread.
  test('renders a page range in parallel', async () => {
    const doc = load('TAMReview.pdf');
    const pages = await doc.renderPagesAsync(0, 4, 96);
    assert.equal(pages.length, 4);
    for (const page of pages) {
      assert.equal(page.width, 793);
      assert.ok(page.data.some((byte, i) => i % 4 !== 3 && byte !== 0xff));
    }
  });

  test('scales with dpi', () => {
    const doc = load('tracemonkey.pdf');
    const low = doc.renderPage(0, 48);
    const high = doc.renderPage(0, 96);
    assert.ok(high.width > low.width && high.height > low.height);
  });

  test('reports varied page sizes', () => {
    const doc = load('sizes.pdf');
    assert.ok(doc.pageCount > 1);
    const seen = new Set(
      Array.from({ length: doc.pageCount }, (_, i) => {
        const { width, height } = doc.pageSize(i);
        return `${width}x${height}`;
      }),
    );
    assert.ok(seen.size > 1);
  });

  test('rejects an encrypted document with no password', () => {
    assert.throws(() => load('pr6531_1.pdf'), /password/i);
  });

  test('opens an encrypted document with its password', () => {
    const doc = PdfDocument.loadWithPassword(
      corpus('pr6531_1.pdf'),
      'asdfasdf',
    );
    assert.ok(doc.pageCount > 0);
  });
});
