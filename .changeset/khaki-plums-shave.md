---
'@build-qube/papyra-native': minor
'@build-qube/papyra': minor
---

Export pages as SVG.

`doc.renderSvg(page)` returns vector output — paths stay paths and text stays glyph
outlines — via hayro's own `hayro-svg` converter. It is not an encoding of a bitmap, so
it takes no `dpi`, `fitWidth` or `quality`; the only option beyond scheduling is
`background: 'white' | 'transparent'`. `doc.svgHandle()` gives the handle, for priority,
cancellation and timing, exactly as `imageHandle` does for raster export.

The returned `SvgPage` is an `EncodedImage` — `bytes`, `toBlob()`, `toBlobUrl()`,
`toDataUrl()` — plus `markup`, since inlining an SVG is more common than handing a
browser a URL.

`EncodedFormat` now includes `'svg'`, and `EncodeOptions.format` narrows to the new
`RasterFormat` (`'webp' | 'png' | 'jpeg'`): a `PageImage` holds pixels and can never
produce an SVG, so the type now says that.
