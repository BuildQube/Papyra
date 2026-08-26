---
'@build-qube/papyra-native': minor
'@build-qube/papyra': minor
---

Add `Document.imageHandle()`, the handle-returning form of `renderImage`.

`render()` has always returned a handle you can reprioritise, cancel, and read
`timing` from, while `renderPage()` returns the promise. The export path only had the
promise form, so a queued encode could not be reprioritised or cancelled by handle, and
could not report how long it spent waiting versus rendering. `imageHandle()` closes
that gap; `renderImage()` is now `imageHandle(...).promise`.
