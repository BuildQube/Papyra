import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  FileCache,
  inspectSource,
  type RemoteFile,
  resolveFile,
  resolveUrl,
  SourceError,
  sourceInfo,
  sourceKey,
} from '@/lib/file-preview-source';

const PDF = new TextEncoder().encode(`%PDF-1.7\n${'x'.repeat(2000)}`);

interface Call {
  url: string;
  range: string | null;
}

let calls: Call[] = [];
let route: (url: string, init?: RequestInit) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  route = () =>
    new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, range: new Headers(init?.headers).get('range') });
    return route(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const file = (bytes: number, name = 'f.bin') =>
  new File([new Uint8Array(bytes)], name);

describe('FileCache', () => {
  test('evicts the least recently used once over budget', () => {
    const cache = new FileCache({ maxBytes: 100 });
    cache.set('a', file(40));
    cache.set('b', file(40));
    cache.get('a'); // `b` is now the oldest
    cache.set('c', file(40));
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.bytes).toBe(80);
  });

  test('does not hold a file larger than the whole budget', () => {
    const cache = new FileCache({ maxBytes: 100 });
    cache.set('small', file(10));
    cache.set('huge', file(500));
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('small')).toBeDefined();
  });

  test('joins a download in flight instead of starting another', async () => {
    const cache = new FileCache();
    let runs = 0;
    const fetcher = async () => {
      runs++;
      return file(1);
    };
    const [a, b] = await Promise.all([
      cache.load('k', fetcher),
      cache.load('k', fetcher),
    ]);
    expect(runs).toBe(1);
    expect(a).toBe(b);
  });

  test('cancels only when every caller has given up', async () => {
    const cache = new FileCache();
    let seen: AbortSignal | undefined;
    const fetcher = (signal: AbortSignal) => {
      seen = signal;
      return new Promise<File>(() => {});
    };
    const one = new AbortController();
    const two = new AbortController();
    void cache.load('k', fetcher, one.signal);
    void cache.load('k', fetcher, two.signal);
    one.abort();
    expect(seen?.aborted).toBe(false);
    two.abort();
    expect(seen?.aborted).toBe(true);
  });

  test('a caller after a cancellation starts afresh rather than joining it', async () => {
    const cache = new FileCache();
    let runs = 0;
    const fetcher = (signal: AbortSignal) => {
      runs++;
      return new Promise<File>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
        setTimeout(() => resolve(file(1)), 5);
      });
    };
    const gone = new AbortController();
    const first = cache.load('k', fetcher, gone.signal);
    gone.abort();
    const second = cache.load('k', fetcher);
    await expect(first).rejects.toBeDefined();
    expect(await second).toBeInstanceOf(File);
    expect(runs).toBe(2);
  });
});

describe('sourceKey and sourceInfo', () => {
  test('a Blob is keyed by identity', () => {
    const a = file(1);
    expect(sourceKey(a)).toBe(sourceKey(a));
    expect(sourceKey(a)).not.toBe(sourceKey(file(1)));
  });

  test('a remote file is keyed by its key, whatever its resolver', () => {
    const one: RemoteFile = { key: 'doc-7', url: async () => 'https://x/1' };
    const two: RemoteFile = { key: 'doc-7', url: async () => 'https://x/2' };
    expect(sourceKey(one)).toBe(sourceKey(two));
  });

  test('a URL names the file by its decoded last segment', () => {
    expect(sourceInfo('https://cdn.test/a/report%20q3.pdf?sig=abc').name).toBe(
      'report q3.pdf',
    );
  });

  test('a resolver with no name falls back to its key', () => {
    expect(sourceInfo({ key: 'invoice-12', url: async () => '' }).name).toBe(
      'invoice-12',
    );
  });
});

describe('resolveFile', () => {
  test('downloads a URL once, then serves it from the cache', async () => {
    const cache = new FileCache();
    const url = 'https://cdn.test/doc.pdf';
    const a = await resolveFile(url, { cache });
    const b = await resolveFile(url, { cache });
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(a.type).toBe('application/pdf');
  });

  test('takes the name from Content-Disposition', async () => {
    route = () =>
      new Response(PDF, {
        headers: {
          'content-disposition': `attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`,
        },
      });
    const f = await resolveFile('https://cdn.test/download?id=4', {
      cache: new FileCache(),
    });
    expect(f.name).toBe('résumé.pdf');
  });

  test('calls a resolver only when needed, and only once', async () => {
    const cache = new FileCache();
    let minted = 0;
    const source: RemoteFile = {
      key: 'signed',
      name: 'q3.pdf',
      url: async () => `https://cdn.test/q3.pdf?sig=${++minted}`,
    };
    await resolveFile(source, { cache });
    await resolveFile(source, { cache });
    expect(minted).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test('asks the resolver again when the first link is refused', async () => {
    let minted = 0;
    route = (url) =>
      url.endsWith('sig=1')
        ? new Response('expired', { status: 403 })
        : new Response(PDF);
    const f = await resolveFile(
      {
        key: 'k',
        name: 'a.pdf',
        url: async () => `https://cdn.test/a.pdf?sig=${++minted}`,
      },
      { cache: new FileCache() },
    );
    expect(minted).toBe(2);
    expect(f.size).toBe(PDF.length);
  });

  test('gives up after one retry, as a denied SourceError', async () => {
    route = () => new Response('no', { status: 403 });
    let minted = 0;
    const done = resolveFile(
      { key: 'k', url: async () => `https://cdn.test/x?${++minted}` },
      { cache: new FileCache() },
    );
    await expect(done).rejects.toBeInstanceOf(SourceError);
    await expect(done).rejects.toMatchObject({ kind: 'denied', status: 403 });
    expect(minted).toBe(2);
  });

  test('does not retry a plain URL', async () => {
    route = () => new Response('no', { status: 403 });
    await expect(
      resolveFile('https://cdn.test/x.pdf', { cache: new FileCache() }),
    ).rejects.toMatchObject({ kind: 'denied' });
    expect(calls).toHaveLength(1);
  });

  test('reports an unreachable server as a network SourceError', async () => {
    route = () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(
      resolveFile('https://elsewhere.test/x.pdf', { cache: new FileCache() }),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  test('a resolver may hand over the content itself', async () => {
    const f = await resolveFile(
      {
        key: 'sdk',
        name: 'from-sdk.pdf',
        url: async () => new Blob([PDF], { type: 'application/pdf' }),
      },
      { cache: new FileCache() },
    );
    expect(calls).toHaveLength(0);
    expect(f.name).toBe('from-sdk.pdf');
    expect(f.type).toBe('application/pdf');
  });

  test('a File is returned as it is', async () => {
    const f = file(3, 'a.txt');
    expect(await resolveFile(f)).toBe(f);
  });
});

describe('inspectSource', () => {
  test('without probing, the download is the inspection', async () => {
    const cache = new FileCache();
    const url = 'https://cdn.test/doc.pdf';
    const seen = await inspectSource(url, { cache });
    await resolveFile(url, { cache });
    expect(seen.head.length).toBe(512);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.range).toBeNull();
  });

  test('probing asks for the head only, and learns the size from Content-Range', async () => {
    route = () =>
      new Response(PDF.slice(0, 512), {
        status: 206,
        headers: { 'content-range': `bytes 0-511/${PDF.length}` },
      });
    const seen = await inspectSource('https://cdn.test/movie', {
      cache: new FileCache(),
      probe: true,
    });
    expect(calls[0]?.range).toBe('bytes=0-511');
    expect(seen.size).toBe(PDF.length);
    expect(seen.head.length).toBe(512);
  });

  test('probing a server that ignores Range still reads only the head', async () => {
    const seen = await inspectSource('https://cdn.test/doc.pdf', {
      cache: new FileCache(),
      probe: true,
    });
    expect(seen.head.length).toBe(512);
    expect(seen.type).toBe('application/pdf');
  });

  test('asks once per key', async () => {
    const cache = new FileCache();
    await inspectSource('https://cdn.test/a', { cache, probe: true });
    await inspectSource('https://cdn.test/a', { cache, probe: true });
    expect(calls).toHaveLength(1);
  });
});

describe('minted URLs', () => {
  test('inspecting and then downloading costs one signature', async () => {
    const cache = new FileCache();
    let minted = 0;
    const source: RemoteFile = {
      key: 'q',
      name: 'q.pdf',
      url: async () => `https://cdn.test/q.pdf?sig=${++minted}`,
    };
    await inspectSource(source, { cache, probe: true });
    await resolveFile(source, { cache });
    expect(minted).toBe(1);
    expect(calls.map((c) => c.range)).toEqual(['bytes=0-511', null]);
  });

  test('a remembered URL that has since expired is replaced', async () => {
    const cache = new FileCache();
    let minted = 0;
    const source: RemoteFile = {
      key: 'q',
      url: async () => `https://cdn.test/q.pdf?sig=${++minted}`,
    };
    await inspectSource(source, { cache, probe: true });
    route = (url) =>
      url.endsWith('sig=1')
        ? new Response('expired', { status: 403 })
        : new Response(PDF);
    const f = await resolveFile(source, { cache });
    expect(minted).toBe(2);
    expect(f.size).toBe(PDF.length);
  });

  test("a stream reuses the inspection's URL, and fresh mints another", async () => {
    const cache = new FileCache();
    let minted = 0;
    const source: RemoteFile = {
      key: 'v',
      url: async () => `https://cdn.test/v.webm?sig=${++minted}`,
    };
    await inspectSource(source, { cache, probe: true });
    expect((await resolveUrl(source, { cache })).url).toEndWith('sig=1');
    expect((await resolveUrl(source, { cache, fresh: true })).url).toEndWith(
      'sig=2',
    );
  });
});

describe('resolveUrl', () => {
  test('a plain URL is used as it is', async () => {
    const { url } = await resolveUrl('https://cdn.test/v.mp4', {
      cache: new FileCache(),
    });
    expect(url).toBe('https://cdn.test/v.mp4');
    expect(calls).toHaveLength(0);
  });

  test('fresh asks the resolver again, for a link that expired mid-stream', async () => {
    let minted = 0;
    const source: RemoteFile = {
      key: 'v',
      url: async () => `https://cdn.test/v.mp4?sig=${++minted}`,
    };
    const cache = new FileCache();
    const first = await resolveUrl(source, { cache });
    const again = await resolveUrl(source, { cache, fresh: true });
    expect(first.url).toEndWith('sig=1');
    expect(again.url).toEndWith('sig=2');
  });
});
