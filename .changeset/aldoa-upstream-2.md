---
'@workspace/pdf-viewer': patch
---

Full screen pads itself by the safe-area insets, so under `viewport-fit=cover` (iOS,
and Android edge-to-edge WebViews) the header no longer draws beneath the status bar
and home indicator. The class is exported as `FULLSCREEN_TAKEOVER` from
`use-fullscreen`, and both the file preview and the viewer apply it after a caller's
`className`, so a caller's padding cannot drop the insets.

In the continuous column, the fit modes fit the widest page rather than the one on
screen. The column is as wide as its widest page, so a document mixing page widths
had its wider pages cropped and its narrow ones pushed off-centre at `auto`. Narrow
pages now show a little smaller, and `auto` no longer changes as you scroll.
Single-page mode still fits the page it shows.
