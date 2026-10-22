---
'@build-qube/papyra': patch
---

A closed `Document` now refuses everything that reaches its queue or caches —
`indexText`, `renderImage`, `renderSvg`, `renderPages`, `pageSize` and the cache and
queue stats — with the same error `render` already threw. Previously these kept
working after `close()`, and `indexText` refilled the text cache it had just released.
Work still running when a document closes no longer writes its result into the
closed cache.
