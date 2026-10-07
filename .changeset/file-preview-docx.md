---
'@workspace/pdf-viewer': minor
---

Word renderer for the file preview.

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
