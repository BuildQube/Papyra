---
'@build-qube/papyra': minor
---

Add `@build-qube/papyra/core`: everything that runs without the engine — painting,
page geometry, search over extracted text, outline and structure trees, the
priority queue, the error types — importable without loading the native module.

Importing the main entry loads the engine, which in a browser is a wasm module of
about 2.5 MB that needs a cross-origin-isolated page to start. Code that only draws
pages, or that will open documents through another engine, can import from `/core`
and fetch nothing until a document is opened. The main entry still exports all of
it, so no existing import changes.

`RenderHandle` now lives with the other shared types; it is exported from both
entries as before.
