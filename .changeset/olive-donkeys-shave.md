---
"@build-qube/papyra": patch
"@build-qube/papyra-native": patch
---

Move the build toolchain to TypeScript 7.

Build tooling only: the emitted `.js` and `.d.ts` are byte-identical to the previous
TypeScript 5.9 output (only source map mappings differ), so there is no change to the
published API or to runtime behaviour.
