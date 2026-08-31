---
'@workspace/pdf-viewer': minor
---

Show a tagged PDF's structure, and the reading order it declares.

A new `Structure` panel joins the sidebar as a fourth tab, in two views. **Tags** is
the document's own account of itself — a collapsible tree of `H1`, `P`, `Table`, `TD`
and the rest — and picking a node outlines that element's content on the page, through
the same quad overlay search highlights use, so it stays correct on a rotated view.
**Reading order** lists the current page's lines in the order the document declares,
against the order the page draws them, and says how many move.

That count is the reason the panel exists. `pageText` reports content-stream order,
which a two-column page is free to interleave, and no line grouping recovers the
author's intent from it. On the demo's own `160F-2019.pdf`, 103 of 112 lines move.

- `Highlights` takes an optional `regions`, drawn outlined in the accent colour rather
  than filled, so a selected element reads as a selection rather than a third kind of
  search hit and stays legible over one.
- The store carries the selection in a `structure` slice, lifted for the reason search
  is: the panel knows which element, and the page overlay is what draws it.
  `ContinuousPages` takes it as a prop and `usePdfStructure` reads it.
- A tab whose panel is empty now dims its label instead of appending a marker. Four
  tabs plus two markers overflow the 240px column, and a document with neither an
  outline nor a structure tree shows both.

The panel is empty for an untagged document, which is the common case and says so.
