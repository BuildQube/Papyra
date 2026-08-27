---
"@build-qube/papyra": minor
"@build-qube/papyra-native": minor
---

Add `doc.outline()` — the document outline (bookmarks) as a tree.

hayro defines the `/Outlines` key but never reads it, so papyra walks the object graph
itself. Explicit destination arrays, name trees, the legacy `/Dests` catalog dictionary
and `GoTo` actions all resolve to a page index plus the destination's view (`XYZ`,
`FitH`, …); `GoToR` and `URI` point outside the document and surface as `dest: null`,
as do containers that group children without a destination of their own. Both are kept
rather than dropped, since removing a container would reparent its children.

Cyclic `/Next` and `/Kids` chains — which real files do contain — terminate rather than
hang. Titles are decoded from UTF-16, UTF-8 or PDFDocEncoding; the last of these
matters because em and en dashes live exactly where PDFDocEncoding and Latin-1 disagree.

The walk runs off the event loop and the result is memoised per document.
