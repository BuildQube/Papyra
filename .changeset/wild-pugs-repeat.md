---
'@build-qube/papyra-native': minor
'@build-qube/papyra': minor
---

Add links, metadata, page labels, a document fingerprint, and typed password errors.

- `doc.links(index)` reports link annotations — a rectangle, a target, and the
  annotation's tooltip. Rectangles are in the same 72-DPI top-left space as extracted
  text, so a hit region lands on its own glyphs even on a rotated page; `scaleRect`
  takes it to any render. Targets are a discriminated union of an internal destination
  and a URI, and links that resolve to nothing actionable are dropped rather than
  handed over as regions that swallow clicks. Reading them does not go through the
  priority queue.
- `doc.metadata` reads the information dictionary synchronously, with dates converted
  to ISO 8601.
- `doc.pageLabels()` resolves the number printed on each page — roman front matter,
  prefixes, letter sequences — and is empty when the document defines none, so a caller
  can tell that from a document asking for plain numbering.
- `doc.pdfVersion` reports the specification version the file declares, resolving the
  catalog's `/Version` over the header the way the spec asks for.
- `doc.fingerprint` is a stable sixteen-character key for per-document state. It hashes
  the file rather than reading `/ID`, which the engine exposes no way to reach.
- `open()` now throws `PasswordRequiredError` when a document is encrypted and no
  password was given, and `IncorrectPasswordError` when one was given and rejected.
  Both extend `PasswordError`, which carries a `retry` flag. Previously both surfaced
  as an untyped parse failure.
