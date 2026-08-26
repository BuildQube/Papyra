---
"@build-qube/papyra": minor
"@build-qube/papyra-native": minor
---

Add text extraction and search: `doc.pageText()`, `doc.search()`, `doc.indexText()`.

Extraction is built on `hayro_interpret::Device`, so encodings, `ToUnicode` cmaps, CID
and Type3 fonts and the graphics-state transform all arrive resolved. Coordinates come
from the same transform the renderer uses, so text lands in the same space as the
pixels — page rotation and crop box included — and scaling to a render is one multiply.

Glyphs are grouped into lines and word spaces are reconstructed from the gap between
each glyph's end and the next glyph's start; PDF encodes a word break as a position
change at least as often as it writes a space character.

`search()` streams matches as each page is read, in whatever page order the caller
gives — a viewer wants to search outward from the page on screen. Matching is case- and
diacritic-insensitive by default, expands ligatures, collapses whitespace, and runs
across line breaks, returning one quadrilateral per line a match covers. Geometry is
stored along the baseline rather than as rectangles, so rotated text gets a highlight at
its own angle.

`PageText.undecodedGlyphs` reports glyphs no encoding could map back to Unicode, which
separates "this page has no text" from "this page has text nothing can read".

Also: `Scheduler` is no longer parameterised by payload, so renders and text extraction
share one priority queue.
