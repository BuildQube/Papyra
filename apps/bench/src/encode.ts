/**
 * Encoder comparison — bytes and milliseconds per format, across the corpus.
 *
 * The claim this exists to check: lossless WebP is both smaller and faster than PNG on
 * page-shaped content, which is why it is papyra's default. JPEG should win on scanned
 * or photographic pages and lose badly on line art.
 *
 * SVG is reported apart from the table on purpose. Its cost is a whole-page conversion
 * rather than an encode of pixels already rendered, and its size does not move with
 * DPI at all, so putting it in a column beside the three raster encoders would compare
 * two different things.
 *
 * Usage: bun run encode [--dpi 150] [--rounds 3]
 */
import { open, type RasterFormat } from '@build-qube/papyra';
import { loadCorpus } from './corpus.js';

const arg = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN;
  return Number.isFinite(v) ? v : fallback;
};

const DPI = arg('dpi', 150);
const ROUNDS = arg('rounds', 3);
const FORMATS: readonly RasterFormat[] = ['webp', 'png', 'jpeg'];

interface Row {
  name: string;
  raw: number;
  bytes: Record<RasterFormat, number>;
  ms: Record<RasterFormat, number>;
  /** Vector output: markup bytes and the conversion that produced them. */
  svgBytes: number;
  svgMs: number;
}

const rows: Row[] = [];

// Password-protected; nothing to render.
for (const { name, bytes } of loadCorpus(['pr6531_1.pdf'])) {
  const doc = await open(bytes);
  const img = await doc.renderImage(0, { dpi: DPI });

  const size = {} as Record<RasterFormat, number>;
  const time = {} as Record<RasterFormat, number>;

  for (const format of FORMATS) {
    // Best-of, same as the throughput bench: we want the encoder's cost, not the
    // scheduler's worst moment.
    let ms = Number.POSITIVE_INFINITY;
    let out = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const t = performance.now();
      const encoded = await img.encode({ format });
      ms = Math.min(ms, performance.now() - t);
      out = encoded.bytes.length;
    }
    size[format] = out;
    time[format] = ms;
  }

  let svgMs = Number.POSITIVE_INFINITY;
  let svgBytes = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const t = performance.now();
    const svg = await doc.renderSvg(0);
    svgMs = Math.min(svgMs, performance.now() - t);
    svgBytes = svg.bytes.length;
  }

  rows.push({
    name,
    raw: img.byteLength,
    bytes: size,
    ms: time,
    svgBytes,
    svgMs,
  });
}

const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;
const pad = (s: string, n: number) => s.padStart(n);

console.log(`page 0 of each corpus file at ${DPI} DPI, best of ${ROUNDS}\n`);
console.log(
  `${'file'.padEnd(30)}${pad('raw', 9)}${pad('webp', 9)}${pad('png', 9)}${pad('jpeg', 9)}` +
    `${pad('webp', 7)}${pad('png', 7)}${pad('jpeg', 7)}`,
);
console.log(`${' '.repeat(66)}${pad('ms', 7)}${pad('ms', 7)}${pad('ms', 7)}`);
console.log('-'.repeat(87));

for (const r of rows) {
  console.log(
    r.name.padEnd(30) +
      pad(kb(r.raw), 9) +
      FORMATS.map((f) => pad(kb(r.bytes[f]), 9)).join('') +
      FORMATS.map((f) => pad(r.ms[f].toFixed(1), 7)).join(''),
  );
}

const total = (pick: (r: Row) => number) =>
  rows.reduce((a, r) => a + pick(r), 0);
const rawTotal = total((r) => r.raw);

console.log(`\nvs raw RGBA, and vs PNG:`);
for (const f of FORMATS) {
  const b = total((r) => r.bytes[f]);
  const ms = total((r) => r.ms[f]);
  const vsPng = total((r) => r.bytes.png) / b;
  console.log(
    `  ${f.padEnd(5)} ${kb(b).padStart(9)}  ` +
      `${(rawTotal / b).toFixed(1)}x smaller than raw, ` +
      `${vsPng.toFixed(2)}x ${vsPng >= 1 ? 'smaller' : 'larger'} than PNG, ` +
      `${ms.toFixed(0)}ms total`,
  );
}

const svgTotal = total((r) => r.svgBytes);
const webpTotal = total((r) => r.bytes.webp);
const vsWebp = svgTotal / webpTotal;
console.log(
  `\n  ${'svg'.padEnd(5)} ${kb(svgTotal).padStart(9)}  ` +
    `${vsWebp.toFixed(2)}x ${vsWebp >= 1 ? 'larger' : 'smaller'} than WebP at ${DPI} DPI, ` +
    `${total((r) => r.svgMs).toFixed(0)}ms total`,
);
console.log(
  '\n  Not a like-for-like row. That time is a whole-page conversion, not an encode of\n' +
    '  pixels already rendered; and the size does not move with DPI, so every doubling\n' +
    '  of the raster shifts the comparison in SVG favour.',
);
