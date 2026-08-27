/**
 * Fetch the test corpus.
 *
 * The PDFs come from pdf.js's regression suite. They are third-party files with mixed
 * provenance, which is why pdf.js itself keeps many of them out of its repo — so we
 * fetch them into a gitignored directory rather than vendoring them.
 *
 * Usage: bun run corpus
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PDFJS_RAW =
  'https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs';

/** A deliberately varied slice: text, forms, CJK, CMYK images, transparency. */
const CORPUS = [
  { file: 'tracemonkey.pdf', note: '14pp academic paper, text-heavy' },
  { file: 'TAMReview.pdf', note: '23pp, mixed text and vector' },
  { file: 'alphatrans.pdf', note: 'alpha transparency groups' },
  { file: 'sizes.pdf', note: 'varied page sizes' },
  { file: 'franz.pdf', note: 'tiny single page' },
  { file: 'cmykjpeg.pdf', note: 'CMYK JPEG image' },
  { file: '160F-2019.pdf', note: 'AcroForm widgets' },
  { file: 'arial_unicode_en_cidfont.pdf', note: 'CID font' },
  { file: 'pr6531_1.pdf', note: 'password protected' },
  // Outlines. pdf.js's own `getOutline` tests use these, so between them they cover
  // the shapes that actually occur: nesting, style flags, name-tree and legacy
  // destinations, destination-less entries, and views with missing parameters.
  { file: 'basicapi.pdf', note: 'nested outline, bold entry, /Dests' },
  { file: 'issue3214.pdf', note: 'outline entries whose action is a URL' },
  { file: 'issue6204.pdf', note: 'name-tree destinations' },
  { file: 'issue19474.pdf', note: 'both /Names and /Dests' },
  { file: 'issue18408_reduced.pdf', note: '/XYZ destinations with no zoom' },
  { file: 'bug1907000_reduced.pdf', note: '/FitH destinations with no top' },
] as const;

const dir = join(import.meta.dir, '..', 'corpus');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

await mkdir(dir, { recursive: true });

let fetched = 0;
let skipped = 0;
for (const { file, note } of CORPUS) {
  const target = join(dir, file);
  if (await exists(target)) {
    skipped++;
    continue;
  }
  const res = await fetch(`${PDFJS_RAW}/${file}`);
  if (!res.ok) {
    console.error(`  ✗ ${file} — HTTP ${res.status}`);
    continue;
  }
  await writeFile(target, new Uint8Array(await res.arrayBuffer()));
  console.log(`  ✓ ${file.padEnd(30)} ${note}`);
  fetched++;
}

console.log(
  `\ncorpus ready in ./corpus — ${fetched} fetched, ${skipped} cached`,
);
