---
'@workspace/pdf-viewer': minor
---

`FileActionsProvider` takes `onDownload`, for a host that has to own the download:
the preview's button calls it with the file's source instead of saving the file
itself. The file preview and the viewer set `data-fullscreen` while full screen, and
Escape pressed inside one ends full screen even when a host dialog has cancelled its
own dismissal, so a dialog can hold the viewer without scraping its exit button.

The sidebar starts closed on a one-page document, and its resize grip is hidden
while it is closed. The thumbnail header says "1 page". The pager's input takes the
height of the arrows beside it, whatever a style makes `icon-sm`. Nothing calls
ES2023 library APIs any more, and the package typechecks against ES2022 to keep it so.
