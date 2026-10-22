/**
 * Metric-compatible stand-ins for the Office fonts — Carlito for Calibri, Caladea
 * for Cambria, Arimo for Arial, Tinos for Times New Roman — from Google Fonts at a
 * pinned commit. Without them a browser has no font with Calibri's widths, and a
 * Word document's line and page breaks drift from where Word puts them.
 * `scripts/office-engines.ts` registers the same list, so the fidelity check
 * paginates as the demo does.
 */
export const OFFICE_FONTS = [
  'carlito/Carlito-Regular.ttf',
  'carlito/Carlito-Bold.ttf',
  'carlito/Carlito-Italic.ttf',
  'carlito/Carlito-BoldItalic.ttf',
  'caladea/Caladea-Regular.ttf',
  'caladea/Caladea-Bold.ttf',
  'arimo/Arimo%5Bwght%5D.ttf',
  'tinos/Tinos-Regular.ttf',
  'tinos/Tinos-Bold.ttf',
].map(
  (f) =>
    `https://cdn.jsdelivr.net/gh/google/fonts@51303ca9e8ac9dcea7b12d307ba568fd0e6fcfca/ofl/${f}`,
);
