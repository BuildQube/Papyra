import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const bindings = fileURLToPath(
  new URL('../../packages/bindings', import.meta.url),
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

export default defineConfig({
  plugins: [react(), perfSink],
  resolve: {
    alias: {
      // In the published package `browser.js` re-exports the per-platform wasm
      // package. In the monorepo that package does not exist until release, so point
      // at the generated glue directly.
      '@build-qube/papyra-native-wasm32-wasi': `${bindings}/papyra.wasi-browser.js`,
    },
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
