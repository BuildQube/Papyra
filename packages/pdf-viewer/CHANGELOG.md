# @workspace/pdf-viewer

## 0.3.0

### Minor Changes

- d9c30c4: Word renderer for the file preview.
  
  **`file-preview-docx`** shows `.docx`, `.docm`, `.dotx` and `.dotm` files, laid out by
  `docx-preview` (Apache-2.0) with `jszip`. That is about 55 KB gzipped, loaded only
  when a Word document is opened. The layout is approximate: text, tables, lists, headers,
  footers and pictures come through well, but floating shapes and complex sections do not,
  and the view says so under the document. Pages stay white in a dark theme and shrink to
  fit a narrow container. Text in a font the system lacks, such as Calibri or Aptos, falls
  back to a sans-serif rather than the browser's default serif.
  
  It matches files by name, as the spreadsheet renderer does, because a `.docx` has the
  same zip signature as an `.xlsx` or a `.zip`. The view then checks the package's
  content types. A renamed workbook or archive, or text named `.docx`, gets an error card
  with a download button instead of a broken render. A password-protected document gets
  a message saying so. Legacy `.doc` is not supported and falls through to the download
  card.
  
  The file is treated as untrusted:
  - The document renders inside a sandboxed iframe that cannot run scripts. A
    Content-Security-Policy there blocks all network access, so images and embedded fonts
    load only as `data:` URLs. This matters because `docx-preview` builds its stylesheet
    from the document's own values without escaping them, so a crafted file can inject
    CSS. That CSS now reaches only the frame and cannot load anything.
  - `altChunk` parts are not rendered. The library would otherwise put their HTML into a
    same-origin `<iframe srcdoc>`, scripts included. Elements that could embed or run
    content are dropped as they are created.
  - Links keep only `http`, `https`, `mailto` and `tel` targets, and open in a new tab
    with `rel="noopener noreferrer nofollow"`. A `javascript:` or relative target loses
    its `href`. A bookmark scrolls the frame without navigating it.
  - External pictures (`r:link`) and `INCLUDEPICTURE` fields are never fetched. WMF and
    EMF pictures, which no browser draws, are labelled instead.
- 9785966: Markdown renderer for the file preview, and a `fallback` flag for catch-all renderers.
  
  **`file-preview-markdown`** renders `.md` as GitHub-flavoured Markdown (tables, task
  lists, strikethrough) with `react-markdown` and `remark-gfm`, loaded only when a
  Markdown file is opened. It treats the file as untrusted:
  - It renders to React elements, never to an HTML string, and raw HTML in the file is
    dropped.
  - A link with a `javascript:` or `data:` target loses it. Links open in a new tab
    with `rel="noopener noreferrer nofollow"`.
  - Remote images stay hidden until the reader asks for them, as a mail client does.
    Inline `data:image` sources show.
  
  Leading YAML front matter is shown as a block, and a Rendered / Source toggle sits
  above the document. Files over 1 MB show as source. Tables use the shadcn `Table`.
  
  **`fallback`.** A renderer with `fallback: true` is asked only when no other matches
  a file by any rule. `code` is now one, and also claims `.csv` and `.tsv`, so they show
  as text when no CSV renderer is installed.
  
  This changes one behaviour: `code` listed first no longer takes a file another
  renderer claims, such as `.md` from Markdown or `.json` from a JSON renderer. Between
  two ordinary renderers claiming the same extension, list order still decides.
- 514c183: File preview: spreadsheets and CSV, as two more renderer items.
  
  - **`file-preview-spreadsheet`** (`spreadsheetRenderer`, id `spreadsheet`) shows
    `.xlsx`, `.xlsm`, `.xlsb`, legacy `.xls` and `.ods`. Visible sheets become tabs,
    and the status line counts hidden ones instead of showing them. A
    password-protected workbook gets a card saying so, with no prompt, because
    there is nothing to decrypt it with.
  - **`file-preview-csv`** (`csvRenderer`, id `csv`) shows `.csv` and `.tsv`. The
    status line names the encoding and delimiter it guessed, so a wrong guess is
    visible rather than looking like broken data.
  - **`file-preview-sheet`** is the grid both of them install. It draws only the
    cells on screen, so a 100,000-row CSV keeps under a hundred cells in the DOM.
    Past a few million pixels of height the scrollbar maps proportionally, staying
    under the browser's cap on element size. Headers stick, merged cells span, and
    column widths are estimated from the first and last rows.
  
  Both renderers match by name. An `.xls` shares its container with `.doc` and an
  `.xlsx` with `.docx`, so claiming those signatures would also claim Word files.
  papyra sniffs the bytes again, so a `.xls` that is really a CSV still shows.
  
  Detection now prefers the most specific match: the extension, then an exact MIME
  type, then a wildcard. Before, `code`'s `text/*` would take a `text/csv` file
  whenever `code` was listed first. Windows with Excel installed reports `.csv`
  files as `application/vnd.ms-excel`, and the extension now wins over that.
  
  Both items need `@build-qube/papyra@^0.4.0`, the first release with `openWorkbook`.
- 8d89cb8: File preview: TIFF, as a renderer item.
  
  **`file-preview-tiff`** (`tiffRenderer`, id `tiff`) shows `.tif` and `.tiff` —
  scanned drawings and faxes — recognised by their header (`II*\0`, `MM\0*`, and
  BigTIFF's `II+\0`, `MM\0+`), never by name. papyra decodes each page off the main
  thread, CCITT Group 4 included, reduced to at most 4096 × 4096 while it decodes.
  A multi-page file gets the pager, and every page the image view's zoom, fit modes
  and rotation. 100% is the sheet's physical size when the file states a resolution,
  which also squares a fax's 204 × 196 dpi pixels. A page that will not decode says
  so in place, and the pager still reaches the others.
  
  Needs `@build-qube/papyra@^0.4.0` and a cross-origin isolated page, like the PDF
  and spreadsheet renderers.
- 838e7b4: File preview: a block for a list of mixed files, with each format a separate item, so a format you do not install costs no dependency.
  
  **Block.** New `file-preview` item. `createFilePreview([pdfRenderer, imageRenderer,
  codeRenderer])` returns a component whose `allow` prop accepts exactly the ids in
  that list: `allow={['docx']}` is a type error unless a `docx` renderer was passed,
  and two renderers sharing an id is one too. It shows one file at a time with a
  pager (← / → while focus is inside), a download button, and a card for a file no
  renderer recognises, a format `allow` leaves out, or a view that throws.
  
  **Renderers.** `file-preview-pdf` (papyra, with the password prompt),
  `file-preview-image` (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG, zoomed
  with the page viewer's own controls) and `file-preview-code` (shiki, on its JavaScript regex engine).
  Each is a small descriptor plus a view loaded by `import()`, so an installed
  format's dependency is still not fetched until a file of that type is shown.
  
  **Detection.** `file-preview-core` recognises a file by its bytes first. A PNG
  named `notes.txt` is an image, and an HTML page named `photo.png` is not one, so
  an `allow` list cannot be passed by renaming a file. Formats with no signature,
  such as source code, match by extension or MIME type, and are refused when the
  file's head contains a NUL byte. `acceptOf()` builds a file input's `accept` from
  the same list.
  
  **Sources.** `files` takes `File`s, URLs, and `{ key, url }` sources whose `url`
  may be an async function returning a URL, a `Blob` or a `Response`, for signed
  links that expire. A remote file is fetched when shown, kept in a byte-bounded
  LRU cache shared by every preview (256 MiB; pass `cache` for your own
  `FileCache`), and never fetched twice. A resolver is called only when the file
  is needed, and once more if the server answers 401 or 403. The next file is
  prefetched while the current one is read. A failed download says why: a
  network or CORS failure, a refused link, or a status. All of this lives in the
  new `file-preview-source.ts`, part of `file-preview-core`.
  
  **Streaming renderers.** A renderer declares `input: 'url'` to get a URL and a
  `refresh()` instead of a downloaded `File`, for media too large to fetch first.
  Its file is identified with a 512-byte `Range` request, not a download. A URL a
  resolver has answered with is reused for the next request on that key, so
  inspecting a file and then fetching it costs one signature, not two.
  
  **Video and audio.** New `file-preview-video` (MP4, MOV, WebM, Ogg Theora) and
  `file-preview-audio` (MP3, AAC, M4A, WAV, FLAC, Ogg) items stream through the
  browser's own elements and need no dependencies. If playback fails,
  `use-file-preview-media` asks for a fresh URL once and resumes at the same
  position, because a media element reports an expired link and an unsupported
  codec as the same error. AVI is deliberately not claimed: no browser plays it.
  
  **Zoom without the engine, renamed.** `pdf-zoom`, `use-pdf-zoom` and
  `pdf-zoom-bar` are now `viewer-zoom`, `use-viewer-zoom` and `viewer-zoom-bar`,
  since images use them too. Their exports are unchanged, but their install
  URLs are not, so anything installed under the old names should be re-added.
  They no longer depend on `@build-qube/papyra`. They imported only its
  `PageSize` and `Rotation` types, which `viewer-zoom` now declares itself as
  `Size` and `Rotation`, and papyra's values still fit.
  
  **Images** get the page viewer's zoom (⌘/ctrl-scroll, pinch, the keyboard, the
  fit modes) and rotation. They open at 100% when they fit and at "Image fit"
  when they do not. An SVG is sized from its own `width`/`height` or `viewBox`,
  not the browser's 150px default.
  
  `ZoomBar`'s `page`, `pageCount`, `label` and `onPage` are now optional. Leave
  out `onPage` and the pager is not rendered. `subject` renames the fit modes,
  so "Page fit" can read "Image fit".
  
  **Namespace.** Items install as `@papyra/<name>` after a one-time
  `npx shadcn@latest registry add @papyra=https://buildqube.github.io/Papyra/r/{name}.json`.
  Full URLs still work without it. Renderer items carry `meta.fileRenderer`
  (their id, export, label, and whether they match by name), which the docs
  site's format picker reads to build the install command, the dependency list
  and the `createFilePreview` setup file.
- b87c5c3: Every registry item now has a Radix flavour as well as a Base UI one.
  
  The namespace URL now carries `{style}`, which the shadcn CLI fills from the
  project's `components.json`. A Base UI project gets the Base UI items and a Radix
  project gets the Radix ones, from the same command:
  
  ```bash
  npx shadcn@latest registry add @papyra=https://buildqube.github.io/Papyra/r/{style}/{name}.json
  ```
  
  A project that registered the old `…/r/{name}.json` namespace keeps getting the
  Base UI items. Re-running the command above switches it. React Aria projects are not
  supported. The full URLs still work too: `r/` for Base UI and `r/radix/` for Radix.
  
  On Radix, the viewer's mobile drawer is sized to the open panel instead of a fixed 80%
  of the screen height.
  
  The find bar's "pages partly unreadable" badge now brings its own `TooltipProvider`.
  Under Radix, without a provider, it crashed the viewer on any document with unreadable
  text.
- d89c4cc: Mobile handling for the viewer: a collapsible, resizable sidebar that becomes a drawer, and a toolbar with find and a more menu.
  
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

### Patch Changes

- Updated dependencies [8d89cb8]
- Updated dependencies [514c183]
  - @build-qube/papyra@0.4.0

## 0.2.0

### Minor Changes

- b0f053c: Rotate the view, and switch the document's own annotations off.
  
  The toolbar gains rotate-left/rotate-right buttons and an annotations toggle, both
  optional: omit `onRotate` or `onAnnotations` and the control is not rendered, on the
  same principle as the existing view-mode toggle. `PdfViewer` and `PdfViewerBasic` wire
  them up, and the store carries the rotation and the switch alongside the view mode.
  
  Rotating costs no render. Pages still rasterise upright; the column re-flows from
  `rotateSize`, `paintToCanvas` turns the bitmap in the draw call, and `PageSurface`'s
  re-submission is a cache hit rather than new work.
  
  `Links` and `Highlights` now take a `pageViewport` instead of a `scale`, so hit regions
  and search highlights follow the rotation with the pixels. **Breaking** for anyone who
  installed those two items directly: pass `viewport(pageSize, { fitWidth, rotation })`
  where you passed a scale. `Thumbnails` and `PageCanvas` take an optional `rotation`, and
  `PageViewHandle.paint` takes one as a second argument.
  
  The items now pin `@build-qube/papyra@^0.3.0` — they call `viewport()`, `rotateSize()`
  and `RenderOptions.annotations`, none of which exist in 0.2.0.
- 4350b67: Show a tagged PDF's structure, and the reading order it declares.
  
  A new `Structure` panel joins the sidebar as a fourth tab, in two views. **Tags** is
  the document's own account of itself — a collapsible tree of `H1`, `P`, `Table`, `TD`
  and the rest — and picking a node outlines that element's content on the page, through
  the same quad overlay search highlights use, so it stays correct on a rotated view.
  **Reading order** lists the current page's lines in the order the document declares,
  against the order the page draws them, and says how many move.
  
  That count is the reason the panel exists. `pageText` reports content-stream order,
  which a two-column page is free to interleave, and no line grouping recovers the
  author's intent from it. On the demo's own `160F-2019.pdf`, 103 of 112 lines move.
  
  - `Highlights` takes an optional `regions`, drawn outlined in the accent colour rather
    than filled, so a selected element reads as a selection rather than a third kind of
    search hit and stays legible over one.
  - The store carries the selection in a `structure` slice, lifted for the reason search
    is: the panel knows which element, and the page overlay is what draws it.
    `ContinuousPages` takes it as a prop and `usePdfStructure` reads it.
  - A tab whose panel is empty now dims its label instead of appending a marker. Four
    tabs plus two markers overflow the 240px column, and a document with neither an
    outline nor a structure tree shows both.
  
  The panel is empty for an untagged document, which is the common case and says so.
- 0eb1f29: Show a document's embedded files.
  
  `Attachments` lists what a PDF carries inside itself, with the declared type and size,
  the document's own description, an inline preview for text and XML, and a button to
  save each one. A hybrid invoice — ZUGFeRD, Factur-X — is called out with a badge,
  because the whole reason to surface attachments in a viewer is that someone reading
  the PDF should know the machine-readable half is already in the file.
  
  It renders **nothing** when a document embeds nothing, rather than an empty state every
  other document scrolls past, so `Properties` carries it unconditionally and looks
  exactly as it did for the documents that have none.

### Patch Changes

- Updated dependencies [0eb1f29]
- Updated dependencies [b0f053c]
- Updated dependencies [4350b67]
  - @build-qube/papyra@0.3.0

## 0.1.0

### Minor Changes

- a81edba: The registry is versioned from here on. It is never published to npm, but its items
  are installed by URL, so this changelog is the only record a consumer of them has of
  what changed under an item's name.
  
  The five blocks moved from `src/components` to `src/blocks`. Installed output is
  unaffected — `shadcn add` takes a file's directory from its `type`, so both land in
  the consumer's `components` alias under the same name — and the built items differ
  only in the `path` string they carry.

### Patch Changes

- Updated dependencies [0b71c9c]
- Updated dependencies [e9d30cc]
  - @build-qube/papyra@0.2.0
