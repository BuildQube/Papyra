---
'@workspace/pdf-viewer': minor
---

Markdown renderer for the file preview, and a `fallback` flag for catch-all renderers.

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
