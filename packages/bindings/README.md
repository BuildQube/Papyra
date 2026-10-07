# @build-qube/papyra-native

The compiled core of [papyra](https://www.npmjs.com/package/@build-qube/papyra):
Node-API bindings over a Rust PDF renderer, built as a native addon per platform
and as a wasm module for the browser.

**You almost certainly want [`@build-qube/papyra`](https://www.npmjs.com/package/@build-qube/papyra)
instead.** It depends on this package, and it is where the API lives — the
scheduler, the render cache, `fitWidth`, outlines, text and search, canvas
painting. This package is a deliberately thin surface beneath it, and its shape
is not a stable public API.

```bash
npm install @build-qube/papyra
```

The platform binaries (`@build-qube/papyra-native-darwin-arm64`,
`-linux-x64-gnu`, `-wasm32-wasi`, …) are optional dependencies of this package;
your package manager installs the one that matches. The browser build needs
cross-origin isolation — see the papyra README.

Source and documentation: <https://github.com/BuildQube/papyra>
