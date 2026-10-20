---
'@build-qube/papyra': minor
---

An engine's backend can declare `abortable`: then a render that has started is
aborted, through the signal `renderPage` receives, once nobody waits for it any more.
papyra's own backend does not declare it, since its renders cannot stop part-way,
so a started render the reader scrolls back to is still joined rather than repeated.
`SchedulerJob` gains the same `abortable` flag and passes `run` a signal.

`fingerprint` and `toBytes` are exported from `@build-qube/papyra/core`, for engines:
one that fingerprints with papyra's content hash gives a file the same key on every
engine.
