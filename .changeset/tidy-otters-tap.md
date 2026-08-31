---
'@build-qube/papyra-native': minor
'@build-qube/papyra': minor
---

Read the structure tree of a tagged PDF, and put text into declared reading order.

- `doc.structTree()` walks `/StructTreeRoot` and resolves to a tree of `StructNode` —
  `role`, `content`, `alt`, `actualText`, `lang`, `title`, `children`. Empty for an
  untagged document, which is the common case and the signal to fall back to
  `pageText` alone. One walk per document, memoised, off the event loop.
  `buildStructTree` and `walkStructTree` are exported for the same reasons their
  outline counterparts are.
- `role` is resolved through the document's `/RoleMap`, so a file that tags its
  headings `Heading1` and maps that onto `H1` reports `H1`. Word, InDesign and Excel
  all emit such files, and matching the raw tag misses them; `rawRole` keeps the
  original where the custom name carries meaning the standard role flattens away.
- `TextLine.mcid` carries the marked-content id of a line's first glyph, which is what
  joins text to the tree. Absent on an untagged page, and for content the document
  left outside any marked-content sequence — running heads and page numbers, mostly.
- `readingOrder(text, tree)` puts a page's lines into the order the document declares,
  each paired with the element that claims it, and `structuredPageString` is the
  string form. This is the one ordering extraction cannot otherwise recover: `lines`
  is content-stream order, and a two-column page is free to draw its columns
  interleaved. Lines no element claims go last rather than being dropped, and an
  untagged page comes back untouched.

  Lines are still grouped by geometry, deliberately. Breaking a line where a `Span`
  starts would fragment a sentence around its own bold word and regress search, so a
  line is placed by the element that *starts* it — sound for ordering, and not a claim
  that every character in it belongs to that element.
