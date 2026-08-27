import {
  encodeBitmap,
  type ImageFormat as NativeFormat,
  type PageImage as NativePageImage,
} from '@build-qube/papyra-native';
import {
  type EncodedImage,
  type EncodeOptions,
  encodedImage,
} from './encoded.js';
import type { RenderedPage } from './types.js';

export type { EncodedFormat, EncodedImage, EncodeOptions } from './encoded.js';
export { encodedImage, mimeType } from './encoded.js';

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

  /** Output width in pixels. */
  get width(): number {
    return this.#inner.width;
  }

  /** Output height in pixels. */
  get height(): number {
    return this.#inner.height;
  }

  /** Size of the *raw* bitmap still held in Rust. Encoded output is much smaller. */
  get byteLength(): number {
    return this.#inner.byteLength;
  }

  /** Encode to {@link EncodeOptions.format}, defaulting to WebP. */
  async encode(options: EncodeOptions = {}): Promise<EncodedImage> {
    const format = options.format ?? 'webp';
    const bytes = await this.#inner.encode(
      format as NativeFormat,
      options.quality,
      options.signal,
    );
    return encodedImage(bytes, format);
  }

  /** Lossless VP8L. The default, and ~3x smaller than PNG on page content. */
  toWebp(options: Omit<EncodeOptions, 'format' | 'quality'> = {}) {
    return this.encode({ ...options, format: 'webp' });
  }

  /** Lossless PNG. Reach for it when the consumer cannot be trusted to read WebP. */
  toPng(options: Omit<EncodeOptions, 'format' | 'quality'> = {}) {
    return this.encode({ ...options, format: 'png' });
  }

  /**
   * Lossy JPEG at `quality` (1-100, default 80).
   *
   * No alpha: transparent pixels composite onto white, matching how pages render.
   */
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
