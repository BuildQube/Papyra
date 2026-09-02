---
'@workspace/pdf-viewer': minor
---

Mobile handling for the viewer: a collapsible, resizable sidebar that becomes a drawer, and a toolbar with find and a more menu.

**Sidebar.** `ViewerLayout` puts it in a resizable column with a drag handle; drag
it below 180px and it collapses. A toggle at the leading edge of the toolbar row
opens and closes it. Below 768px of container width the column is replaced by a
bottom drawer holding the same panels, which closes itself when a page is picked.
The open state is a new `sidebar` slice on the viewer store, read through
`usePdfSidebar()` and written through `setSidebar` / `toggleSidebar`.

**Find.** New `pdf-find-bar` item: a toolbar button opening a popover with the
query, previous/next, match case and whole words, and ⌘F / Ctrl+F while focus is
inside the viewer. It owns the search; the sidebar's `Search` panel is now the
results list only, and takes `query` instead of `doc` / `onMatches`. The query is
a new `search.query` field on the store, written through `setQuery`, so the bar
outlives a drawer that unmounts. `Sidebar` takes `query` and drops `onMatches`.

**Panel picker.** `Sidebar` picks its panel from a menu rather than a tab strip,
which no longer fits once the column can be resized. Attachments joins Pages,
Outline, Tags and Search results; a panel the document does not have is a
disabled item rather than a dimmed tab.

**Thumbnails.** `Thumbnails` picks its column count from its width when
`columns` is not given — as many 160px tiles as fit — so a widened sidebar or a
full-width drawer shows a grid instead of one tile stretched across it, with no
re-render.

**More menu.** `ZoomBar` moves rotation, the annotation switch and the view mode
behind a more menu at every width, and gains `onProperties` for a "Document
properties…" item. Below 768px of container width it also hides the zoom steppers
and the page label and shortens the zoom readout; the keyboard hint is hidden on
coarse pointers and narrow containers.

**Full screen.** A toggle at the trailing edge of the toolbar row takes the
viewer over the window and, where the browser allows it, puts the page into
fullscreen — the page rather than the viewer, so the menus and the drawer that
portal to `body` stay visible. On iOS, which allows fullscreen for video only,
the takeover alone applies. Escape exits. `ViewerLayout` takes `fullscreen`
to turn the toggle off.

`PdfViewerProvider` now forwards every store option, not only `concurrency`.

Requires the official `drawer`, `dropdown-menu`, `popover`, `resizable` and
`toggle` items.
