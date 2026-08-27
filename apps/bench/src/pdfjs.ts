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

/**
 * A character no search could match: a C0 or C1 control.
 *
 * Not a nitpick. Given a font with no Unicode information — no `ToUnicode` cmap and
 * opaque `gNN` subset glyph names — pdf.js passes the raw character codes through as
 * if they were Unicode, so a Word-generated document comes back as thousands of
 * U+0002s. Counting those as extracted text would rank a tool that silently emits
 * junk above one that reports it cannot read the page.
 */
function isControl(c: string): boolean {
  const n = c.codePointAt(0) as number;
  return (n < 0x20 && n !== 0x09 && n !== 0x0a) || (n >= 0x7f && n <= 0x9f);
}

export interface Extracted {
  /** Characters standing for something a user could search for. */
  usable: number;
  /** Characters that came back as control codes. */
  control: number;
}

/** Every character pdf.js extracts, split by whether it means anything. */
export async function extractAll(bytes: Uint8Array): Promise<Extracted> {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), ...ASSETS });
  const doc = await task.promise;
  try {
    let usable = 0;
    let control = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item)) continue;
        for (const c of item.str) {
          if (isControl(c)) control++;
          else usable++;
        }
      }
      page.cleanup();
    }
    return { usable, control };
  } finally {
    await task.destroy();
  }
}
