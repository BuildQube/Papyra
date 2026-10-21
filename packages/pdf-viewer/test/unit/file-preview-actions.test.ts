import { describe, expect, test } from 'bun:test';
import {
  type FileActions,
  fileAction,
} from '@/components/file-preview-actions';
import { FileCache, resolveFile } from '@/lib/file-preview-source';

function fake(canShare: boolean, shared?: Error) {
  const calls: string[] = [];
  const actions: FileActions = {
    canShare: () => canShare,
    share: async (file) => {
      calls.push(`share ${file.name}`);
      if (shared) throw shared;
    },
    download: async () => {
      calls.push('download');
    },
  };
  return { actions, calls };
}

const remote = {
  key: 'r',
  url: async () => new Blob(['x'], { type: 'text/plain' }),
  name: 'r.txt',
};

describe('fileAction', () => {
  test('shares a file in hand when the platform takes it', async () => {
    const { actions, calls } = fake(true);
    const action = fileAction(
      actions,
      new File(['x'], 'a.txt'),
      new FileCache(),
    );
    expect(action.kind).toBe('share');
    await action.run();
    expect(calls).toEqual(['share a.txt']);
  });

  test('downloads a remote file not yet held, then shares it once it is', async () => {
    const { actions, calls } = fake(true);
    const cache = new FileCache();
    expect(fileAction(actions, remote, cache).kind).toBe('download');
    await resolveFile(remote, { cache });
    await fileAction(actions, remote, cache).run();
    expect(calls).toEqual(['share r.txt']);
  });

  test('downloads when the platform cannot share', async () => {
    const { actions, calls } = fake(false);
    await fileAction(actions, new File(['x'], 'a.txt'), new FileCache()).run();
    expect(calls).toEqual(['download']);
  });

  test('a cancelled share sheet is not an error; a failure is', async () => {
    const file = new File(['x'], 'a.txt');
    const cancel = new DOMException('cancelled', 'AbortError');
    await fileAction(fake(true, cancel).actions, file, new FileCache()).run();

    const denied = new DOMException('no activation', 'NotAllowedError');
    const failing = fileAction(
      fake(true, denied).actions,
      file,
      new FileCache(),
    );
    await expect(failing.run()).rejects.toBe(denied);
  });
});
