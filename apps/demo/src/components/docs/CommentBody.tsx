import type { CommentPart } from '../../lib/apiModel.js';

/**
 * Renders a TypeDoc comment token stream as prose.
 *
 * TypeDoc hands over a flat list of `text` / `code` / `inline-tag` parts, not blocks:
 * a paragraph, the bullet list after it and the fenced example below that all arrive
 * as one run, and a sentence can be split across three parts because it happened to
 * contain a backtick. So the parts are re-grouped into blocks here rather than being
 * mapped one-to-one onto elements, which is what makes lists and `**bold**` survive.
 */

type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; target?: number };

type Block =
  | { kind: 'p' | 'li'; inline: Inline[] }
  | { kind: 'code'; code: string };

/** A bullet's own text, so a list item is keyed by content rather than position. */
function inlineKey(inline: readonly Inline[]): string {
  return inline.map((part) => part.v).join('');
}

/** Split `**bold**` out of a plain-text run. */
function inlineText(text: string): Inline[] {
  const out: Inline[] = [];
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  for (const [i, piece] of parts.entries()) {
    if (!piece) continue;
    out.push(i % 2 === 1 ? { t: 'strong', v: piece } : { t: 'text', v: piece });
  }
  return out;
}

function toBlocks(parts: readonly CommentPart[]): Block[] {
  const blocks: Block[] = [];
  let inline: Inline[] = [];
  // Once a list starts, a plain continuation line belongs to the current bullet
  // rather than opening a new paragraph — that is how the `EncodedFormat` list wraps.
  let inList = false;

  const flush = (): void => {
    // Only the block's outer edges are trimmed. Whitespace *inside* it is real:
    // TypeDoc puts the space between a word and the link after it at the end of the
    // preceding text token, so trimming every token welds the two together.
    const kept = inline
      .map((part, i) => {
        if (part.t !== 'text') return part;
        let v = part.v;
        if (i === 0) v = v.trimStart();
        if (i === inline.length - 1) v = v.trimEnd();
        return { ...part, v };
      })
      .filter((part) => part.v !== '');
    if (kept.length) blocks.push({ kind: inList ? 'li' : 'p', inline: kept });
    inline = [];
  };

  for (const part of parts) {
    if (part.kind === 'code') {
      if (part.text.startsWith('```')) {
        flush();
        inList = false;
        const body = part.text.replace(/^```/, '').replace(/```\s*$/, '');
        // The first line is the language tag, which nothing here highlights with.
        const nl = body.indexOf('\n');
        blocks.push({
          kind: 'code',
          code: (nl < 0 ? body : body.slice(nl + 1)).replace(/\n+$/, ''),
        });
      } else {
        inline.push({ t: 'code', v: part.text.replace(/^`|`$/g, '') });
      }
      continue;
    }

    if (part.kind === 'inline-tag') {
      inline.push({ t: 'link', v: part.text, target: part.target });
      continue;
    }

    // A text run: newlines are the only block signal TypeDoc leaves behind.
    const lines = part.text.split('\n');
    for (const [i, line] of lines.entries()) {
      let text = line;
      if (i > 0) {
        if (line.trim() === '') {
          flush();
          inList = false;
          continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
          flush();
          inList = true;
          text = line.replace(/^\s*[-*]\s+/, '');
        } else {
          // A wrapped line: the newline and the indent behind it are one space.
          text = ` ${line.trimStart()}`;
        }
      }
      if (text) inline.push(...inlineText(text));
    }
  }
  flush();
  return blocks;
}

function Inlines({
  inline,
  hrefFor,
}: {
  inline: readonly Inline[];
  hrefFor: (target: number | undefined, text: string) => string | undefined;
}) {
  return (
    <>
      {inline.map((part, i) => {
        const key = `${part.t}-${i}`;
        if (part.t === 'code') return <code key={key}>{part.v}</code>;
        if (part.t === 'strong') return <strong key={key}>{part.v}</strong>;
        if (part.t === 'link') {
          const href = hrefFor(part.target, part.v);
          return href ? (
            <a className="api-xref" href={href} key={key}>
              {part.v}
            </a>
          ) : (
            <code key={key}>{part.v}</code>
          );
        }
        return <span key={key}>{part.v}</span>;
      })}
    </>
  );
}

export function CommentBody({
  parts,
  hrefFor,
}: {
  parts: readonly CommentPart[] | undefined;
  hrefFor: (target: number | undefined, text: string) => string | undefined;
}) {
  if (!parts?.length) return null;
  const blocks = toBlocks(parts);

  // Consecutive `li` blocks are one list; anything else breaks the run.
  const rendered: React.ReactNode[] = [];
  let bullets: Block[] = [];
  const flushList = (at: number): void => {
    if (!bullets.length) return;
    rendered.push(
      <ul key={`ul-${at}`}>
        {bullets.map((b) => (
          <li key={b.kind === 'li' ? inlineKey(b.inline) : ''}>
            {b.kind === 'li' && <Inlines hrefFor={hrefFor} inline={b.inline} />}
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const [i, block] of blocks.entries()) {
    if (block.kind === 'li') {
      bullets.push(block);
      continue;
    }
    flushList(i);
    rendered.push(
      block.kind === 'code' ? (
        <pre className="api-code" key={`code-${i}`}>
          <code>{block.code}</code>
        </pre>
      ) : (
        <p key={`p-${i}`}>
          <Inlines hrefFor={hrefFor} inline={block.inline} />
        </p>
      ),
    );
  }
  flushList(blocks.length);

  return <div className="api-prose">{rendered}</div>;
}
