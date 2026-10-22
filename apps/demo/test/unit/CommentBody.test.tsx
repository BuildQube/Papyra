import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommentBody } from '../../src/components/docs/CommentBody.js';
import type { CommentPart } from '../../src/lib/apiModel.js';

const render = (parts: CommentPart[]): string =>
  renderToStaticMarkup(
    <CommentBody hrefFor={() => undefined} parts={parts} variant="readme" />,
  );

/** The text inside each element of `tag`, tags stripped. */
const cells = (html: string, tag: 'th' | 'td'): string[] =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'g'))].map((m) =>
    (m[1] ?? '').replace(/<[^>]+>/g, ''),
  );

describe('CommentBody tables', () => {
  // The split TypeDoc really produces: every code span is its own part, so a row
  // starts at the end of one text part and finishes several parts later.
  const parts: CommentPart[] = [
    {
      kind: 'text',
      text: 'Engines:\n\n| Engine | Import |\n| --- | --- |\n| ',
    },
    { kind: 'code', text: '`PapyraEngine`' },
    { kind: 'text', text: ' | ' },
    { kind: 'code', text: '`@build-qube/papyra/engine`' },
    {
      kind: 'text',
      text: ' |\n| pdf.js | [README](https://x.test) |\n\nAfter, ',
    },
    // A table ending its paragraph: the blank line, not this part, ends the row.
    { kind: 'code', text: '`code`' },
    { kind: 'text', text: '.' },
  ];

  test('rows that cross code spans keep their cells', () => {
    const html = render(parts);
    expect(cells(html, 'th')).toEqual(['Engine', 'Import']);
    expect(cells(html, 'td')).toEqual([
      'PapyraEngine',
      '@build-qube/papyra/engine',
      'pdf.js',
      'README',
    ]);
    expect(html).toContain('href="https://x.test"');
  });

  test('the paragraphs either side stay paragraphs', () => {
    const html = render(parts);
    expect(html).toMatch(/<p[^>]*><span>Engines:<\/span><\/p>/);
    expect(cells(html, 'td')).not.toContain('code');
    expect(html).toMatch(
      /<p[^>]*><span>After, <\/span><span><code[^>]*>code<\/code>/,
    );
  });
});

test('readme headings carry GitHub anchors', () => {
  const html = render([
    { kind: 'text', text: "## Keeping papyra's wasm out of the bundle\n" },
  ]);
  expect(html).toContain('id="keeping-papyras-wasm-out-of-the-bundle"');
});
