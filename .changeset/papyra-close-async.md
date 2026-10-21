---
'@build-qube/papyra': minor
---

`engine.close(doc)` and `Document.close()` return a promise, settled once the backend
has let go and rejected if it could not; a backend's `close` may be async. The handle
is closed the moment `close` returns, and a document that is not open still throws
at once.
