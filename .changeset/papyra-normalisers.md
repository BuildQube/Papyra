---
'@build-qube/papyra': patch
---

`toPageText`, `toPageLink`, `toAttachment` and `rethrowLoadError` are exported from
`@build-qube/papyra/core`, for an engine whose host answers in the native bindings'
shapes — as `tauri-plugin-papyra` does — so it normalises exactly as papyra does.
