import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

// pdf.js's canvas backend expects these as globals in Node.
const g = globalThis as Record<string, unknown>;
g.DOMMatrix ??= DOMMatrix;
g.ImageData ??= ImageData;
g.Path2D ??= Path2D;

const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve('pdfjs-dist/package.json'));

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

/** Give pdf.js its font and cmap assets so the comparison is not rigged. */
const ASSETS = {
  standardFontDataUrl: `${PDFJS_DIR}/standard_fonts/`,
  cMapUrl: `${PDFJS_DIR}/cmaps/`,
  cMapPacked: true,
};

export async function renderAll(
  bytes: Uint8Array,
  dpi: number,
): Promise<number> {
  const scale = dpi / 72;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...ASSETS });
  const doc = await task.promise;
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(
        Math.floor(viewport.width),
        Math.floor(viewport.height),
      );
      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        canvas,
      } as never).promise;
      page.cleanup();
    }
    return doc.numPages;
  } finally {
    await task.destroy();
  }
}

export async function renderFirst(
  bytes: Uint8Array,
  dpi: number,
): Promise<void> {
  const scale = dpi / 72;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...ASSETS });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(
      Math.floor(viewport.width),
      Math.floor(viewport.height),
    );
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      canvas,
    } as never).promise;
  } finally {
    await task.destroy();
  }
}
