---
'@build-qube/papyra': minor
'@build-qube/papyra-native': minor
---

TIFF: `openTiff()` reads single- and multi-page TIFFs, classic or BigTIFF, in Rust, on both runtimes.

```ts
const tiff = await openTiff(file);
tiff.pages[0]; // { width: 13200, height: 10200, dpi: { x: 300, y: 300 }, compression: 'ccitt-g4', … }
const page = await tiff.renderPage(0, { maxWidth: 1600 });
paintToCanvas(page, canvas);
```

- **Fax coding** — CCITT Group 4, Group 3 (1D and 2D) and Modified Huffman, which is
  what scanned drawings use — through `hayro-ccitt`, the decoder hayro already ships
  for PDF. Also uncompressed, LZW, Deflate, PackBits and JPEG, in grey, RGB and CMYK
  at 1 to 16 bits, in strips or tiles. Palette colour and old-style JPEG are listed
  and refuse to render, by name.
- **Decoded straight to a capped size.** A page is never held whole: rows are
  box-filtered into the output as they decode, so a 300-dpi E-size sheet (135 MP)
  becomes a 16 MP preview in about 80 ms natively, with a peak of the output plus
  one row. `TIFF_MAX_PIXELS` (4096²) is the default cap; `maxPixels` and `maxWidth`
  lower it.
- `Orientation` is applied, reduced-resolution directories (thumbnails, pyramid
  levels) are not counted as pages, and a damaged strip leaves the rows before it.
- A rendered page is a `RenderedPage`, so `paintToCanvas` and `encode` take it
  unchanged.
