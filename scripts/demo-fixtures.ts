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
  ['tagged-columns.pdf', taggedColumnsPdf()],
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

/**
 * Two columns drawn interleaved, tagged in the order they are meant to be read.
 *
 * Generated because the corpus has exactly one tagged file (`160F-2019.pdf`, a form),
 * and a form does not make the point at a glance. Here the content stream draws
 * left line, right line, left line — the order a generator found convenient — so
 * reading it as drawn interleaves the two columns into nonsense, and the structure
 * tree puts them back. Ten of the thirteen lines move.
 *
 * That gap is the whole reason to read a structure tree, and it cannot be recovered
 * from geometry: the drawing order genuinely is what it is.
 *
 * The columns are tagged `/Column` and mapped to `/Sect` through the root's
 * `/RoleMap`, because real tagged files do exactly this — Word, InDesign and Excel
 * all ship their own tag names — and a viewer that matches the raw tag sees nothing.
 */
function taggedColumnsPdf(): Uint8Array {
  const title = 'Reading order is not drawing order';
  const left = [
    'A PDF says where each glyph',
    'goes and nothing more. The',
    'order it draws them in is',
    'whatever suited the program',
    'that wrote the file, which is',
    'rarely the order you read.',
  ];
  const right = [
    'A tagged PDF adds a structure',
    "tree: the document's own",
    'account of which runs are',
    'headings, which are paragraphs,',
    'and what order a reader is',
    'meant to take them in.',
  ];

  // Marked-content ids run in *reading* order: 0 is the title, 1-6 the left column,
  // 7-12 the right. The content stream below then emits them in a different order,
  // which is the entire point of the fixture.
  const show = (
    mcid: number,
    x: number,
    y: number,
    size: number,
    text: string,
  ) =>
    `/P << /MCID ${mcid} >> BDC BT /F1 ${size} Tf ${x} ${y} Td (${text}) Tj ET EMC`;

  const LEFT_X = 56;
  const RIGHT_X = 316;
  const TOP = 648;
  const STEP = 20;

  const drawn = [show(0, LEFT_X, 700, 18, title)];
  // Interleaved: one line of the left column, then one of the right.
  for (let i = 0; i < left.length; i++) {
    drawn.push(show(1 + i, LEFT_X, TOP - i * STEP, 11, left[i] as string));
    drawn.push(show(7 + i, RIGHT_X, TOP - i * STEP, 11, right[i] as string));
  }
  const content = drawn.join('\n');

  // A paragraph per three lines, so the tree has something to expand and each node
  // highlights a block rather than the whole column.
  const para = (mcids: number[]) =>
    `<< /Type /StructElem /S /P /Pg 3 0 R /K [${mcids.join(' ')}] >>`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length + 1} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /StructTreeRoot /RoleMap << /Column /Sect >> /K [7 0 R] >>',
    '<< /Type /StructElem /S /Document /Pg 3 0 R /K [8 0 R 9 0 R 12 0 R] >>',
    '<< /Type /StructElem /S /H1 /Pg 3 0 R /T (Title) /K [0] >>',
    '<< /Type /StructElem /S /Column /T (Left column) /K [10 0 R 11 0 R] >>',
    para([1, 2, 3]),
    para([4, 5, 6]),
    '<< /Type /StructElem /S /Column /T (Right column) /K [13 0 R 14 0 R] >>',
    para([7, 8, 9]),
    para([10, 11, 12]),
  ];

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
