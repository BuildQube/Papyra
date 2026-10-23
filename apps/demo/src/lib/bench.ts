import { open } from '@build-qube/papyra';
import { openWithPdfjs, renderPageToCanvas } from './pdfjs.js';

export interface BenchResult {
  engine: 'papyra' | 'pdf.js';
  pages: number;
  totalMs: number;
  msPerPage: number;
  firstPageMs: number;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const value = await fn();
  return [value, performance.now() - t];
}

export async function benchPapyra(
  bytes: Uint8Array,
  dpi: number,
): Promise<BenchResult> {
  const doc = await open(bytes);
  try {
    const [, firstPageMs] = await timed(() => doc.renderPage(0, { dpi }));
    // Each bitmap is dropped as it arrives, as pdf.js's canvas is below. Holding them
    // all, as `renderPages` must, is 10 GB for a 90-sheet ARCH-E set at 150 DPI.
    const [pages, totalMs] = await timed(async () => {
      let count = 0;
      for await (const _ of doc.stream({ dpi })) count++;
      return count;
    });
    return {
      engine: 'papyra',
      pages,
      totalMs,
      msPerPage: totalMs / pages,
      firstPageMs,
    };
  } finally {
    await doc.close();
  }
}

export async function benchPdfjs(
  bytes: Uint8Array,
  dpi: number,
): Promise<BenchResult> {
  const doc = await openWithPdfjs(bytes);
  const [, firstPageMs] = await timed(async () =>
    renderPageToCanvas(await doc.getPage(1), dpi),
  );
  const [, totalMs] = await timed(async () => {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      await renderPageToCanvas(page, dpi);
      page.cleanup();
    }
  });
  return {
    engine: 'pdf.js',
    pages: doc.numPages,
    totalMs,
    msPerPage: totalMs / doc.numPages,
    firstPageMs,
  };
}
