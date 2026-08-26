# @build-qube/papyra

## 0.0.2

### Patch Changes

- 25382b1: Bump emnapi to 2.0.0-alpha.4 so the wasm target links on current Rust.
  
  `@napi-rs/cli` 3.8.6 unconditionally passes `--export=emnapi_create_env` and
  `--export=emnapi_delete_env` to `wasm-ld`. Those symbols exist in emnapi 2.x but
  not in 1.11.x, and from Rust 1.98 the bundled `rust-lld` treats exporting an
  undefined symbol as an error rather than ignoring it, so the wasm build failed to
  link. 2.0.0-alpha.4 is within the peer range `@napi-rs/cli` declares.
- 619e420: Move the build toolchain to TypeScript 7.
  
  Build tooling only: the emitted `.js` and `.d.ts` are byte-identical to the previous
  TypeScript 5.9 output (only source map mappings differ), so there is no change to the
  published API or to runtime behaviour.
- Updated dependencies [25382b1]
- Updated dependencies [619e420]
  - @build-qube/papyra-native@0.0.2
