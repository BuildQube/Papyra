/**
 * Render by output width rather than DPI: 150 DPI is 6300x4500 (113 MB) for an ARCH-E
 * drawing, all of it thrown away by a ~900px-wide viewport.
 *
 * Shared by both routes so the canvas and encoded-image paths render the same pixels,
 * which is the only way their timings compare honestly.
 */
export function defaultViewWidth(): number {
  return Math.min(
    2000,
    Math.round(window.screen.width * (window.devicePixelRatio || 1)),
  );
}
