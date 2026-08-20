import type { PdfSource } from './types.js';

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

/**
 * Normalise any accepted input to bytes.
 *
 * Accepts `File` and `Blob` so an `<input type="file">` value can be passed straight
 * through, which is the common case in a viewer.
 */
export async function toBytes(source: PdfSource): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (isBlob(source)) return new Uint8Array(await source.arrayBuffer());
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  throw new TypeError(
    'papyra: expected a Uint8Array, ArrayBuffer, TypedArray, Blob, or File',
  );
}
