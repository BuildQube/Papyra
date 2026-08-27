// Preloaded by `bun run coverage` (never by `bun test` itself), purely to widen the
// coverage denominator.
//
// Bun's lcov output only lists files some test actually imported, so a module nobody
// touches is not 0% — it is absent, and the percentage is computed over the rest.
// Before this, `bun test test/unit` reported on 6 of the 13 files in src/, silently
// leaving out document.ts, the largest one. Importing the package entrypoint pulls in
// every module the package exports, so untested code lands in the denominator as the
// 0% it is.
//
// index.ts re-exports canvas.ts, which is browser-only. That is fine to import under
// Bun: it declares functions and touches no DOM global at module scope.
import './../src/index.js';
