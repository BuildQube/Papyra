import { describe, expect, test } from 'bun:test';
import { encodedImage, mimeType, svgPage } from '../../src/encoded.js';

/** Stand-in for encoder output. The bytes never need to be a real image here. */
const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

describe('mimeType', () => {
  test('maps every format', () => {
    expect(mimeType('webp')).toBe('image/webp');
    expect(mimeType('png')).toBe('image/png');
    expect(mimeType('jpeg')).toBe('image/jpeg');
    expect(mimeType('svg')).toBe('image/svg+xml');
  });
});

describe('encodedImage', () => {
  test('carries the format and its mime type', () => {
    const img = encodedImage(bytes, 'webp');
    expect(img.format).toBe('webp');
    expect(img.mime).toBe('image/webp');
    expect(img.bytes).toBe(bytes);
  });

  test('toDataUrl base64-encodes behind the right prefix', () => {
    expect(encodedImage(bytes, 'png').toDataUrl()).toBe(
      'data:image/png;base64,3q2+7w==',
    );
  });

  test('toDataUrl round-trips bytes that would break a naive btoa', () => {
    // Every byte value, including the ones outside Latin-1 printable range.
    const all = new Uint8Array(256).map((_, i) => i);
    const url = encodedImage(all, 'jpeg').toDataUrl();
    const decoded = Uint8Array.from(
      atob(url.slice('data:image/jpeg;base64,'.length)),
      (c) => c.charCodeAt(0),
    );
    expect(decoded).toEqual(all);
  });

  test('toDataUrl handles a payload larger than one fromCharCode chunk', () => {
    // The browser path chunks at 0x8000 to avoid blowing the argument stack.
    const big = new Uint8Array(0x8000 * 2 + 7).map((_, i) => i % 251);
    const url = encodedImage(big, 'webp').toDataUrl();
    const decoded = Uint8Array.from(
      atob(url.slice('data:image/webp;base64,'.length)),
      (c) => c.charCodeAt(0),
    );
    expect(decoded.length).toBe(big.length);
    expect(decoded).toEqual(big);
  });

  test('toBlob copies, so wasm shared memory never reaches the Blob', () => {
    const img = encodedImage(bytes, 'png');
    const blob = img.toBlob();

    expect(blob.size).toBe(4);
    expect(blob.type).toBe('image/png');
    // A copy, not a view onto the caller's buffer.
    expect(new Uint8Array(4)).not.toBe(img.bytes);
  });

  test('toBlobUrl produces a revocable object URL', () => {
    const url = encodedImage(bytes, 'webp').toBlobUrl();
    expect(url).toStartWith('blob:');
    URL.revokeObjectURL(url);
  });
});

describe('svgPage', () => {
  const markup = '<svg viewBox="0 0 612 792"><path d="M0,0"/></svg>';

  test('keeps the markup readable, which is the usual thing to want', () => {
    const page = svgPage(markup);
    expect(page.markup).toBe(markup);
    expect(page.format).toBe('svg');
    expect(page.mime).toBe('image/svg+xml');
  });

  test('bytes are UTF-8, and computed once', () => {
    const page = svgPage(markup);
    expect(new TextDecoder().decode(page.bytes)).toBe(markup);
    expect(page.bytes).toBe(page.bytes);
  });

  /**
   * SVG is text, so a non-ASCII glyph name or `<title>` costs more bytes than
   * characters. Taking `markup.length` for the payload size would under-report it.
   */
  test('bytes count UTF-8 length, not characters', () => {
    const page = svgPage('<svg><title>café — “x”</title></svg>');
    expect(page.bytes.length).toBeGreaterThan(page.markup.length);
  });

  test('toDataUrl base64-encodes behind the svg mime type', () => {
    const url = svgPage(markup).toDataUrl();
    expect(url).toStartWith('data:image/svg+xml;base64,');
    expect(atob(url.slice('data:image/svg+xml;base64,'.length))).toBe(markup);
  });

  test('toBlob carries the mime type an <img> needs to render it', () => {
    const blob = svgPage(markup).toBlob();
    expect(blob.type).toBe('image/svg+xml');
    expect(blob.size).toBe(markup.length);
  });

  test('toBlobUrl produces a revocable object URL', () => {
    const url = svgPage(markup).toBlobUrl();
    expect(url).toStartWith('blob:');
    URL.revokeObjectURL(url);
  });
});
