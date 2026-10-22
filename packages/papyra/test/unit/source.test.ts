import { describe, expect, test } from 'bun:test';
import { toBytes } from '../../src/source.js';

describe('toBytes', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  test('passes a Uint8Array through without copying', async () => {
    expect(await toBytes(bytes)).toBe(bytes);
  });

  test('views an ArrayBuffer whole', async () => {
    expect(await toBytes(bytes.buffer)).toEqual(bytes);
  });

  test('reads a Blob', async () => {
    expect(await toBytes(new Blob([bytes]))).toEqual(bytes);
  });

  test('keeps a typed array’s own window of its buffer', async () => {
    // A view that starts and ends inside a larger buffer, as a subarray does.
    const view = new DataView(bytes.buffer, 2, 3);
    const out = await toBytes(view);
    expect(out).toEqual(new Uint8Array([3, 4, 5]));
    expect(out.buffer).toBe(bytes.buffer);
  });

  test('refuses anything else', async () => {
    await expect(toBytes('a.pdf' as never)).rejects.toThrow(TypeError);
  });
});
