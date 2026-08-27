---
'@build-qube/papyra-native': minor
'@build-qube/papyra': minor
---

Add encoded image output: WebP, PNG and JPEG.

`doc.renderImage(page, opts)` returns a `PageImage` that encodes on demand and never
hands the raw bitmap to JS — for export, that buffer is pure overhead. `encode(page,
opts)` encodes a `RenderedPage` you already hold. Both yield an `EncodedImage` with
`bytes`, `toBlob()`, `toBlobUrl()` and `toDataUrl()`.

Every encoder is pure Rust, so the browser build still needs no C toolchain. Lossless
WebP is the default: across the test corpus it is ~3x smaller than PNG for about the
same encode time. JPEG is the only lossy option and the only one that takes a `quality`.

Raw RGBA output, `paintToCanvas` and the render cache are unchanged.
