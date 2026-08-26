---
"@build-qube/papyra-native": patch
---

Declare the wasm flavour as an optional dependency of the root binding package.

napi omits it by default so Node consumers do not download a wasm binary they
will never load. papyra publishes `browser.js`, which re-exports that package by
name, so the default left browser bundlers with an unresolvable import.
