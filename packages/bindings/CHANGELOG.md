# @build-qube/papyra-native

## 0.0.4

## 0.0.3

### Patch Changes

- 4fb8f70: Declare the wasm flavour as an optional dependency of the root binding package.
  
  napi omits it by default so Node consumers do not download a wasm binary they
  will never load. papyra publishes `browser.js`, which re-exports that package by
  name, so the default left browser bundlers with an unresolvable import.

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
