/**
 * What text extraction and search cost, against pdf.js.
 *
 * Extraction is interpretation without rasterisation — the content stream is walked
 * and the glyphs are reported, but nothing is drawn — so it should land far below the
 * ~93ms floor a render of the same page pays. Whether that holds is the thing to
 * measure, since it decides whether a viewer can index a document up front or has to
 * search lazily.
 *
 * usage: bun run text [file.pdf]
 */
import { open } from '@build-qube/papyra';
import { loadCorpus, read } from './corpus.js';
import { extractAll } from './pdfjs.js';

const path = process.argv[2];
const files = path
  ? [{ name: path, bytes: read(path) }]
  : loadCorpus(['pr6531_1.pdf']);

const ms = async (fn: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await fn();
  return performance.now() - started;
};

// Character counts sit next to the timings because extracting less text faster is not
// a win. `cover` compares papyra's characters against pdf.js's *usable* ones: pdf.js
// passes raw character codes through when a font carries no Unicode, so its raw total
// counts thousands of control characters as text. `junk` is how many, and papyra emits
// none by construction — it drops what it cannot decode and counts it in `undec`.
console.log(
  `${'file'.padEnd(30)}${'pp'.padStart(4)}${'papyra'.padStart(9)}` +
    `${'pdf.js'.padStart(9)}${'ratio'.padStart(7)}${'ms/pp'.padStart(7)}` +
    `${'chars'.padStart(9)}${'pdf.js'.padStart(9)}${'junk'.padStart(8)}` +
    `${'cover'.padStart(7)}${'undec'.padStart(8)}`,
);
console.log('-'.repeat(107));

let papyraTotal = 0;
let pdfjsTotal = 0;
let pages = 0;
let ourTotal = 0;
let theirTotal = 0;
let undecodedTotal = 0;
let junkTotal = 0;

/** papyra's characters as a share of pdf.js's. */
const cover = (ours: number, theirs: number): string =>
  theirs === 0 ? '—' : `${((100 * ours) / theirs).toFixed(0)}%`;

for (const { name, bytes } of files) {
  const doc = await open(bytes);
  // One warm pass so neither side is paying for a cold JIT.
  await doc.indexText();

  const fresh = await open(bytes, { textCacheBytes: 0 });
  const mine = await ms(() => fresh.indexText());

  let their = { usable: 0, control: 0 };
  const theirs = await ms(async () => {
    their = await extractAll(bytes);
  });

  let ourChars = 0;
  let undecoded = 0;
  for (let i = 0; i < doc.pageCount; i++) {
    const text = await doc.pageText(i);
    for (const line of text.lines) ourChars += line.text.length;
    undecoded += text.undecodedGlyphs;
  }

  papyraTotal += mine;
  pdfjsTotal += theirs;
  pages += doc.pageCount;
  ourTotal += ourChars;
  theirTotal += their.usable;
  junkTotal += their.control;
  undecodedTotal += undecoded;

  console.log(
    `${name.padEnd(30)}${String(doc.pageCount).padStart(4)}` +
      `${`${mine.toFixed(0)}ms`.padStart(9)}${`${theirs.toFixed(0)}ms`.padStart(9)}` +
      `${`${(theirs / mine).toFixed(1)}x`.padStart(7)}` +
      `${(mine / doc.pageCount).toFixed(1).padStart(7)}` +
      `${String(ourChars).padStart(9)}${String(their.usable).padStart(9)}` +
      `${String(their.control).padStart(8)}` +
      `${cover(ourChars, their.usable).padStart(7)}${String(undecoded).padStart(8)}`,
  );
}

console.log('-'.repeat(107));
console.log(
  `${'aggregate'.padEnd(30)}${String(pages).padStart(4)}` +
    `${`${papyraTotal.toFixed(0)}ms`.padStart(9)}` +
    `${`${pdfjsTotal.toFixed(0)}ms`.padStart(9)}` +
    `${`${(pdfjsTotal / papyraTotal).toFixed(1)}x`.padStart(7)}` +
    `${(papyraTotal / pages).toFixed(1).padStart(7)}` +
    `${String(ourTotal).padStart(9)}${String(theirTotal).padStart(9)}` +
    `${String(junkTotal).padStart(8)}` +
    `${cover(ourTotal, theirTotal).padStart(7)}${String(undecodedTotal).padStart(8)}`,
);

if (ourTotal < theirTotal * 0.95) {
  console.log(
    `\n! papyra read ${theirTotal - ourTotal} fewer usable characters than pdf.js, ` +
      `over ${undecodedTotal} glyphs it could not decode.\n` +
      '  Those come from fonts carrying no Unicode at all — no ToUnicode cmap, and\n' +
      '  opaque gNN subset glyph names in both the encoding and the CFF charset.\n' +
      '  Nothing can read them without OCR; pdf.js emits the raw character codes\n' +
      `  instead, which is where its ${junkTotal} control characters come from.\n` +
      '  Treat the speed column as not comparable on the files this affects.',
  );
}

// Search over an already-indexed document should be string work, not PDF work, so
// run it over whichever file actually has text in it.
const first = files.reduce((a, b) => (b.bytes.length > a.bytes.length ? b : a));
if (first) {
  const doc = await open(first.bytes);
  await doc.indexText();
  const query = 'the';
  let hits = 0;
  const searched = await ms(async () => {
    for await (const _ of doc.search(query)) hits++;
  });
  console.log(
    `\nsearch "${query}" over ${first.name}: ${hits} hits in ${searched.toFixed(0)}ms ` +
      '(text already extracted)',
  );
}
