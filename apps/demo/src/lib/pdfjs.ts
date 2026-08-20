/** pdf.js loaded lazily, so the viewer does not pay for it unless you benchmark. */
import type {
  PDFDocumentProxy,
  PDFPageProxy,
} from 'pdfjs-dist/types/src/display/api';

type PdfjsModule = typeof import('pdfjs-dist');

let modulePromise: Promise<PdfjsModule> | null = null;

async function getPdfjs(): Promise<PdfjsModule> {
  modulePromise ??= (async () => {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.mjs',
      import.meta.url,
    ).toString();
    return pdfjs;
  })();
  return modulePromise;
}

export async function openWithPdfjs(
  bytes: Uint8Array,
): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfjs();
  return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

export async function renderPageToCanvas(
  page: PDFPageProxy,
  dpi: number,
): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return canvas;
}
