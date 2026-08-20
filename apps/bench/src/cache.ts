/**
 * What the render cache is worth.
 *
 * Every render of a large drawing costs >=93ms regardless of output size, because the
 * cost is per-draw-call rather than per-pixel. A viewer re-renders the same page
 * constantly, so the cache is the difference between 93ms and free.
 *
 * usage: bun run cache <file.pdf>
 */
import { readFileSync } from 'node:fs';
import { open } from '@build-qube/papyra';

const path = process.argv[2];
if (!path) {
  console.error('usage: bun run cache <file.pdf>');
  process.exit(1);
}
const bytes = readFileSync(path);

const ms = async (fn: () => Promise<unknown>) => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};
const mb = (n: number) => `${(n / 1e6).toFixed(1)}MB`;

const doc = await open(bytes);
console.log(`${doc.pageCount} pages\n`);

const cold = await ms(() => doc.renderPage(0, { fitWidth: 1600 }));
const warm = await ms(() => doc.renderPage(0, { fitWidth: 1600 }));
console.log(
  `page 0 @1600  cold ${cold.toFixed(1)}ms   warm ${warm.toFixed(2)}ms`,
);
console.log(
  `              ${(cold / Math.max(warm, 0.001)).toFixed(0)}x faster on reuse\n`,
);

// A viewer: zoom in, then back out to a size already rendered.
const zoomIn = await ms(() => doc.renderPage(0, { fitWidth: 2400 }));
const zoomBack = await ms(() => doc.renderPage(0, { fitWidth: 1600 }));
console.log(`zoom to 2400 (miss) ${zoomIn.toFixed(1)}ms`);
console.log(`back to 1600 (hit)  ${zoomBack.toFixed(2)}ms\n`);

// Thumbnail strip, streamed twice: reopening a document view is the common case.
const first = await ms(async () => {
  for await (const _ of doc.stream({ fitWidth: 160 }));
});
const second = await ms(async () => {
  for await (const _ of doc.stream({ fitWidth: 160 }));
});
console.log(
  `all ${doc.pageCount} thumbnails  first ${first.toFixed(0)}ms   again ${second.toFixed(1)}ms   ` +
    `${(first / Math.max(second, 0.001)).toFixed(0)}x`,
);

const s = doc.cache;
console.log(
  `\ncache: ${s.entries} entries, ${mb(s.bytes)}, ${s.hits} hits / ${s.misses} misses, ` +
    `${s.evictions} evictions`,
);

// A budget too small to hold the working set should still not thrash into uselessness.
const tiny = await open(bytes, { cacheBytes: 2_000_000 });
for await (const _ of tiny.stream({ fitWidth: 160 }));
for await (const _ of tiny.stream({ fitWidth: 160 }));
const t = tiny.cache;
console.log(
  `2MB budget: ${t.entries} entries, ${mb(t.bytes)}, ${t.hits} hits / ${t.misses} misses, ` +
    `${t.evictions} evictions`,
);
