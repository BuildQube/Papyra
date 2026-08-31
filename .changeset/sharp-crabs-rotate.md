---
'@build-qube/papyra-native': minor
'@build-qube/papyra': minor
---

Add a rotated-view viewport and an annotation switch.

- `viewport(pageSize, { fitWidth, dpi, rotation })` resolves scale and rotation
  together and hands back the `dpi` to render at. Pages still render unrotated — the
  engine has no transform knob, and a canvas turns a bitmap in the draw call for free —
  so `paintToCanvas(page, canvas, { rotation })` applies the turn while painting.
  `rotatePage` shuffles the buffer for the paths with no canvas, such as writing a
  rotated PNG from Node.
- `viewportRect` and `viewportQuad` put link rectangles and text quads into the
  viewport's space, superseding `scaleRect` and `scaleQuad` for anything drawn over a
  rotated view. Quarter turns keep a rect axis-aligned and keep a quad's corner order,
  so a highlight on rotated text stays at the text's own angle.
  Size through the viewport rather than passing `fitWidth` to `render` directly: turned,
  the width on screen is the page's height, and the two otherwise disagree.
- `rotateSize` gives a page's dimensions after a rotation, still in points. Separate
  from `viewport` because a layout needs it before a scale exists, and a viewport's
  pixel dimensions are floored to match the renderer's.
- `RenderOptions.annotations` and `SvgOptions.annotations` turn off the drawing of
  annotation appearance streams — links, highlights, stamps, filled form fields — which
  a viewer painting its own link or highlight layer needs, or every annotation appears
  twice. On by default, honoured by every raster path and by `renderSvg`, and part of
  the render cache key so flipping it re-renders rather than returning the page you
  already had.

  A boolean rather than pdf.js's four-way `annotationMode`: that is the whole of what
  the engine exposes, and the modes it has no answer for concern writing form values
  back.
