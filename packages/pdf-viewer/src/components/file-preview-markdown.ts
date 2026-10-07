import { defineRenderer } from '@/lib/file-preview-core';

/**
 * Markdown, rendered: GitHub-flavoured, so tables, task lists and strikethrough.
 *
 * Takes `.md` from `code` wherever the two sit in a renderer list, since `code` is a
 * fallback; without this renderer installed, Markdown still shows, as source.
 *
 * Untrusted input is the assumption. Raw HTML in the file is dropped rather than
 * rendered, links with a script or data protocol lose their target, and remote
 * images stay hidden until the reader asks for them — an image in a file you were
 * sent is a tracking pixel, and under the page's cross-origin isolation most of
 * them would not load anyway.
 */
export const markdownRenderer = defineRenderer({
  id: 'markdown',
  label: 'Markdown',
  extensions: ['.md', '.markdown', '.mdown', '.mkd', '.mkdn'],
  mimes: ['text/markdown', 'text/x-markdown'],
  text: true,
  load: () =>
    import('./file-preview-markdown-view').then((m) => m.MarkdownFileView),
});
