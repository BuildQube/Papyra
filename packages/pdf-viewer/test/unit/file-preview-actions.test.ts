import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fileAction } from '@/components/file-preview-actions';
import { FileCache, resolveFile } from '@/lib/file-preview-source';

let calls: string[] = [];
let shareError: Error | undefined;
const real = {
  canShare: globalThis.navigator.canShare,
  share: globalThis.navigator.share,
  document: globalThis.document,
};

beforeEach(() => {
  calls = [];
  shareError = undefined;
  globalThis.navigator.canShare = () => true;
  globalThis.navigator.share = async (data) => {
    calls.push(`share ${data?.files?.[0]?.name}`);
    if (shareError) throw shareError;
  };
  // downloadSource clicks an anchor; there is no DOM in the unit lane.
  globalThis.document = {
    createElement: () => ({ click: () => calls.push('download') }),
  } as unknown as Document;
});

afterEach(() => {
  globalThis.navigator.canShare = real.canShare;
  globalThis.navigator.share = real.share;
  globalThis.document = real.document;
});

const remote = {
  key: 'r',
  url: async () => new Blob(['x'], { type: 'text/plain' }),
  name: 'r.txt',
};
const file = () => new File(['x'], 'a.txt');

describe('fileAction', () => {
  test('downloads unless sharing is on, even where the platform could share', async () => {
    const action = fileAction(false, file(), new FileCache());
    expect(action.kind).toBe('download');
    await action.run();
    expect(calls).toEqual(['download']);
  });

  test('shares a file in hand when sharing is on', async () => {
    const action = fileAction(true, file(), new FileCache());
    expect(action.kind).toBe('share');
    await action.run();
    expect(calls).toEqual(['share a.txt']);
  });

  test('downloads when the platform cannot take the file', async () => {
    globalThis.navigator.canShare = () => false;
    await fileAction(true, file(), new FileCache()).run();
    expect(calls).toEqual(['download']);
  });

  test('decides again at the tap: a file that arrived since render is shared', async () => {
    const cache = new FileCache();
    const action = fileAction(true, remote, cache);
    expect(action.kind).toBe('download');
    await resolveFile(remote, { cache });
    await action.run();
    expect(calls).toEqual(['share r.txt']);
  });

  test("shares the caller's copy of a file the cache does not hold", async () => {
    const big = new File(['x'], 'big.pdf');
    await fileAction(true, remote, new FileCache(), big).run();
    expect(calls).toEqual(['share big.pdf']);
  });

  test('a cancelled share sheet is the end of it', async () => {
    shareError = new DOMException('cancelled', 'AbortError');
    await fileAction(true, file(), new FileCache()).run();
    expect(calls).toEqual(['share a.txt']);
  });

  test('a share that fails downloads instead', async () => {
    shareError = new DOMException('no activation', 'NotAllowedError');
    await fileAction(true, file(), new FileCache()).run();
    expect(calls).toEqual(['share a.txt', 'download']);
  });
});
