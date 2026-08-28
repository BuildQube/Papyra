import { cn } from '@workspace/ui/lib/utils';
import type { CommentPart } from '../../lib/apiModel.js';

/**
 * `readme` is the package README opening the reference page; `prose` is a doc
 * comment inside it.
 */
type Variant = 'prose' | 'readme';

/**
 * Renders a TypeDoc comment token stream as prose.
 *
 * TypeDoc hands over a flat list of `text` / `code` / `inline-tag` parts, not blocks:
 * a paragraph, the bullet list after it and the fenced example below that all arrive
 * as one run, and a sentence can be split across three parts because it happened to
 * contain a backtick. So the parts are re-grouped into blocks here rather than being
 * mapped one-to-one onto elements, which is what makes lists and `**bold**` survive.
 *
 * The package README arrives through the same stream (TypeDoc's `readme` option), so
 * headings and `[text](url)` are handled here too — that is the whole markdown
 * surface the quickstart uses, and the reason the reference needs no markdown parser.
 */

type InlineBase =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; target?: number }
  | { t: 'extlink'; v: string; href: string };

/**
 * `strong` is a flag rather than its own variant because bold is a *span*, not a
 * token: `**Size with `fitWidth`, not `dpi`.**` opens in one part, crosses two code
 * spans and closes in a third, so nothing inside it can be matched on its own.
 */
type Inline = InlineBase & { strong?: boolean };

type Block =
  | { kind: 'p' | 'li'; inline: Inline[] }
  | { kind: 'h'; level: number; inline: Inline[] }
  | { kind: 'code'; code: string };

/** A bullet's own text, so a list item is keyed by content rather than position. */
function inlineKey(inline: readonly Inline[]): string {
  return inline.map((part) => part.v).join('');
}

const MD_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * One text run into inlines: markdown links first, then `**` as a toggle.
 *
 * Returns the bold state on the way out so the next part picks up where this one
 * left off.
 */
function inlineText(text: string, strong: boolean): [Inline[], boolean] {
  const out: Inline[] = [];
  let bold = strong;

  const emit = (chunk: string): void => {
    for (const [i, piece] of chunk.split('**').entries()) {
      if (i > 0) bold = !bold;
      if (piece) out.push({ t: 'text', v: piece, strong: bold });
    }
  };

  let last = 0;
  for (const match of text.matchAll(MD_LINK)) {
    if (match.index > last) emit(text.slice(last, match.index));
    out.push({
      t: 'extlink',
      v: match[1] ?? '',
      href: match[2] ?? '',
      strong: bold,
    });
    last = match.index + match[0].length;
  }
  emit(text.slice(last));

  return [out, bold];
}

function toBlocks(parts: readonly CommentPart[]): Block[] {
  const blocks: Block[] = [];
  let inline: Inline[] = [];
  // Once a list starts, a plain continuation line belongs to the current bullet
  // rather than opening a new paragraph — that is how the `EncodedFormat` list wraps.
  let inList = false;
  let heading: number | null = null;
  let strong = false;

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
    if (kept.length) {
      blocks.push(
        heading !== null
          ? { kind: 'h', level: heading, inline: kept }
          : { kind: inList ? 'li' : 'p', inline: kept },
      );
    }
    heading = null;
    inline = [];
    // An unclosed `**` is a typo, not licence to bold the rest of the page.
    strong = false;
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
        inline.push({ t: 'code', v: part.text.replace(/^`|`$/g, ''), strong });
      }
      continue;
    }

    if (part.kind === 'inline-tag') {
      inline.push({ t: 'link', v: part.text, target: part.target, strong });
      continue;
    }

    // A text run. A *blank* line ends a block; a lone newline is a wrap, and the
    // difference matters because a part very often ends mid-sentence on one — the
    // text before an inline `code` span is its own part, trailing newline included.
    // Splitting on blank lines first is what keeps that sentence in one paragraph.
    for (const [pi, para] of part.text.split(/\n[ \t]*\n/).entries()) {
      if (pi > 0) {
        flush();
        inList = false;
      }
      const lines = para.split('\n');
      for (const [i, line] of lines.entries()) {
        // Tested against the raw line, not the wrapped form: prefixing the
        // continuation space first would hide every `##` that is not part-initial.
        const hashes = /^\s*(#{1,6})\s+/.exec(line);
        const bullet = /^\s*[-*]\s+/.exec(line);
        let text = line;

        // A heading ends at its own line break, not at the next blank line.
        if (i > 0 && heading !== null) flush();

        if (hashes) {
          flush();
          inList = false;
          heading = hashes[1]?.length ?? 1;
          text = line.slice(hashes[0].length);
        } else if (bullet) {
          flush();
          inList = true;
          text = line.slice(bullet[0].length);
        } else if (i > 0) {
          // A wrapped line: the newline and the indent behind it are one space.
          text = ` ${line.trimStart()}`;
        }

        if (text) {
          const [emitted, nextStrong] = inlineText(text, strong);
          inline.push(...emitted);
          strong = nextStrong;
        }
      }
    }
  }
  flush();
  return blocks;
}

/**
 * Tight, and filled rather than bordered: a 4px pad plus a border reads as a real
 * space, so `DOMException`, came out looking like `DOMException ,`.
 */
function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-xs bg-muted px-[3px] font-mono text-[0.9em]">
      {children}
    </code>
  );
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
        let node: React.ReactNode = part.v;
        if (part.t === 'code') {
          node = <Code>{part.v}</Code>;
        } else if (part.t === 'extlink') {
          node = (
            <a
              className="text-primary hover:underline"
              href={part.href}
              rel="noreferrer"
              target="_blank"
            >
              {part.v}
            </a>
          );
        } else if (part.t === 'link') {
          const href = hrefFor(part.target, part.v);
          node = href ? (
            <a
              className="font-mono text-[0.9em] text-primary hover:underline"
              href={href}
            >
              {part.v}
            </a>
          ) : (
            <Code>{part.v}</Code>
          );
        }
        return (
          <span key={`${part.t}-${i}`}>
            {part.strong ? <strong>{node}</strong> : node}
          </span>
        );
      })}
    </>
  );
}

/**
 * The README's own heading scale, deliberately distinct from the reference below it:
 * this is the part you read, that part is the part you look things up in.
 */
const README_HEADINGS: Record<number, string> = {
  1: 'mb-2.5 font-mono text-[22px] tracking-[0.01em]',
  2: 'mt-6 border-t pt-3.5 text-sm',
  3: 'mt-4 text-[13px]',
};

/** `#`..`######` as the matching element, so the README keeps its own outline. */
function Heading({
  level,
  variant,
  children,
}: {
  level: number;
  variant: Variant;
  children: React.ReactNode;
}) {
  const Tag = `h${Math.min(Math.max(level, 1), 6)}` as 'h1';
  return (
    <Tag
      className={cn(
        'font-medium',
        variant === 'readme' && (README_HEADINGS[level] ?? 'mt-4 text-[13px]'),
      )}
    >
      {children}
    </Tag>
  );
}

export function CommentBody({
  parts,
  hrefFor,
  className,
  variant = 'prose',
}: {
  parts: readonly CommentPart[] | undefined;
  hrefFor: (target: number | undefined, text: string) => string | undefined;
  className?: string;
  variant?: Variant;
}) {
  if (!parts?.length) return null;
  const blocks = toBlocks(parts);

  // Consecutive `li` blocks are one list; anything else breaks the run.
  const rendered: React.ReactNode[] = [];
  let bullets: Block[] = [];
  const flushList = (at: number): void => {
    if (!bullets.length) return;
    rendered.push(
      <ul className="my-2 list-disc pl-5" key={`ul-${at}`}>
        {bullets.map((b) => (
          <li
            className="my-0.5"
            key={b.kind === 'li' ? inlineKey(b.inline) : ''}
          >
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
    if (block.kind === 'code') {
      rendered.push(
        <pre
          className="my-2.5 overflow-x-auto rounded-md border bg-muted/40 px-3 py-2.5 text-xs leading-relaxed"
          key={`code-${i}`}
        >
          <code className="font-mono">{block.code}</code>
        </pre>,
      );
    } else if (block.kind === 'h') {
      rendered.push(
        <Heading key={`h-${i}`} level={block.level} variant={variant}>
          <Inlines hrefFor={hrefFor} inline={block.inline} />
        </Heading>,
      );
    } else {
      rendered.push(
        <p className="my-2" key={`p-${i}`}>
          <Inlines hrefFor={hrefFor} inline={block.inline} />
        </p>,
      );
    }
  }
  flushList(blocks.length);

  /* A prose column, not full width: measured lines are the point of doc comments. */
  return (
    <div
      className={cn(
        'max-w-[74ch]',
        variant === 'readme' &&
          'border-b pb-5 [&_li]:text-muted-foreground [&_p]:text-muted-foreground [&_strong]:text-foreground',
        className,
      )}
    >
      {rendered}
    </div>
  );
}
