import { describe, expect, test } from 'bun:test';
import {
  type Availability,
  type BackendRenderOptions,
  batchDpi,
  type PdfBackend,
  PdfEngine,
  RENDER_ONLY,
  stateOf,
} from '../../src/engine.js';
import { RenderTooLargeError } from '../../src/errors.js';
import type {
  OpenOptions,
  PageBitmap,
  PdfSource,
  Tile,
} from '../../src/types.js';

/** A page size and every render asked of it, so a test can count what reached it. */
class FakeBackend implements PdfBackend {
  readonly pageCount = 3;
  readonly fingerprint = 'fake';
  readonly capabilities = RENDER_ONLY;
  readonly renders: { index: number; options: BackendRenderOptions }[] = [];
  closed = false;
  /** Every render waits on this, so a test can keep the queue full. */
  hold: Promise<unknown> = Promise.resolve();

  /** Hold every render started from now on; returns the release. */
  gate(): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.hold = promise;
    return () => resolve();
  }

  pageSize() {
    return { width: 612, height: 792 };
  }

  async renderPage(index: number, options: BackendRenderOptions) {
    this.renders.push({ index, options });
    await this.hold;
    // ImageBitmap-shaped: no `data`, which is how the cache and painter tell.
    const scale = options.dpi / 72;
    return {
      width: Math.floor(612 * scale),
      height: Math.floor(792 * scale),
    } as unknown as PageBitmap;
  }

  metadata() {
    return {
      title: null,
      author: null,
      subject: null,
      keywords: null,
      creator: null,
      producer: null,
      created: null,
      modified: null,
    };
  }

  pdfVersion() {
    return '1.7';
  }

  close() {
    this.closed = true;
  }
}

class FakeEngine extends PdfEngine<FakeBackend> {
  readonly id = 'fake';
  backend = new FakeBackend();

  constructor(readonly Backend: new () => FakeBackend = FakeBackend) {
    super();
  }

  availability(): Availability {
    return { ok: true };
  }

  protected async load(_: PdfSource, __: OpenOptions) {
    this.backend = new this.Backend();
    return this.backend;
  }
}

/** The four document-wide reads, failing the first time each is asked. */
const READS = ['outline', 'pageLabels', 'structTree', 'attachments'] as const;

class FlakyBackend extends FakeBackend {
  readonly calls: Record<string, number> = {};

  #read(name: string): Promise<never[]> {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    return this.calls[name] === 1
      ? Promise.reject(new Error(`${name} failed`))
      : Promise.resolve([]);
  }
  outline = () => this.#read('outline');
  pageLabels = () => this.#read('pageLabels');
  structTree = () => this.#read('structTree');
  attachments = () => this.#read('attachments');
}

/** Renders tiles too, one at a time, recording each. */
class TiledBackend extends FakeBackend {
  readonly tileConcurrency = 1;
  readonly tiles: { index: number; tile: Tile; dpi: number }[] = [];

  async renderTile(index: number, tile: Tile, options: BackendRenderOptions) {
    this.tiles.push({ index, tile, dpi: options.dpi });
    await this.hold;
    return { width: tile.width, height: tile.height } as unknown as PageBitmap;
  }
}

const TILE: Tile = { x: 1024, y: 2048, width: 1024, height: 512 };

const BYTES = new Uint8Array();

describe('PdfEngine over another backend', () => {
  test('resolves fitWidth to a DPI before the backend sees it', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    const page = await engine.render(doc, 0, { fitWidth: 1224 }).promise;
    expect(engine.backend.renders[0]?.options.dpi).toBe(144);
    expect(page.width).toBe(1224);
  });

  test('coalesces, then serves the cache, for any bitmap type', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    const a = engine.render(doc, 1, { fitWidth: 600 });
    const b = engine.render(doc, 1, { fitWidth: 600 });
    await Promise.all([a.promise, b.promise]);
    expect(engine.backend.renders).toHaveLength(1);

    const c = engine.render(doc, 1, { fitWidth: 600 });
    expect(c.cached).toBe(true);
    // Sized by width * height * 4 when there is no `data` to measure.
    expect(engine.cacheStats(doc).bytes).toBeGreaterThan(0);
  });

  test('keeps the annotation switch in the key', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    await engine.render(doc, 0).promise;
    await engine.render(doc, 0, { annotations: false }).promise;
    expect(engine.backend.renders.map((r) => r.options.annotations)).toEqual([
      undefined,
      false,
    ]);
  });

  test('refuses a render past the pixel guard', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    expect(() => engine.render(doc, 0, { dpi: 2000 })).toThrow(
      RenderTooLargeError,
    );
  });

  test('refuses a batch whose bitmaps together are over its budget', () => {
    const backend = new FakeBackend();
    // A 612x792pt page at 150 DPI is 1275x1650, 8.4 MB; three of them 25.2 MB.
    expect(batchDpi(backend, 0, 3, { dpi: 150 }, 26e6)).toBe(150);
    expect(() => batchDpi(backend, 0, 3, { dpi: 150 }, 25e6)).toThrow(
      RenderTooLargeError,
    );
    expect(() => batchDpi(backend, 0, 3, { fitWidth: 1275 }, 25e6)).toThrow(
      /pages 0-2 are 25 MB/,
    );
  });

  test('a missing capability reads as empty, not as an error', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    expect(doc.capabilities.text).toBe(false);
    expect(await engine.outline(doc)).toEqual([]);
    expect(await engine.links(doc, 0)).toEqual([]);
    expect((await engine.pageText(doc, 0)).lines).toEqual([]);
    const hits = [];
    for await (const hit of engine.search(doc, 'anything')) hits.push(hit);
    expect(hits).toEqual([]);
    expect(await engine.pageLabels(doc)).toEqual([]);
    expect(await engine.structTree(doc)).toEqual([]);
    expect(await engine.attachments(doc)).toEqual([]);
    // Except fetching bytes: there is no empty answer to "give me attachment 0".
    await expect(engine.attachmentData(doc, 0)).rejects.toThrow(
      'fake reads no attachments',
    );
  });

  for (const read of READS) {
    test(`a failed ${read} is retried, and a successful one memoised`, async () => {
      const engine = new FakeEngine(FlakyBackend);
      const doc = await engine.open(BYTES);
      const backend = engine.backend as FlakyBackend;
      await expect(engine[read](doc)).rejects.toThrow(`${read} failed`);
      expect(await engine[read](doc)).toEqual([]);
      expect(await engine[read](doc)).toEqual([]);
      expect(backend.calls[read]).toBe(2);
    });
  }

  test('a render handle reports its timing once it has run', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    const release = engine.backend.gate();
    const handle = engine.render(doc, 0);
    expect(handle.timing).toBeNull();
    release();
    await handle.promise;
    expect(handle.timing?.runMs).toBeGreaterThanOrEqual(0);
  });

  test('an aborted signal drops a render that has not started', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES, { concurrency: 1 });
    const release = engine.backend.gate();
    const running = engine.render(doc, 0);

    const later = new AbortController();
    const dropped = engine.render(doc, 1, { signal: AbortSignal.abort() });
    const aborted = engine.render(doc, 2, { signal: later.signal });
    later.abort();

    release();
    await running.promise;
    await expect(dropped.promise).rejects.toThrow('signal aborted');
    await expect(aborted.promise).rejects.toThrow('signal aborted');
    expect(engine.backend.renders.map((r) => r.index)).toEqual([0]);
  });

  test('breaking out of a stream drops the renders still queued', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES, { concurrency: 1 });
    // A window of three on a queue of one: page 0 runs, 1 and 2 wait.
    const first = engine.backend.gate();
    const it = engine.stream(doc, { concurrency: 3 });
    const yielded = it.next();
    // Page 1 starts as 0 finishes, and is held there while the loop breaks.
    const second = engine.backend.gate();
    first();
    expect((await yielded).value?.page).toBe(0);
    await it.return(undefined);
    second();
    await Bun.sleep(0);
    expect(engine.backend.renders.map((r) => r.index)).toEqual([0, 1]);
  });

  test('a handle belongs to the engine that opened it', async () => {
    const doc = await new FakeEngine().open(BYTES);
    expect(() => new FakeEngine().render(doc, 0)).toThrow(/another engine/);
  });

  test('close releases the backend, and the handle with it', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    await engine.render(doc, 0).promise;
    await engine.close(doc);
    expect(engine.backend.closed).toBe(true);
    expect(() => engine.render(doc, 0)).toThrow(/closed/);
    // A second close is a mistake in the caller, reported at once.
    expect(() => engine.close(doc)).toThrow(/closed/);
  });

  test('a render that finishes after close is not cached', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    const { cache } = stateOf(engine, doc);
    const release = engine.backend.gate();
    const job = engine.render(doc, 0);
    await engine.close(doc);
    release();
    await job.promise;
    expect(cache.stats.entries).toBe(0);
  });

  test('a backend that throws on close rejects, rather than throwing', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    engine.backend.close = () => {
      throw new Error('host gone');
    };
    const closing = engine.close(doc);
    await expect(closing).rejects.toThrow('host gone');
    // Released on our side regardless.
    expect(() => engine.render(doc, 0)).toThrow(/closed/);
  });

  test('streams every page, in the order asked', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    const pages = [];
    for await (const { page } of engine.stream(doc, { order: [2, 0] })) {
      pages.push(page);
    }
    expect(pages.sort()).toEqual([0, 2]);
  });

  test('closing a document ends its stream rather than throwing', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    const pages = [];
    for await (const { page } of engine.stream(doc, { concurrency: 1 })) {
      pages.push(page);
      // Page 1 was already scheduled when page 0 arrived; page 2 never is.
      if (page === 0) engine.close(doc);
    }
    expect(pages).toEqual([0, 1]);
  });

  test('a tile past the page cap renders, keyed by its window', async () => {
    const engine = new FakeEngine(TiledBackend);
    const doc = await engine.open(BYTES);
    const backend = engine.backend as TiledBackend;
    // 2000 DPI is refused for the whole page; a tile of it is not.
    const tile = await engine.renderTile(doc, 0, TILE, { dpi: 2000 }).promise;
    expect(tile.width).toBe(1024);
    expect(backend.tiles).toEqual([{ index: 0, tile: TILE, dpi: 2000 }]);
    // Cached, but not among the pages a screenful of tiles would evict.
    expect(engine.cacheStats(doc).entries).toBe(0);

    expect(engine.renderTile(doc, 0, TILE, { dpi: 2000 }).cached).toBe(true);
    for (const other of [
      { ...TILE, x: 0 },
      { ...TILE, y: 0 },
      { ...TILE, width: 512 },
      { ...TILE, height: 1024 },
    ]) {
      expect(engine.renderTile(doc, 0, other, { dpi: 2000 }).cached).toBe(
        false,
      );
    }
    expect(
      engine.renderTile(doc, 0, TILE, { dpi: 2000, annotations: false }).cached,
    ).toBe(false);
    expect(engine.renderTile(doc, 1, TILE, { dpi: 2000 }).cached).toBe(false);
    expect(engine.renderTile(doc, 0, TILE, { dpi: 1000 }).cached).toBe(false);
    // Nor is it the page's bitmap at that size.
    expect(engine.render(doc, 0, { dpi: 144 }).key).not.toContain('#');
  });

  test('a malformed tile is refused before it reaches the backend', async () => {
    const engine = new FakeEngine(TiledBackend);
    const doc = await engine.open(BYTES);
    for (const bad of [
      { ...TILE, width: 0 },
      { ...TILE, height: 65536 },
      { ...TILE, width: Number.NaN },
      { ...TILE, x: -1 },
      { ...TILE, y: 10.5 },
    ]) {
      expect(() => engine.renderTile(doc, 0, bad, { dpi: 600 })).toThrow(
        RangeError,
      );
    }
    expect((engine.backend as TiledBackend).tiles).toEqual([]);
    // The widest side the rasteriser takes is a tile; one more is too large.
    const edge = { x: 0, y: 0, width: 1, height: 65280 };
    await engine.renderTile(doc, 0, edge, { dpi: 600 }).promise;
    expect(() =>
      engine.renderTile(doc, 0, { ...edge, height: 65281 }, { dpi: 600 }),
    ).toThrow(RenderTooLargeError);
  });

  test('the pixel guard reads the tile, not the page', async () => {
    const engine = new FakeEngine(TiledBackend);
    const doc = await engine.open(BYTES);
    const huge = { x: 0, y: 0, width: 65535, height: 65535 };
    expect(() => engine.renderTile(doc, 0, huge, { dpi: 72 })).toThrow(
      'a 65535x65535 tile',
    );
  });

  test('tiles queue apart from pages, at the tile concurrency', async () => {
    const engine = new FakeEngine(TiledBackend);
    const doc = await engine.open(BYTES, { concurrency: 2 });
    const backend = engine.backend as TiledBackend;
    const release = backend.gate();
    const pages = [engine.render(doc, 0), engine.render(doc, 1)];
    const a = engine.renderTile(doc, 0, TILE, { dpi: 600 });
    const b = engine.renderTile(doc, 0, { ...TILE, x: 0 }, { dpi: 600 });
    // Both page slots are taken, yet a tile started; the second waits for it.
    expect(backend.renders).toHaveLength(2);
    expect(backend.tiles).toHaveLength(1);
    release();
    await Promise.all([...pages, a, b].map((job) => job.promise));
    expect(backend.tiles).toHaveLength(2);
  });

  test('a backend without tiles says so', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    expect(doc.capabilities.tiles).toBeUndefined();
    expect(() => engine.renderTile(doc, 0, TILE, { dpi: 600 })).toThrow(
      'fake renders no tiles',
    );
  });

  test('the handle carries the facts, read once', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES);
    expect(doc.engine).toBe('fake');
    expect(doc.pageCount).toBe(3);
    expect(doc.pageSize(0)).toEqual({ width: 612, height: 792 });
    expect(doc.metadata).toBe(doc.metadata);
    expect(doc.pdfVersion).toBe('1.7');
  });
});
