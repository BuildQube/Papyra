# @build-qube/papyra-office-native

## 0.6.0

## 0.5.0

### Minor Changes

- 23670dd: First release on npm: the office addon `@build-qube/papyra/office` loads, with its
  six platform packages (`-darwin-arm64`, `-darwin-x64`, `-linux-x64-gnu`,
  `-linux-arm64-gnu`, `-win32-x64-msvc`, `-wasm32-wasi`), on the same version as the
  rest of papyra.

### Patch Changes

- 64531eb: The engines and Tauri setup docs move to guide pages on the doc site,
  https://buildqube.github.io/Papyra/docs/guides/engines and
  https://buildqube.github.io/Papyra/docs/guides/tauri. The READMEs link there instead
  of repeating them; the `tauri-plugin-papyra` crate's README does the same.
- eb23a56: Document engines — choosing one, installing it, scoping it into the viewer, and when
  to import `/core` — and that a panic in the browser build is fatal until reload. Add a
  README for `@build-qube/papyra-office-native`.
