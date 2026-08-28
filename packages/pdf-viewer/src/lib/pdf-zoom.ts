import type { PageSize } from '@build-qube/papyra';

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
  return ZOOM_STEPS.findLast((step) => step < zoom - 1e-4) ?? MIN_ZOOM;
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
  page: PageSize | null,
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
export function pageBox(page: PageSize, zoom: number): Viewport {
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
export function renderWidth(page: PageSize, zoom: number): number {
  const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
  const want = Math.max(1, Math.round(page.width * CSS_UNITS * zoom * dpr));
  if (page.width <= 0 || page.height <= 0) return want;
  const cap = Math.max(
    1,
    Math.floor(Math.sqrt((MAX_RENDER_PIXELS * page.width) / page.height)),
  );
  return Math.min(want, cap);
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
