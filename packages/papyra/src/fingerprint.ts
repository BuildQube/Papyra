/**
 * How many bytes to read from each end of the file.
 *
 * The tail is the load-bearing half: it holds the cross-reference table and the
 * trailer, and the trailer is where `/ID` lives. So although this never parses the
 * document, a file that carries an `/ID` still contributes it to the hash.
 */
const SAMPLE = 4096;

/** FNV-1a, 32-bit. Two runs at different offsets give the 64 bits below. */
function fnv1a(bytes: Uint8Array, seed: number): number {
  let hash = seed;
  for (const byte of bytes) {
    hash ^= byte;
    // The FNV prime, 16777619, as shifts — `Math.imul` keeps this in 32 bits where
    // `*` would silently go through a double and lose the low bits.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A stable identifier for a document's bytes.
 *
 * Sixteen hex characters, derived from the head, the tail and the length of the file.
 * Meant as a key for whatever a viewer remembers per document — the page it was left
 * on, the zoom, a set of highlights.
 *
 * **This is a content hash, not the PDF's `/ID`.** hayro exposes no trailer accessor,
 * so the identifier the spec defines is out of reach; the practical difference is
 * that a document saved with an incremental update keeps its `/ID` and gets a new
 * fingerprint here. For "is this the same file I had open", which is what the value
 * is for, hashing the bytes is the stronger answer anyway — it also distinguishes two
 * documents that were copied from one another and kept the same `/ID`.
 *
 * @internal
 */
export function fingerprint(bytes: Uint8Array): string {
  const head = bytes.subarray(0, SAMPLE);
  // `subarray` clamps, so a file shorter than one sample simply hashes twice rather
  // than needing a branch.
  const tail = bytes.subarray(Math.max(0, bytes.length - SAMPLE));

  const low = fnv1a(tail, fnv1a(head, 0x811c9dc5));
  // A second pass from a different seed, so the two halves of the output are not the
  // same 32 bits twice. Length goes in as well: it separates a file from its own
  // prefix, which the samples alone would not.
  const high = fnv1a(tail, fnv1a(head, bytes.length >>> 0));

  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}
