/**
 * Is this document interpretation-bound or rasterisation-bound?
 *
 * Render cost splits into a fixed per-page cost (parsing the content stream, decoding
 * images, building paths) and a per-pixel cost (rasterising). Which dominates decides
 * whether progressive low-res-first rendering and tiling are worth anything:
 *
 *   text page      3.2ms @0.1MP -> 78.9ms @51MP   per-pixel dominates
 *   ARCH-E drawing  95.6ms @0.03MP -> 151.7ms @28MP   fixed cost dominates
 *
 * usage: bun run scaling <file.pdf>
 */
import { readFileSync } from 'node:fs';
import { open } from '@build-qube/papyra';

const path = process.argv[2];
if (!path) {
  console.error('usage: bun run scaling <file.pdf>');
  process.exit(1);
}
const doc = await open(readFileSync(path));
const { width, height } = doc.pageSize(0);
console.log(`${(width / 72).toFixed(0)}x${(height / 72).toFixed(0)}in page\n`);
console.log('fitWidth   pixels      ms    ms/MP');
console.log('-'.repeat(40));
for (const w of [200, 400, 800, 1600, 3200, 6300]) {
  let best = Number.POSITIVE_INFINITY;
  let px = 0;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const p = await doc.renderPage(0, { fitWidth: w });
    best = Math.min(best, performance.now() - t);
    px = p.width * p.height;
  }
  console.log(
    `${String(w).padStart(8)}${(px / 1e6).toFixed(1).padStart(9)}MP${best.toFixed(1).padStart(8)}${(best / (px / 1e6)).toFixed(1).padStart(9)}`,
  );
}
