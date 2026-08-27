import { describe, expect, test } from 'bun:test';
import { fingerprint } from '../../src/fingerprint.js';

/** Bytes that look like a PDF: a header, filler, and a trailer carrying an `/ID`. */
function pdfLike(id: string, filler = 'x', fillerLength = 20_000): Uint8Array {
  const body = `%PDF-1.7\n${filler.repeat(fillerLength)}`;
  const trailer = `trailer\n<< /Size 5 /Root 1 0 R /ID [<${id}> <${id}>] >>\n%%EOF\n`;
  return new TextEncoder().encode(body + trailer);
}

describe('fingerprint', () => {
  test('is stable for the same bytes', () => {
    const bytes = pdfLike('a1b2');
    expect(fingerprint(bytes)).toBe(fingerprint(pdfLike('a1b2')));
  });

  test('is sixteen hex characters', () => {
    expect(fingerprint(pdfLike('a1b2'))).toMatch(/^[0-9a-f]{16}$/);
  });

  test('separates two documents that differ only in their trailer', () => {
    // The tail sample is what makes this work: `/ID` lives in the trailer, so two
    // files with identical bodies still land on different fingerprints.
    expect(fingerprint(pdfLike('a1b2'))).not.toBe(fingerprint(pdfLike('c3d4')));
  });

  test('separates two documents that differ only in the middle', () => {
    // Not guaranteed in general — the middle of a large file is not sampled — but a
    // change to the body moves the trailer's offset and therefore the tail window.
    expect(fingerprint(pdfLike('a1b2', 'x', 20_000))).not.toBe(
      fingerprint(pdfLike('a1b2', 'x', 20_001)),
    );
  });

  test('separates a file from its own prefix', () => {
    const full = pdfLike('a1b2');
    expect(fingerprint(full)).not.toBe(fingerprint(full.subarray(0, 100)));
  });

  test('handles a file shorter than one sample window', () => {
    const tiny = new TextEncoder().encode('%PDF-1.7\n');
    expect(fingerprint(tiny)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint(tiny)).not.toBe(fingerprint(new Uint8Array()));
  });
});
