/**
 * A width and a height in PDF points — a page's, or anything measured the same way.
 *
 * Structural rather than papyra's `PageSize`, which it matches: nothing in this file
 * needs the engine, and importing it for a type alone made papyra an install-time
 * dependency of every view that zooms, images included.
 */
export interface Size {
  /** Width in points. */
  readonly width: number;
  /** Height in points. */
  readonly height: number;
}

/** A view rotation in degrees clockwise. The same values as papyra's `Rotation`. */
export type Rotation = 0 | 90 | 180 | 270;

/**
 * CSS pixels per PDF point at 100%.
 *
 * A PDF point is 1/72in and a CSS pixel is 1/96in, so 100% means "actual size on a
 * nominal 96 DPI screen". Same convention pdf.js uses, which is the only reason 100%
 * here and 100% there put a page at the same size.
 */
export const CSS_UNITS = 96 / 72;

/** A rule that tracks the viewport rather than a fixed percentage. */
export type FitMode = 'auto' | 'page-fit' | 'page-width';

/**
 * Whether pages are shown one at a time or in a scrolling column.
 *
 * Presentation vocabulary rather than zoom, but it lives here for the same reason the
 * fit modes do: the toolbar, the store and the page views all need the word, and none
 * of them should have to depend on one of the others to get it.
 */
export type ViewMode = 'page' | 'scroll';
/** What the user asked for: a fixed percentage, or a rule that tracks the viewport. */
export type ZoomSpec = number | FitMode;

/** The floor the ladder and the gestures clamp to. */
export const MIN_ZOOM = 0.1;
/** The ceiling. Past this a page costs more pixels than it can show. */
export const MAX_ZOOM = 10;

/** Every fit mode, in the order a zoom menu should list them. */
export const FIT_MODES: readonly FitMode[] = ['auto', 'page-fit', 'page-width'];

/** The ladder −/+ and Cmd+/− walk, so repeated clicks land on round numbers. */
export const ZOOM_STEPS: readonly number[] = [
  0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 10,
];

/** `auto` fits the width but never magnifies past this, as pdf.js's does. */
const AUTO_MAX = 1.25;

/**
 * Device pixels a single page may cost.
 *
 * 24 MP is 96 MB of RGBA. Uncapped, 4x on a retina screen wants 55 MP for US Letter
 * and far past papyra's 100 MP refusal for an ARCH-E sheet, so beyond the cap the
 * canvas is stretched instead — which is what every viewer without tiling does.
 */
const MAX_RENDER_PIXELS = 24e6;

/**
 * The longest side papyra rasterises: vello_cpu snaps to 256px tiles in `u16`. A
 * roll drawing past about 177:1 reaches it before the pixel cap does.
 */
const MAX_RENDER_SIDE = 65280;

/** Above 2 the extra pixels cost real milliseconds and are invisible. */
const MAX_DPR = 2;

/** Narrows an unknown search-param value to a {@link FitMode}. */
export function isFitMode(value: unknown): value is FitMode {
  return value === 'auto' || value === 'page-fit' || value === 'page-width';
}

/** Holds a scale inside {@link MIN_ZOOM}..{@link MAX_ZOOM}. */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The next rung up the ladder, so repeated clicks land on round numbers. */
export function zoomIn(zoom: number): number {
  return ZOOM_STEPS.find((step) => step > zoom + 1e-4) ?? MAX_ZOOM;
}

/** The next rung down. */
export function zoomOut(zoom: number): number {
  // Not `findLast`: that is ES2023, and a consumer may compile against ES2022.
  return (
    [...ZOOM_STEPS].reverse().find((step) => step < zoom - 1e-4) ?? MIN_ZOOM
  );
}

/** The box a fit mode measures itself against, in CSS pixels. */
export interface Viewport {
  /** Usable width, gutters already removed. */
  width: number;
  /** Usable height. */
  height: number;
}

/**
 * Turn what the user asked for into a concrete scale.
 *
 * The fit modes measure against the page on screen rather than the first page: a
 * document that mixes portrait text with landscape plates would otherwise fit one of
 * them and crop the other.
 */
export function resolveZoom(
  spec: ZoomSpec,
  page: Size | null,
  viewport: Viewport,
): number {
  if (typeof spec === 'number') return clampZoom(spec);
  if (!page || page.width <= 0 || page.height <= 0) return 1;
  if (viewport.width <= 0 || viewport.height <= 0) return 1;

  const byWidth = viewport.width / (page.width * CSS_UNITS);
  if (spec === 'page-width') return clampZoom(byWidth);
  if (spec === 'auto') return clampZoom(Math.min(byWidth, AUTO_MAX));
  return clampZoom(
    Math.min(byWidth, viewport.height / (page.height * CSS_UNITS)),
  );
}

/** The CSS box a page occupies at a given zoom. */
export function pageBox(page: Size, zoom: number): Viewport {
  return {
    width: Math.max(1, Math.round(page.width * CSS_UNITS * zoom)),
    height: Math.max(1, Math.round(page.height * CSS_UNITS * zoom)),
  };
}

/**
 * Device pixels to rasterise a page at — what goes to `fitWidth`.
 *
 * Sizing by output width rather than DPI is the whole reason zoom is safe here: the
 * cost of a render tracks what is actually on screen, so a 42x30in drawing at 400%
 * costs the same as US Letter at 400% instead of two orders of magnitude more.
 */
export function renderWidth(page: Size, zoom: number): number {
  const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
  const want = Math.max(1, Math.round(page.width * CSS_UNITS * zoom * dpr));
  if (page.width <= 0 || page.height <= 0) return want;
  const cap = Math.max(
    1,
    Math.min(
      Math.sqrt((MAX_RENDER_PIXELS * page.width) / page.height),
      MAX_RENDER_SIDE,
      (MAX_RENDER_SIDE * page.width) / page.height,
    ) | 0,
  );
  return Math.min(want, cap);
}

/**
 * Device pixels on a side of one tile.
 *
 * Large, because a tile costs the page's interpretation floor rather than its pixels:
 * on an ARCH-E sheet at 400% a 256px tile takes what a 1024px one does (Addendum 13
 * in papyra's spike results), so smaller tiles only mean more of them.
 */
export const TILE_SIZE = 1024;

/**
 * Tile pixels each tile overlaps the next by. Two, because a tile pixel can be as
 * small as 0.7 of a device pixel — tiles render at the √2 step above the zoom.
 */
const TILE_OVERLAP = 2;

/**
 * The DPI to show a page at in tiles, or 0 when one bitmap of it fits under
 * `MAX_RENDER_PIXELS` and {@link renderWidth} serves.
 *
 * Quantised to steps of √2 and rounded up: a zoom between two steps shows the upper
 * step's tiles scaled down by CSS, so pinching through 400% does not render and cache
 * a new set at every frame's scale — and is never blurrier than asked. The cost is at
 * most twice the pixels, about a third more on average.
 */
export function tileDpi(page: Size, zoom: number): number {
  const scale =
    CSS_UNITS * zoom * Math.min(MAX_DPR, window.devicePixelRatio || 1);
  // Exactly when `renderWidth` caps, so a stretched bitmap always has tiles over it.
  if (renderWidth(page, zoom) >= Math.round(page.width * scale)) return 0;
  return 72 * Math.SQRT2 ** Math.ceil(2 * Math.log2(scale));
}

/** A rectangle in CSS pixels, by its edges. */
export interface Box {
  /** Left edge. */
  readonly x0: number;
  /** Top edge. */
  readonly y0: number;
  /** Right edge. */
  readonly x1: number;
  /** Bottom edge. */
  readonly y1: number;
}

/**
 * The CSS transform that turns an upright layer the size of the unturned page onto a
 * page box turned by `rotation`, about its top-left corner so every edge stays on a
 * whole pixel — rotating about the centre puts them on half pixels whenever the
 * box's width and height differ by an odd number.
 */
export function uprightTransform(
  box: { width: number; height: number },
  rotation: Rotation,
): string {
  const at = {
    0: '0px, 0px',
    90: `${box.width}px, 0px`,
    180: `${box.width}px, ${box.height}px`,
    270: `0px, ${box.height}px`,
  };
  return `translate(${at[rotation]}) rotate(${rotation}deg)`;
}

/** `rect`, in a page box turned by `rotation`, mapped back into the upright layer. */
export function uprightBox(
  rect: Box,
  box: { width: number; height: number },
  rotation: Rotation,
): Box {
  const { x0, y0, x1, y1 } = rect;
  const { width: w, height: h } = box;
  switch (rotation) {
    case 0:
      return rect;
    case 90:
      return { x0: y0, y0: w - x1, x1: y1, y1: w - x0 };
    case 180:
      return { x0: w - x1, y0: h - y1, x1: w - x0, y1: h - y0 };
    case 270:
      return { x0: h - y1, y0: x0, x1: h - y0, y1: x1 };
  }
}

/** One tile to show: what to render, and where its canvas goes in the layer. */
export interface TileSlot {
  /** Stable across scrolling, for a React key. */
  readonly key: string;
  /** The window of the page's render at the tile DPI, in its device pixels. */
  readonly tile: {
    /** From the page's left edge. */
    x: number;
    /** From the page's top edge. */
    y: number;
    /** Across. */
    width: number;
    /** Down. */
    height: number;
  };
  /** Where it sits in the upright layer, in CSS pixels. */
  readonly box: Box;
}

/**
 * The tiles of a page at `dpi` that `view` touches, nearest the middle of the view
 * first: the order a viewer should queue them in. None ahead of the view — each tile
 * costs about what the whole page does until the renderer culls, so a ring around
 * a 2x2 view would quadruple the work for tiles that may never be seen.
 *
 * `layerWidth` is the upright page's CSS width and `view` is in the same space.
 */
export function tileSlots(
  page: Size,
  dpi: number,
  layerWidth: number,
  view: Box,
): TileSlot[] {
  const scale = dpi / 72;
  const full = {
    x: Math.floor(page.width * scale),
    y: Math.floor(page.height * scale),
  };
  // CSS pixels per tile pixel; the layer is the unfloored page, as the bitmap's box is.
  const k = layerWidth / (page.width * scale);
  const span = TILE_SIZE * k;
  const cols = Math.ceil(full.x / TILE_SIZE);
  const rows = Math.ceil(full.y / TILE_SIZE);
  if (view.x1 <= view.x0 || view.y1 <= view.y0 || !cols || !rows) return [];

  const clamp = (n: number, count: number) =>
    Math.min(count - 1, Math.max(0, n));
  const c0 = clamp(Math.floor(view.x0 / span), cols);
  const c1 = clamp(Math.ceil(view.x1 / span) - 1, cols);
  const r0 = clamp(Math.floor(view.y0 / span), rows);
  const r1 = clamp(Math.ceil(view.y1 / span) - 1, rows);
  const mid = { x: (view.x0 + view.x1) / 2, y: (view.y0 + view.y1) / 2 };
  const slots: (TileSlot & { distance: number })[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const x = c * TILE_SIZE;
      const y = r * TILE_SIZE;
      // Each tile runs on under its neighbour by TILE_OVERLAP: where the page box
      // sits at a fractional device pixel, as it does at DPR 1.25, two tiles that
      // merely meet both half-cover the pixel on their seam and the backdrop shows
      // through it as a hairline. Snapping edges cannot fix that; covering it does.
      const width = Math.min(TILE_SIZE + TILE_OVERLAP, full.x - x);
      const height = Math.min(TILE_SIZE + TILE_OVERLAP, full.y - y);
      const box = {
        x0: x * k,
        y0: y * k,
        x1: (x + width) * k,
        y1: (y + height) * k,
      };
      slots.push({
        key: `${c},${r}`,
        tile: { x, y, width, height },
        box,
        distance: Math.hypot(
          (box.x0 + box.x1) / 2 - mid.x,
          (box.y0 + box.y1) / 2 - mid.y,
        ),
      });
    }
  }
  return slots.sort((a, b) => a.distance - b.distance);
}

/** A scale as a percentage a reader would recognise: `125%`. */
export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** `?zoom=` accepts a percentage (`150`), a ratio (`1.5`) or a fit mode. */
export function parseZoom(value: unknown): ZoomSpec | undefined {
  if (isFitMode(value)) return value;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return clampZoom(n > MAX_ZOOM ? n / 100 : n);
}
