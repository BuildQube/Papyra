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

/**
 * Enough to show every feature: an outline, links, text to search, a big document,
 * annotations worth switching off, and one that will not open without a password.
 */
const WANTED = [
  'basicapi.pdf',
  'issue3214.pdf',
  'tracemonkey.pdf',
  'TAMReview.pdf',
  // Every AcroForm widget is an annotation with its own appearance stream, so this is
  // the one document in the set where the toolbar's annotations toggle visibly does
  // something — a page of filled fields against a blank form.
  '160F-2019.pdf',
  // Opens with `asdfasdf` — the demo's password prompt has nothing to prompt for
  // otherwise.
  'pr6531_1.pdf',
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

const generated: [string, Uint8Array][] = [
  ['rotated.pdf', rotatedTextPdf()],
  ['labelled.pdf', labelledPdf()],
];
for (const [name, bytes] of generated) {
  await writeFile(join(to, name), bytes);
  console.log(`  ✓ ${name} (generated)`);
}

console.log(
  `\n${copied + generated.length} in apps/demo/public — open with ?file=/<name>`,
);

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

  return assemble(objects);
}

/**
 * Front matter numbered i, ii, iii, then a body numbered from 1.
 *
 * Generated because nothing in the pdf.js corpus defines `/PageLabels` as anything
 * but its own index, and a page label that agrees with the index demonstrates
 * nothing: the reason to read one is a document where "page 4" and the number
 * printed on page 4 are different. Each page carries a link to the next, so the
 * link layer has something to do here too.
 */
function labelledPdf(): Uint8Array {
  const pages = ['Cover', 'Contents', 'Foreword', 'One', 'Two', 'Three'];
  const first = 4;
  const objectsPerPage = 3; // page, contents, link annotation

  const kids = pages
    .map((_, i) => `${first + i * objectsPerPage} 0 R`)
    .join(' ');

  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R /PageLabels 3 0 R >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    // Roman for the three-page front matter, decimal from there.
    `<< /Nums [0 << /S /r >> 3 << /S /D /St 1 >>] >>`,
  ];

  pages.forEach((title, i) => {
    const page = first + i * objectsPerPage;
    const content =
      `BT /F1 36 Tf 72 660 Td (${title}) Tj ET\n` +
      `BT /F1 14 Tf 72 620 Td (Next page) Tj ET`;
    // The last page links back to the first, so every page has a working link.
    const target = first + ((i + 1) % pages.length) * objectsPerPage;

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Contents ${page + 1} 0 R /Annots [${page + 2} 0 R] ` +
        `/Resources << /Font << /F1 ${first + pages.length * objectsPerPage} 0 R >> >> >>`,
      `<< /Length ${content.length + 1} >>\nstream\n${content}\nendstream`,
      `<< /Type /Annot /Subtype /Link /Rect [70 615 145 638] /Border [0 0 0] ` +
        `/Contents (Next page) /Dest [${target} 0 R /Fit] >>`,
    );
  });

  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  return assemble(objects);
}

/** Write numbered objects, an xref table and a trailer around them. */
function assemble(objects: string[]): Uint8Array {
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
