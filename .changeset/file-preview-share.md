---
'@workspace/pdf-viewer': minor
---

The file preview shares on platforms that can take a file, iOS WKWebView included.

- Its download button becomes Share, and opens the system share sheet (Save to
  Files, Print, other apps), when `navigator.canShare({ files })` says yes and the
  file is already downloaded. Otherwise it downloads as before. Cancelling the sheet
  is not an error.
- New `file-preview-actions` item, which `file-preview` now depends on:
  `FileActionsProvider` replaces `canShare`, `share` or `download` for every
  preview below it — for an app with its own share — and `webFileActions` is the
  default.
- `heldFile` in `file-preview-core`'s source module returns a source's bytes when
  they are already in hand, without downloading.
