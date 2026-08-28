/**
 * Write the tiny PDF the /components previews render.
 *
 * Committed rather than fetched: the previews have to work on a cold visit, and the
 * test corpus is downloaded and gitignored. Generated rather than copied, so nothing
 * here carries someone else's licence.
 *
 * Three pages, because one page cannot show a pager, a thumbnail strip or a scroll.
 *
 * Usage: bun run scripts/make-sample-pdf.ts
 */
import { writeFileSync } from 'node:fs';

const PAGES = [
  [
    'papyra',
    'A sample document.',
    'Rendered by hayro, compiled to WebAssembly.',
  ],
  [
    'Page two',
    'Enough pages to scroll,',
    'and to give the pager something to do.',
  ],
  ['Page three', 'The last one.', 'Thumbnails need more than a single tile.'],
];

const objects: string[] = [];
/** 1-based, as PDF object numbers are. */
const add = (body: string): number => objects.push(body);

const kids: number[] = [];
const pageIds: number[] = [];
const contentIds: number[] = [];

// Object 1 is the catalogue and 2 the page tree; both are written after the pages,
// whose ids are not known until they exist. Placeholders keep the numbering stable.
add('');
add('');
const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

for (const lines of PAGES) {
  const text = lines
    .map((line, i) => {
      const size = i === 0 ? 28 : 13;
      const y = 700 - i * 34;
      const escaped = line.replace(/([\\()])/g, '\\$1');
      return `BT /F1 ${size} Tf 72 ${y} Td (${escaped}) Tj ET`;
    })
    .join('\n');
  const stream = `${text}\n`;
  contentIds.push(
    add(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`),
  );
}

for (const [i, contentId] of contentIds.entries()) {
  const id = add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
  );
  pageIds.push(id);
  kids.push(id);
  void i;
}

objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
objects[1] =
  `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] ` +
  `/Count ${kids.length} >>`;

let pdf = '%PDF-1.7\n';
const offsets: number[] = [];
for (const [i, body] of objects.entries()) {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
}

const xref = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) {
  pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
}
pdf +=
  `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ` +
  `/Info << /Title (papyra sample) /Producer (papyra scripts/make-sample-pdf.ts) >> >>\n` +
  `startxref\n${xref}\n%%EOF\n`;

const out = new URL('../apps/demo/public/sample.pdf', import.meta.url);
writeFileSync(out, pdf, 'latin1');
console.log(`wrote ${pdf.length} bytes, ${PAGES.length} pages`);
