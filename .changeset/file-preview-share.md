---
'@workspace/pdf-viewer': minor
---

The file preview can share a file instead of downloading it, for iOS WKWebView
hosts, where `<a download>` does nothing.

- New `file-preview-actions` item, which `file-preview` now depends on.
  `<FileActionsProvider share>` makes the download button a Share button that opens
  the system share sheet (Save to Files, Print, other apps) when
  `navigator.canShare({ files })` says yes and the file is already in hand;
  otherwise, or when sharing fails, it downloads. Cancelling the sheet is not an
  error.
- Without a provider nothing changes: the button downloads, as before.
- `heldFile` in `file-preview-core`'s source module returns a source's bytes when
  they are already in hand, without downloading.
