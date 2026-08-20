/** End-to-end check of the public wrapper API. */
import { backend, currentRuntime, open } from '@build-qube/papyra';
import { read } from './corpus.js';

console.log(`runtime: ${currentRuntime()}  backend: ${backend()}\n`);

const doc = await open(read('TAMReview.pdf'));
console.log(
  `pages: ${doc.pageCount}  page 0: ${JSON.stringify(doc.pageSize(0))}`,
);

let t = performance.now();
const pages = await doc.renderPages(0, doc.pageCount, { dpi: 150 });
console.log(
  `renderPages: ${pages.length} pages in ${(performance.now() - t).toFixed(1)}ms ` +
    `(${pages[0]?.width}x${pages[0]?.height}, ${pages[0]?.format})`,
);

t = performance.now();
let seen = 0;
for await (const { page, bitmap } of doc.stream({ dpi: 48, concurrency: 8 })) {
  if (seen === 0) {
    console.log(
      `first thumbnail (page ${page}, ${bitmap.width}x${bitmap.height}): ` +
        `${(performance.now() - t).toFixed(1)}ms`,
    );
  }
  if (++seen === 4) break;
}
console.log(`4 thumbnails then break: ${(performance.now() - t).toFixed(1)}ms`);

// Node's Buffer types as Uint8Array<ArrayBufferLike>, which BlobPart now rejects
// because SharedArrayBuffer is in that union. Copy into a plain ArrayBuffer.
const franz = read('franz.pdf');
const fromBlob = await open(new Blob([franz.slice().buffer as ArrayBuffer]));
console.log(`Blob input: ${fromBlob.pageCount} page(s)`);

try {
  await open(read('pr6531_1.pdf'));
  console.log('encrypted: unexpectedly opened without a password');
} catch (e) {
  console.log(
    `encrypted without password: ${(e as Error).message.slice(0, 64)}`,
  );
}
