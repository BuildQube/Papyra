---
"@workspace/pdf-viewer": patch
---

Every item now declares `@build-qube/papyra@^0.6.0` (and
`@build-qube/papyra-office-native@^0.6.0`). The TIFF and sheet items alone had
moved to 0.6, so installing either beside any other item resolved papyra to 0.5.0
and failed to compile on `Workbook.close()` and `TiffImage<P>`.
