/**
 * Does priority actually reorder real renders?
 *
 * Simulates a viewer: saturate the queue with low-priority thumbnails, then ask for
 * one page urgently — as if the user jumped to it — and time how long it takes to
 * arrive with and without a priority.
 *
 * usage: bun run priority <file.pdf> [concurrency]
 */
import { readFileSync } from 'node:fs';
import { open } from '@build-qube/papyra';

const path = process.argv[2];
if (!path) {
  console.error('usage: bun run priority <file.pdf> [concurrency]');
  process.exit(1);
}
const concurrency = Number(process.argv[3]) || 4;
const bytes = readFileSync(path);

async function jumpTo(target: number, urgent: boolean): Promise<number> {
  // Fresh document per run so no work is already cached or in flight.
  const doc = await open(bytes, { concurrency });
  const backlog = Array.from({ length: doc.pageCount }, (_, i) =>
    doc.render(i, { fitWidth: 200, priority: 5 }),
  );
  // The backlog gets cancelled at the end; hold its rejections so they are not
  // reported as unhandled.
  for (const job of backlog) {
    job.promise.catch(() => {});
  }

  // Let the pool fill, so the urgent request genuinely has to queue.
  await new Promise((r) => setTimeout(r, 0));

  const started = performance.now();
  await doc.render(target, { fitWidth: 1600, priority: urgent ? 0 : 5 })
    .promise;
  const elapsed = performance.now() - started;

  for (const j of backlog) j.cancel();
  return elapsed;
}

const doc = await open(bytes, { concurrency });
const target = Math.min(doc.pageCount - 1, 20);
console.log(
  `${doc.pageCount} pages, concurrency ${doc.concurrency}\n` +
    `backlog of ${doc.pageCount} thumbnails queued, then jump to page ${target}\n`,
);

const fair = await jumpTo(target, false);
const urgent = await jumpTo(target, true);

console.log(`same priority as the backlog : ${fair.toFixed(0)}ms`);
console.log(`priority 0 (urgent)          : ${urgent.toFixed(0)}ms`);
console.log(
  `\n${(fair / urgent).toFixed(1)}x faster to the page the user is looking at`,
);
