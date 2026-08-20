/** Regression check for large-format drawings (ARCH-E, 42x30in). */
import { readFileSync } from 'node:fs';
import { open } from '@build-qube/papyra';

const path = process.argv[2];
if (!path) {
  console.error(
    'usage: bun run large-format <file.pdf>\n\n' +
      'Checks a large-format document (architectural drawings, plans, posters).\n' +
      'A fixed DPI explodes on these: 150 DPI on a 42x30in sheet is 6300x4500 =\n' +
      '113MB per page. fitWidth sizes by output pixels instead.',
  );
  process.exit(1);
}
const doc = await open(readFileSync(path));
const { width, height } = doc.pageSize(0);
console.log(
  `${doc.pageCount} pages, ${(width / 72).toFixed(0)}x${(height / 72).toFixed(0)}in\n`,
);

const mb = (p: { width: number; height: number }) =>
  ((p.width * p.height * 4) / 1e6).toFixed(1);

const thumb = await doc.renderPage(0, { fitWidth: 160 });
console.log(`fitWidth 160  -> ${thumb.width}x${thumb.height}  ${mb(thumb)}MB`);

const view = await doc.renderPage(0, { fitWidth: 2000 });
console.log(`fitWidth 2000 -> ${view.width}x${view.height}  ${mb(view)}MB`);

let total = 0;
const t = performance.now();
for await (const { bitmap } of doc.stream({ fitWidth: 160 })) {
  total += bitmap.data.length;
}
console.log(
  `all ${doc.pageCount} thumbs: ${(performance.now() - t).toFixed(0)}ms, ` +
    `${(total / 1e6).toFixed(1)}MB total`,
);

for (const dpi of [150, 300]) {
  try {
    const p = await doc.renderPage(0, { dpi });
    console.log(`\n@${dpi} DPI: allowed -> ${p.width}x${p.height} ${mb(p)}MB`);
  } catch (e) {
    console.log(`\n@${dpi} DPI guard: ${(e as Error).message}`);
  }
}
