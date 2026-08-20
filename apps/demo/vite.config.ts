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

export default defineConfig({
  plugins: [react()],
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
  build: { target: 'esnext' },
});
