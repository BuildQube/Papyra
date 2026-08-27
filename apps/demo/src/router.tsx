import type { EncodedFormat } from '@build-qube/papyra';
import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { parseZoom, type ZoomSpec } from './lib/zoom.js';
import { BenchRoute } from './routes/bench.js';
import { DocsRoute } from './routes/docs.js';
import { ExportRoute } from './routes/export.js';
import { RootShell } from './routes/root.js';
import { ViewerRoute } from './routes/viewer.js';

/**
 * Search params are typed and validated here rather than parsed ad hoc at module
 * scope, which is what the demo used to do — meaning they were read once and could not
 * change without a full reload.
 */
const positive = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const bounded = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

const FORMATS = new Set<EncodedFormat>(['webp', 'png', 'jpeg', 'svg']);

// Declared with optional keys, not `key: T | undefined`. A required-but-undefined key
// would force every `<Link search={prev => prev}>` to restate the whole shape.
interface RootSearch {
  file?: string;
  page?: number;
}
interface ViewerSearch {
  width?: number;
  thumbs?: boolean;
  probe?: number;
  zoom?: ZoomSpec;
  view?: 'page' | 'scroll';
}
interface ExportSearch {
  format?: EncodedFormat;
  quality?: number;
  width?: number;
}

const rootRoute = createRootRoute({
  component: RootShell,
  // `page` lives on the root so both views inherit it: /export?page=7&format=jpeg
  // reproduces exactly what you were looking at.
  validateSearch: (search: Record<string, unknown>): RootSearch => ({
    file: typeof search.file === 'string' ? search.file : undefined,
    page: positive(search.page),
  }),
});

const viewerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: ViewerRoute,
  validateSearch: (search: Record<string, unknown>): ViewerSearch => ({
    width: positive(search.width),
    thumbs: search.thumbs === undefined ? undefined : search.thumbs !== false,
    probe: positive(search.probe),
    zoom: parseZoom(search.zoom),
    view: search.view === 'scroll' ? 'scroll' : undefined,
  }),
});

const exportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/export',
  component: ExportRoute,
  validateSearch: (search: Record<string, unknown>): ExportSearch => ({
    format: FORMATS.has(search.format as EncodedFormat)
      ? (search.format as EncodedFormat)
      : undefined,
    quality: bounded(search.quality, 1, 100),
    width: positive(search.width),
  }),
});

const benchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/bench',
  component: BenchRoute,
});

// No `validateSearch`: the reference is addressed by fragment, and the root route's
// `file`/`page` params are carried through by the nav so leaving /docs returns you to
// the document you had open.
const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/docs',
  component: DocsRoute,
});

const routeTree = rootRoute.addChildren([
  viewerRoute,
  exportRoute,
  benchRoute,
  docsRoute,
]);

export const router = createRouter({
  routeTree,
  // The demo builds under `base: process.env.PAPYRA_BASE` for GitHub Pages. Without
  // this the router never matches a pathname prefixed with e.g. `/papyra/`.
  basepath: import.meta.env.BASE_URL,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
