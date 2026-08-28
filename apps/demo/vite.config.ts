import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const bindings = fileURLToPath(
  new URL('../../packages/bindings', import.meta.url),
);

const viewerSrc = fileURLToPath(
  new URL('../../packages/pdf-viewer/src/', import.meta.url),
);

/**
 * papyra's wasm build uses shared memory (napi-rs generates
 * `new WebAssembly.Memory({ shared: true })`), so the page must be cross-origin
 * isolated or `SharedArrayBuffer` is unavailable and the module will not start.
 */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Lets the perf probe report back over HTTP, so it can be run in a plain headless
 * browser with no debugger attached — an attached debugger can suppress JIT tiering
 * and make wasm measurements meaningless.
 */
const perfSink = {
  name: 'perf-sink',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use('/__perf', (req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c;
      });
      req.on('end', () => {
        console.log(`\n===PERF===\n${body}\n===END===`);
        res.statusCode = 204;
        res.end();
      });
    });
  },
};

/**
 * GitHub Pages serves static files and cannot set response headers, so the real
 * COOP/COEP above are unavailable there — and without cross-origin isolation
 * `SharedArrayBuffer` does not exist and the wasm module never starts.
 *
 * coi-serviceworker is the standard escape hatch: a service worker that
 * re-serves every response with the isolation headers attached. The first visit
 * registers it and reloads once; from then on the page is isolated.
 *
 * Build-only. `vite dev` and `vite preview` send the headers for real, and
 * injecting a second mechanism there would just hide breakage in the real one.
 */
const COI_FILENAME = 'coi-serviceworker.min.js';

const coiServiceWorker: Plugin = {
  name: 'coi-service-worker',
  apply: 'build',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: COI_FILENAME,
      source: readFileSync(
        createRequire(import.meta.url).resolve(
          `coi-serviceworker/${COI_FILENAME}`,
        ),
      ),
    });
  },
  transformIndexHtml() {
    return [
      {
        tag: 'script',
        // Relative so it resolves under whatever `base` the site is served
        // from, and head-prepended so the reload happens before the app loads.
        attrs: { src: `./${COI_FILENAME}` },
        injectTo: 'head-prepend',
      },
    ];
  },
};

/**
 * Client-side routing needs the SPA served for paths that are not real files.
 *
 * In-app navigation is fine anywhere, but a *fresh request* for `/export` — a refresh,
 * a bookmark, a shared link — makes GitHub Pages look for a file that Vite never
 * emitted. Pages serves `404.html` for any unmatched path, so a byte-for-byte copy of
 * the built `index.html` boots the app and lets the router read the real pathname.
 *
 * Copied in `closeBundle` rather than emitted: by then index.html has been through
 * asset hashing and the coi-serviceworker injection above, and this must match it
 * exactly.
 */
const spaFallback: Plugin = {
  name: 'spa-fallback-404',
  apply: 'build',
  closeBundle: {
    order: 'post',
    handler() {
      const dir = resolvedOutDir;
      const index = join(dir, 'index.html');
      if (existsSync(index)) copyFileSync(index, join(dir, '404.html'));
    },
  },
  configResolved(config) {
    resolvedOutDir = resolve(config.root, config.build.outDir);
  },
};

let resolvedOutDir = 'dist';

export default defineConfig({
  // GitHub Pages serves the project site from /<repo>/, so the deploy workflow
  // sets PAPYRA_BASE. Local dev and previews stay at the root.
  base: process.env.PAPYRA_BASE ?? '/',
  plugins: [react(), tailwindcss(), perfSink, coiServiceWorker, spaFallback],
  resolve: {
    /*
     * `@/` means the registry package, not this app — the files in
     * `packages/pdf-viewer` are byte-identical to what `shadcn add` installs, and the
     * only import forms that CLI rewrites are these canonical aliases. Vite matches
     * this array in order, so the two `@/components/ui` and `@/lib/utils` entries
     * must precede the broader ones.
     */
    alias: [
      {
        find: /^@\/components\/ui\//,
        replacement: fileURLToPath(
          new URL('../../packages/ui/src/components/', import.meta.url),
        ),
      },
      {
        find: '@/lib/utils',
        replacement: fileURLToPath(
          new URL('../../packages/ui/src/lib/utils', import.meta.url),
        ),
      },
      {
        find: /^@\/(components|hooks|lib)\//,
        replacement: `${viewerSrc}$1/`,
        /*
         * A block names its siblings `@/components/…` because that is where
         * `shadcn add` puts every item in a consumer — but here the blocks sit in
         * `src/blocks/`. Alias entries are first-match-wins with no fallback, so
         * the fallback lives here: the `components/` path, then the same file
         * under `blocks/`, then plugin-alias's own default so an unresolvable
         * import still reports the real path rather than the alias.
         */
        async customResolver(id, importer, options) {
          const opts = { skipSelf: true, ...options };
          const inBlocks = id.replace(
            `${viewerSrc}components/`,
            `${viewerSrc}blocks/`,
          );
          return (
            (await this.resolve(id, importer, opts)) ??
            (inBlocks === id
              ? null
              : await this.resolve(inBlocks, importer, opts)) ?? { id }
          );
        },
      },
      {
        // In the published package `browser.js` re-exports the per-platform wasm
        // package. In the monorepo that package does not exist until release, so point
        // at the generated glue directly.
        find: '@build-qube/papyra-native-wasm32-wasi',
        replacement: `${bindings}/papyra.wasi-browser.js`,
      },
    ],
  },
  // The glue loads the .wasm via `new URL(..., import.meta.url)`; leave it alone.
  optimizeDeps: {
    exclude: ['@build-qube/papyra', '@build-qube/papyra-native'],
  },
  server: {
    headers: crossOriginIsolation,
    // Allow serving the generated wasm from packages/bindings.
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
  },
  preview: { headers: crossOriginIsolation },
  worker: { format: 'es' },
  // napi-rs's generated wasi glue uses top-level await; esbuild only allows that at
  // esnext with an ES module output.
  esbuild: { target: 'esnext' },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        perf: fileURLToPath(new URL('perf.html', import.meta.url)),
      },
    },
  },
});
