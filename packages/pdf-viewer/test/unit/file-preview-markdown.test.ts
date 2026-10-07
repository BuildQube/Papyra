import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { codeRenderer } from '@/components/file-preview-code';
import { csvRenderer } from '@/components/file-preview-csv';
import { markdownRenderer } from '@/components/file-preview-markdown';
import { MarkdownDocument } from '@/components/file-preview-markdown-view';
import { detectHead } from '@/lib/file-preview-core';

const text = (s: string) => new TextEncoder().encode(s);
const idOf = (
  name: string,
  type: string,
  renderers: Parameters<typeof detectHead>[2],
) => {
  const d = detectHead({ name, type }, text('# hello\n'), renderers);
  return d.status === 'ok' ? d.renderer.id : d.status;
};

describe('code is a fallback', () => {
  test('Markdown takes .md wherever the two sit in the list', () => {
    expect(idOf('README.md', '', [codeRenderer, markdownRenderer])).toBe(
      'markdown',
    );
    expect(idOf('README.md', '', [markdownRenderer, codeRenderer])).toBe(
      'markdown',
    );
  });

  test('without a Markdown renderer, .md still shows, as source', () => {
    expect(idOf('README.md', '', [codeRenderer])).toBe('code');
  });

  test("a fallback's extension does not beat a specific renderer's MIME type", () => {
    // `.txt` is code's extension, `text/markdown` is Markdown's exact type. The
    // specificity order alone would hand this to code.
    expect(
      idOf('notes.txt', 'text/markdown', [codeRenderer, markdownRenderer]),
    ).toBe('markdown');
  });

  test('CSV takes .csv over code in either order, and code has it otherwise', () => {
    expect(idOf('a.csv', 'text/csv', [codeRenderer, csvRenderer])).toBe('csv');
    expect(idOf('a.csv', 'text/csv', [csvRenderer, codeRenderer])).toBe('csv');
    expect(idOf('a.csv', 'text/csv', [codeRenderer])).toBe('code');
  });
});

const render = (source: string, remoteImages = false) =>
  renderToStaticMarkup(
    createElement(MarkdownDocument, { source, remoteImages }),
  );

describe('MarkdownDocument treats the file as untrusted', () => {
  test('raw HTML never reaches the page', () => {
    const html = render(
      'before\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n<iframe src="https://evil.test"></iframe>\n\nafter',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  test('a script link loses its target', () => {
    const html = render(
      '[click](javascript:alert(1)) [data](data:text/html,<b>x</b>)',
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
  });

  test('links open outside the preview', () => {
    const html = render('[site](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
  });

  test('remote images stay hidden until asked for', () => {
    const md = '![site plan](https://tracker.test/pixel.png)';
    const hidden = render(md);
    expect(hidden).not.toContain('<img');
    expect(hidden).toContain('remote image hidden');
    expect(render(md, true)).toContain('src="https://tracker.test/pixel.png"');
  });

  test('inline data images show; relative ones cannot', () => {
    expect(render('![dot](data:image/png;base64,iVBORw0KGgo=)')).toContain(
      'src="data:image/png;base64,iVBORw0KGgo="',
    );
    const relative = render('![diagram](./diagram.png)');
    expect(relative).not.toContain('<img');
    expect(relative).toContain('not available here');
  });

  test('GitHub-flavoured tables and task lists render', () => {
    const html = render(
      '| Item | Status |\n| --- | --- |\n| RFI 12 | Open |\n\n- [x] Submitted\n- [ ] Approved\n\n~~struck~~',
    );
    expect(html).toContain('<table');
    expect(html).toContain('RFI 12');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<del>struck</del>');
  });
});
