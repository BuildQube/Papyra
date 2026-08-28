// Preloaded by `bun run coverage` (never by `bun test` itself). It does two things,
// both of which exist only to stop the report quietly under-counting.
//
// 1. Widen the denominator. Bun's lcov output only lists files some test actually
//    imported, so a module nobody touches is not 0% — it is absent, and the
//    percentage is computed over the rest. Before this, `bun test test/unit` reported
//    on 6 of the 13 files in src/, silently leaving out document.ts, the largest one.
//    Importing the package entrypoint pulls in every module the package exports, so
//    untested code lands in the denominator as the 0% it is.
//
//    index.ts re-exports canvas.ts, which is browser-only. That is fine to import
//    under Bun: it declares functions and touches no DOM global at module scope.
//
// 2. Flush the Rust coverage counters before the process goes away. The instrumented
//    addon dumps them from an atexit handler registered at dlopen, and Bun on Linux
//    leaves the process without running it — this whole stage contributed 532 covered
//    lines on macOS and 0 in CI, reporting the outline and text paths as dead code
//    while their own tests passed in that same job.
import { afterAll } from 'bun:test';
import './../src/index.js';

afterAll(async () => {
  // Present only in a coverage build, and typed nowhere, since the napi .d.ts is
  // generated from whichever build ran last. Absent is the normal case, not an error.
  const native: Record<string, unknown> = await import(
    '@build-qube/papyra-native'
  );
  const flush = native.__writeCoverageProfile;
  if (typeof flush === 'function') flush();
});
