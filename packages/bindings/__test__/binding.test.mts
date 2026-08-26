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

import {
  backendName,
  encodeBitmap,
  encodeBitmapSync,
  PdfDocument,
  runtime,
} from '../index.js';

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

/** Leading bytes that identify each container, so we know the encoder really ran. */
const MAGIC = {
  webp: (b: Buffer) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
  png: (b: Buffer) =>
    b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  jpeg: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8,
} as const;

describe('encoding', () => {
  test('renderPageImageAsync keeps the pixels in Rust but reports its size', async () => {
    const doc = load('franz.pdf');
    const img = await doc.renderPageImageAsync(0, 72);

    assert.ok(img.width > 0 && img.height > 0);
    assert.equal(img.byteLength, img.width * img.height * 4);
    // The raw buffer is deliberately not reachable from JS.
    assert.equal((img as unknown as { data?: unknown }).data, undefined);
  });

  for (const format of ['webp', 'png', 'jpeg'] as const) {
    test(`encodes ${format} with the right magic bytes`, async () => {
      const doc = load('franz.pdf');
      const img = await doc.renderPageImageAsync(0, 72);
      const out = await img.encode(format, 80);

      assert.ok(out.length > 0);
      assert.ok(
        MAGIC[format](out),
        `not a ${format}: ${out.subarray(0, 8).toString('hex')}`,
      );
    });
  }

  test('the sync path produces the same bytes as the async one', async () => {
    const doc = load('franz.pdf');
    const img = await doc.renderPageImageAsync(0, 72);

    assert.deepEqual(await img.encode('png'), img.encodeSync('png'));
  });

  test('toDataUrl carries the format mime type', async () => {
    const doc = load('franz.pdf');
    const img = await doc.renderPageImageAsync(0, 72);

    assert.match(
      await img.toDataUrl('webp'),
      /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/,
    );
    assert.match(await img.toDataUrl('jpeg', 60), /^data:image\/jpeg;base64,/);
  });

  test('jpeg quality changes the output size', async () => {
    const doc = load('tracemonkey.pdf');
    const img = await doc.renderPageImageAsync(0, 150);

    const low = await img.encode('jpeg', 20);
    const high = await img.encode('jpeg', 95);
    assert.ok(
      low.length < high.length,
      `${low.length} should be under ${high.length}`,
    );
  });

  test('encodeBitmap accepts pixels that are already in JS', async () => {
    const doc = load('franz.pdf');
    const page = doc.renderPage(0, 72);

    const out = await encodeBitmap(
      page.data,
      page.width,
      page.height,
      page.stride,
      'webp',
    );
    assert.ok(MAGIC.webp(out));

    const sync = encodeBitmapSync(
      page.data,
      page.width,
      page.height,
      page.stride,
      'webp',
    );
    assert.deepEqual(out, sync);
  });

  test('both encode paths agree byte for byte', async () => {
    const doc = load('franz.pdf');
    const img = await doc.renderPageImageAsync(0, 72);
    const page = doc.renderPage(0, 72);

    const viaImage = await img.encode('png');
    const viaBuffer = await encodeBitmap(
      page.data,
      page.width,
      page.height,
      page.stride,
      'png',
    );
    assert.deepEqual(viaImage, viaBuffer);
  });

  test('rejects a buffer too small for its dimensions instead of crashing', async () => {
    await assert.rejects(
      () => encodeBitmap(new Uint8Array(16), 100, 100, 400, 'png'),
      /encode/i,
    );
  });
});
