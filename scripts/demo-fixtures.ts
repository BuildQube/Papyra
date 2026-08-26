/**
 * Copy a few corpus PDFs into the demo's `public/` so they can be opened with
 * `?file=/name.pdf` instead of the file picker.
 *
 * The corpus is gitignored (third-party files, mixed provenance) and so is
 * `apps/demo/public/*.pdf`, so this is a local convenience rather than something the
 * repository carries.
 *
 * Usage: bun run --filter papyra-demo fixtures
 */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Enough to show every feature: an outline, text to search, and a big document. */
const WANTED = [
  'basicapi.pdf',
  'issue3214.pdf',
  'tracemonkey.pdf',
  'TAMReview.pdf',
];

const root = join(import.meta.dir, '..');
const from = join(root, 'corpus');
const to = join(root, 'apps', 'demo', 'public');

await mkdir(to, { recursive: true });

let copied = 0;
for (const name of WANTED) {
  try {
    await copyFile(join(from, name), join(to, name));
    console.log(`  ✓ ${name}`);
    copied++;
  } catch {
    console.error(
      `  ✗ ${name} — not in ./corpus, run \`bun run corpus\` first`,
    );
  }
}

await writeFile(join(to, 'rotated.pdf'), rotatedTextPdf());
console.log('  ✓ rotated.pdf (generated)');

console.log(`\n${copied + 1} in apps/demo/public — open with ?file=/<name>`);

/**
 * A page of text at four different angles.
 *
 * Generated rather than fetched because the pdf.js corpus has nothing that shows the
 * thing worth showing: papyra reports a match's exact corners, so a highlight on
 * diagonal text is a parallelogram at the text's own angle rather than an upright box
 * smeared across everything near it. Construction drawings are full of such labels.
 */
function rotatedTextPdf(): Uint8Array {
  const content = [
    'BT /F1 24 Tf 60 700 Td (Horizontal site plan label) Tj ET',
    'BT /F1 24 Tf 0 1 -1 0 80 300 Tm (Rotated dimension label) Tj ET',
    'BT /F1 24 Tf 0.707 0.707 -0.707 0.707 200 250 Tm (Diagonal site plan) Tj ET',
    'BT /F1 24 Tf 0 -1 1 0 520 500 Tm (Downward site plan) Tj ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length + 1} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${startxref}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}
