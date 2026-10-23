---
'@workspace/pdf-viewer': minor
---

Deep zoom stays sharp in single-page mode too. The tile layer is now its own item,
`pdf-page-tiles`, and `pdf-viewer-basic` and `pdf-viewer-configurable` with
`view: 'page'` mount it over the stretched bitmap, as the continuous column already
did. A tile also hides when its page, document or annotation setting changes, so a
page turn no longer leaves the previous page's tiles over the new one.
