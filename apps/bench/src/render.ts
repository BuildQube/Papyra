/**
 * papyra vs pdf.js — whole-document throughput and time-to-first-page.
 *
 * Usage: bun run bench [--dpi 150] [--rounds 5]
 */
import { open } from '@build-qube/papyra';
import { loadCorpus } from './corpus.js';
import { renderAll, renderFirst } from './pdfjs.js';

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN;
  return Number.isFinite(v) ? v : fallback;
};

const DPI = arg('dpi', 150);
const ROUNDS = arg('rounds', 5);
const WARMUP = 1;

async function best(fn: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < WARMUP; i++) await fn();
  let ms = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ROUNDS; i++) {
    const t = performance.now();
    await fn();
    ms = Math.min(ms, performance.now() - t);
  }
  return ms;
}

interface Row {
  name: string;
  pages: number;
  papyra: number | null;
  pdfjs: number | null;
  papyraFirst: number | null;
  pdfjsFirst: number | null;
}

const rows: Row[] = [];
// The password-protected file is a load-behaviour check, not a render benchmark.
for (const { name, bytes } of loadCorpus(['pr6531_1.pdf'])) {
  const doc = await open(bytes);
  const pages = doc.pageCount;

  const papyra = await best(() =>
    open(bytes).then((d) => d.renderPages(0, d.pageCount, { dpi: DPI })),
  );
  const papyraFirst = await best(() =>
    open(bytes).then((d) => d.renderPage(0, { dpi: DPI })),
  );

  let pdfjs: number | null = null;
  let pdfjsFirst: number | null = null;
  try {
    pdfjs = await best(() => renderAll(bytes, DPI));
    pdfjsFirst = await best(() => renderFirst(bytes, DPI));
  } catch (e) {
    console.error(`  pdf.js failed on ${name}: ${(e as Error).message}`);
  }

  rows.push({ name, pages, papyra, pdfjs, papyraFirst, pdfjsFirst });
  process.stdout.write('.');
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
const perPage = (ms: number | null, pages: number) =>
  ms === null ? '-' : (ms / pages).toFixed(2);

console.log(`\n\npapyra vs pdf.js — ${DPI} DPI, best of ${ROUNDS}\n`);
console.log(
  `${'file'.padEnd(30)}${pad('pg', 4)}${pad('papyra', 9)}${pad('pdf.js', 9)}${pad('speedup', 9)}${pad('1st pg', 9)}${pad('vs', 8)}`,
);
console.log('-'.repeat(78));

let sumP = 0;
let sumJ = 0;
for (const r of rows) {
  if (r.papyra !== null && r.pdfjs !== null) {
    sumP += r.papyra;
    sumJ += r.pdfjs;
  }
  const speed =
    r.papyra && r.pdfjs ? `${(r.pdfjs / r.papyra).toFixed(2)}x` : '-';
  const firstSpeed =
    r.papyraFirst && r.pdfjsFirst
      ? `${(r.pdfjsFirst / r.papyraFirst).toFixed(2)}x`
      : '-';
  console.log(
    r.name.padEnd(30) +
      pad(r.pages, 4) +
      pad(perPage(r.papyra, r.pages), 9) +
      pad(perPage(r.pdfjs, r.pages), 9) +
      pad(speed, 9) +
      pad(r.papyraFirst?.toFixed(1) ?? '-', 9) +
      pad(firstSpeed, 8),
  );
}
console.log('-'.repeat(78));
console.log(
  `aggregate: papyra ${sumP.toFixed(0)}ms vs pdf.js ${sumJ.toFixed(0)}ms` +
    `  =>  ${(sumJ / sumP).toFixed(2)}x faster`,
);
console.log('\nms/page columns; "1st pg" is open+render page 0 in ms.');
