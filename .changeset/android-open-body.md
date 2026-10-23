---
'@build-qube/papyra-tauri': patch
---

`tauri-plugin-papyra` opens files on Android. Tauri never uses its custom-protocol
IPC there, so `open`, `openTiff` and `openWorkbook` arrived as a JSON array of bytes
and were refused with "this command takes the file's bytes as the request body".
