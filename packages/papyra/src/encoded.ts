/**
 * The parts of encoding that touch no native code.
 *
 * Split from `encode.ts` because CI's `unit-test` job runs with no Rust toolchain and
 * no build: anything `test/unit` imports must not pull in the addon, and `encode.ts`
 * imports `encodeBitmap` as a value. See CLAUDE.md.
 */
/**
 * Containers papyra can rasterise a page into. All three encoders are pure Rust — that
 * is what keeps the browser build free of a C toolchain — so there is no lossy WebP and
 * no AVIF.
 *
 * - `webp` is lossless VP8L, and the default: on page content (line art, text, flat
 *   fills) it is ~3x smaller than PNG for roughly the same encode time.
 * - `png` is the universal fallback.
 * - `jpeg` is the only lossy option and the only one with a `quality` knob. It has no
 *   alpha channel; transparent pixels are composited onto white, matching how pages
 *   are rendered.
 */
export type RasterFormat = 'webp' | 'png' | 'jpeg';

/**
 * Every container papyra can write, {@link RasterFormat} plus `svg`.
 *
 * `svg` is separate from the others everywhere it matters: it comes off
 * `Document.renderSvg`, not off pixels, so it takes no DPI and no quality — which is
 * why {@link EncodeOptions.format} accepts only a {@link RasterFormat}.
 */
export type EncodedFormat = RasterFormat | 'svg';

const MIME: Record<EncodedFormat, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
};

/** MIME type for an encoded format, e.g. `'webp'` -> `'image/webp'`. */
export function mimeType(format: EncodedFormat): string {
  return MIME[format];
}

/** Which container to write, and how hard to squeeze. */
export interface EncodeOptions {
  /**
   * Defaults to `'webp'`. Rasters only — SVG is not an encoding of a bitmap, so it
   * comes from `Document.renderSvg` instead.
   */
  format?: RasterFormat;
  /** JPEG only, 1-100. Defaults to 80. Ignored by the lossless formats. */
  quality?: number;
  /** Abort a request that has not started yet. */
  signal?: AbortSignal;
}

/** Encoded bytes, plus the three ways you are likely to want to hand them to a browser. */
export interface EncodedImage {
  /** The encoded file, ready to write to disk or upload. */
  readonly bytes: Uint8Array;
  /** The container {@link bytes} is written in. */
  readonly format: EncodedFormat;
  /** MIME type for {@link format}, so a caller never has to map it back. */
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

/**
 * One page as SVG. An {@link EncodedImage} whose markup is also readable as a string,
 * because the usual thing to do with an SVG is inline it rather than hand a browser
 * a URL.
 */
export interface SvgPage extends EncodedImage {
  readonly format: 'svg';
  /** The SVG document itself, a single `<svg>` element sized in PDF points. */
  readonly markup: string;
}

/**
 * Wrap SVG markup as an {@link SvgPage}.
 *
 * `bytes` is encoded on first access: inlining the markup is the common case, and a
 * page of dense line art is megabytes of text that no one asked to have copied.
 */
export function svgPage(markup: string): SvgPage {
  const mime = MIME.svg;
  let encoded: Uint8Array | undefined;
  const bytes = (): Uint8Array => {
    encoded ??= new TextEncoder().encode(markup);
    return encoded;
  };

  return {
    markup,
    format: 'svg',
    mime,
    get bytes() {
      return bytes();
    },
    toBlob: () => new Blob([markup], { type: mime }),
    toBlobUrl() {
      return URL.createObjectURL(this.toBlob());
    },
    toDataUrl: () => `data:${mime};base64,${base64(bytes())}`,
  };
}

/**
 * Wrap already-encoded bytes as an {@link EncodedImage}.
 *
 * Exported for callers holding bytes from somewhere else — a cache, a fetch — that
 * want the same `toBlob`/`toBlobUrl`/`toDataUrl` conveniences.
 */
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
