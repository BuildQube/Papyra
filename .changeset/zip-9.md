---
"@build-qube/papyra-native": patch
"@build-qube/papyra-tauri": patch
---

Spreadsheets read through zip 9 (calamine 0.38), clearing the zip 8.x advisories:
the critical dual-header parser differential (fixed in 9.0.5) and the symlink,
ZIP64 and AES ones (fixed in 9.0.0). papyra never extracts an archive to disk, so
the symlink advisories did not apply, but every xlsx and ods it opens is
user-supplied. This reaches `papyra-tables` and `tauri-plugin-papyra` (feature
`tables`), which take the same version. Rendering is unchanged.
