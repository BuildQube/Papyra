/**
 * The parts of encoding that touch no native code.
 *
 * Split from `encode.ts` because CI's `unit-test` job runs with no Rust toolchain and
 * no build: anything `test/unit` imports must not pull in the addon, and `encode.ts`
 * imports `encodeBitmap` as a value. See CLAUDE.md.
 */
/**
 * Containers papyra can write. All three encoders are pure Rust — that is what keeps
 * the browser build free of a C toolchain — so there is no lossy WebP and no AVIF.
 *
 * - `webp` is lossless VP8L, and the default: on page content (line art, text, flat
 *   fills) it is ~3x smaller than PNG for roughly the same encode time.
 * - `png` is the universal fallback.
 * - `jpeg` is the only lossy option and the only one with a `quality` knob. It has no
 *   alpha channel; transparent pixels are composited onto white, matching how pages
 *   are rendered.
 */
export type EncodedFormat = 'webp' | 'png' | 'jpeg';

const MIME: Record<EncodedFormat, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpeg: 'image/jpeg',
};

/** MIME type for an encoded format, e.g. `'webp'` -> `'image/webp'`. */
export function mimeType(format: EncodedFormat): string {
  return MIME[format];
}

export interface EncodeOptions {
  /** Defaults to `'webp'`. */
  format?: EncodedFormat;
  /** JPEG only, 1-100. Defaults to 80. Ignored by the lossless formats. */
  quality?: number;
  /** Abort a request that has not started yet. */
  signal?: AbortSignal;
}

/** Encoded bytes, plus the three ways you are likely to want to hand them to a browser. */
export interface EncodedImage {
  readonly bytes: Uint8Array;
  readonly format: EncodedFormat;
  readonly mime: string;
  /** Wrap as a `Blob`, ready for `URL.createObjectURL` or an upload. */
  toBlob(): Blob;
  /**
   * An object URL for `<img src>`. Prefer this over {@link toDataUrl} in a browser:
   * no base64 inflation, no multi-megabyte string on the heap, and the decoder reads
   * straight from the blob.
   *
   * The caller owns the URL — `URL.revokeObjectURL` it when the image is gone.
   */
  toBlobUrl(): string;
  /**
   * A `data:` URL. For an `<img src>` this is the worse option; reach for it when the
   * bytes must be embedded — CSS, serialised output, server-rendered HTML.
   */
  toDataUrl(): string;
}

export function encodedImage(
  bytes: Uint8Array,
  format: EncodedFormat,
): EncodedImage {
  const mime = MIME[format];
  return {
    bytes,
    format,
    mime,
    toBlob: () => new Blob([detach(bytes)], { type: mime }),
    toBlobUrl() {
      return URL.createObjectURL(this.toBlob());
    },
    toDataUrl: () => `data:${mime};base64,${base64(bytes)}`,
  };
}

/**
 * Copy into a buffer `Blob` will accept.
 *
 * On the wasm build these bytes live in the module's shared linear memory, and
 * `SharedArrayBuffer`-backed views are not valid `BlobPart`s. Copying unconditionally
 * keeps both runtimes on one path; encoded output is small enough that it does not
 * matter, which is exactly why `toImageData` cannot do the same trick cheaply.
 */
function detach(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function base64(bytes: Uint8Array): string {
  const buf = (
    globalThis as {
      Buffer?: { from(b: Uint8Array): { toString(enc: string): string } };
    }
  ).Buffer;
  // Node's native base64 beats anything expressible in JS by a wide margin.
  if (buf) return buf.from(bytes).toString('base64');

  // btoa wants a binary string, and spreading into fromCharCode overflows the stack
  // somewhere north of 100k arguments. Chunk it.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
