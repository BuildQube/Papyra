import {
  encodeBitmap,
  type ImageFormat as NativeFormat,
  type PageImage as NativePageImage,
} from '@build-qube/papyra-native';
import type { RenderedPage } from './types.js';

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
 * Encode a page you already hold — a cache hit, or one you have just painted.
 *
 * This copies the pixels back into Rust, because a `Uint8Array` points at the JS heap
 * and cannot be held across the worker-thread boundary. When you do not also need the
 * raw pixels, `doc.renderImage()` skips the round trip entirely.
 */
export async function encode(
  page: RenderedPage,
  options: EncodeOptions = {},
): Promise<EncodedImage> {
  const format = options.format ?? 'webp';
  const bytes = await encodeBitmap(
    page.data,
    page.width,
    page.height,
    page.stride,
    format as NativeFormat,
    options.quality,
    options.signal,
  );
  return encodedImage(bytes, format);
}

/**
 * A page held in Rust, encoded on demand.
 *
 * The pixels never cross into JS. A 42x30in drawing at 150 DPI is 6.5 MB raw and a
 * fraction of that encoded, so for export the raw buffer is pure overhead. There is no
 * accessor for it on purpose: use `renderPage` when you want pixels, this when you
 * want a file.
 */
export class PageImage {
  readonly #inner: NativePageImage;

  constructor(inner: NativePageImage) {
    this.#inner = inner;
  }

  get width(): number {
    return this.#inner.width;
  }

  get height(): number {
    return this.#inner.height;
  }

  /** Size of the *raw* bitmap still held in Rust. Encoded output is much smaller. */
  get byteLength(): number {
    return this.#inner.byteLength;
  }

  async encode(options: EncodeOptions = {}): Promise<EncodedImage> {
    const format = options.format ?? 'webp';
    const bytes = await this.#inner.encode(
      format as NativeFormat,
      options.quality,
      options.signal,
    );
    return encodedImage(bytes, format);
  }

  toWebp(options: Omit<EncodeOptions, 'format' | 'quality'> = {}) {
    return this.encode({ ...options, format: 'webp' });
  }

  toPng(options: Omit<EncodeOptions, 'format' | 'quality'> = {}) {
    return this.encode({ ...options, format: 'png' });
  }

  toJpeg(quality?: number, options: Omit<EncodeOptions, 'format'> = {}) {
    return this.encode({ ...options, format: 'jpeg', quality });
  }

  /**
   * Encode straight to a `data:` URL. Nothing but the finished string crosses the
   * boundary — not the pixels, not the encoded bytes.
   */
  toDataUrl(options: EncodeOptions = {}): Promise<string> {
    return this.#inner.toDataUrl(
      (options.format ?? 'webp') as NativeFormat,
      options.quality,
      options.signal,
    );
  }
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
