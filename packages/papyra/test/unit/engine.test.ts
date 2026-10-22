import { describe, expect, test } from 'bun:test';
import {
  type Availability,
  type BackendRenderOptions,
  type PdfBackend,
  PdfEngine,
  RENDER_ONLY,
} from '../../src/engine.js';
import type { OpenOptions, PageBitmap, PdfSource } from '../../src/types.js';

/** A page size and every render asked of it, so a test can count what reached it. */
class FakeBackend implements PdfBackend {
  readonly pageCount = 3;
  readonly fingerprint = 'fake';
  readonly capabilities = RENDER_ONLY;
  readonly renders: { index: number; options: BackendRenderOptions }[] = [];
  closed = false;
  /** Every render waits on this, so a test can keep the queue full. */
  hold: Promise<unknown> = Promise.resolve();

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
    expect(() => engine.render(doc, 0, { dpi: 2000 })).toThrow(RangeError);
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
    let release = () => {};
    engine.backend.hold = new Promise<void>((r) => {
      release = r;
    });
    const handle = engine.render(doc, 0);
    expect(handle.timing).toBeNull();
    release();
    await handle.promise;
    expect(handle.timing?.runMs).toBeGreaterThanOrEqual(0);
  });

  test('an aborted signal drops a render that has not started', async () => {
    const engine = new FakeEngine();
    const doc = await engine.open(BYTES, { concurrency: 1 });
    let release = () => {};
    engine.backend.hold = new Promise<void>((r) => {
      release = r;
    });
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
    const gate = () => {
      let release = () => {};
      engine.backend.hold = new Promise<void>((r) => {
        release = r;
      });
      return release;
    };
    // A window of three on a queue of one: page 0 runs, 1 and 2 wait.
    const first = gate();
    const it = engine.stream(doc, { concurrency: 3 });
    const yielded = it.next();
    // Page 1 starts as 0 finishes, and is held there while the loop breaks.
    const second = gate();
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
