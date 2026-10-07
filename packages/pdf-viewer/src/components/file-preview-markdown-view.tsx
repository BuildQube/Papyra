import { ImageOffIcon } from 'lucide-react';
import { type ComponentProps, type JSX, useEffect, useState } from 'react';
import Markdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { FileViewProps } from '@/lib/file-preview-core';
import { cn } from '@/lib/utils';

/**
 * Past this, a file is shown as source. Parsing is synchronous, and a multi-megabyte
 * Markdown file is almost always generated output nobody reads rendered.
 */
const MAX_RENDER_BYTES = 1024 * 1024;

/** A YAML front matter block at the very start of the file. */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/;

/** Split leading YAML front matter from the body, which a renderer would mangle. */
function splitFrontMatter(source: string): {
  frontMatter: string | undefined;
  body: string;
} {
  const match = FRONT_MATTER.exec(source);
  if (!match) return { frontMatter: undefined, body: source };
  return { frontMatter: match[1], body: source.slice(match[0].length) };
}

const isRemote = (src: string) => /^https?:\/\//i.test(src);
const isInlineImage = (src: string) => /^data:image\//i.test(src);

/**
 * The URL policy: react-markdown's own for links (http, https, mailto, tel and
 * relative; `javascript:` and friends become empty), plus inline `data:image`
 * sources, which carry nothing a picture element can run.
 */
function urlTransform(url: string, key: string): string {
  if (key === 'src' && isInlineImage(url)) return url;
  return defaultUrlTransform(url);
}

type Props<T extends keyof JSX.IntrinsicElements> = ComponentProps<T> & {
  node?: unknown;
};

/** Each element mapped to the app's own type scale, since there is no prose plugin. */
function elements(remoteImages: boolean): Components {
  return {
    h1: ({ node: _, className, ...p }: Props<'h1'>) => (
      <h1
        className={cn(
          'mt-6 mb-3 border-b pb-2 text-2xl font-semibold',
          className,
        )}
        {...p}
      />
    ),
    h2: ({ node: _, className, ...p }: Props<'h2'>) => (
      <h2
        className={cn(
          'mt-6 mb-3 border-b pb-1.5 text-xl font-semibold',
          className,
        )}
        {...p}
      />
    ),
    h3: ({ node: _, className, ...p }: Props<'h3'>) => (
      <h3 className={cn('mt-5 mb-2 text-lg font-semibold', className)} {...p} />
    ),
    h4: ({ node: _, className, ...p }: Props<'h4'>) => (
      <h4 className={cn('mt-4 mb-2 font-semibold', className)} {...p} />
    ),
    h5: ({ node: _, className, ...p }: Props<'h5'>) => (
      <h5 className={cn('mt-4 mb-2 font-semibold', className)} {...p} />
    ),
    h6: ({ node: _, className, ...p }: Props<'h6'>) => (
      <h6
        className={cn(
          'mt-4 mb-2 font-semibold text-muted-foreground',
          className,
        )}
        {...p}
      />
    ),
    p: ({ node: _, className, ...p }: Props<'p'>) => (
      <p className={cn('my-3 leading-7', className)} {...p} />
    ),
    a: ({ node: _, className, ...p }: Props<'a'>) => (
      // Out of the preview, never in place of it: a link in a file someone sent
      // should not navigate the app away. Set after the spread so nothing passed
      // through can undo it.
      <a
        className={cn('text-primary underline underline-offset-2', className)}
        {...p}
        rel="noopener noreferrer nofollow"
        target="_blank"
      />
    ),
    ul: ({ node: _, className, ...p }: Props<'ul'>) => (
      <ul
        className={cn(
          'my-3 ml-6 list-disc [&.contains-task-list]:ml-0 [&.contains-task-list]:list-none',
          className,
        )}
        {...p}
      />
    ),
    ol: ({ node: _, className, ...p }: Props<'ol'>) => (
      <ol className={cn('my-3 ml-6 list-decimal', className)} {...p} />
    ),
    li: ({ node: _, className, ...p }: Props<'li'>) => (
      <li
        className={cn('my-1 [&>input]:mr-2 [&>input]:align-middle', className)}
        {...p}
      />
    ),
    blockquote: ({ node: _, className, ...p }: Props<'blockquote'>) => (
      <blockquote
        className={cn('my-3 border-l-2 pl-4 text-muted-foreground', className)}
        {...p}
      />
    ),
    hr: ({ node: _, className, ...p }: Props<'hr'>) => (
      <hr className={cn('my-6', className)} {...p} />
    ),
    pre: ({ node: _, className, ...p }: Props<'pre'>) => (
      <pre
        className={cn(
          'my-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed [&>code]:bg-transparent [&>code]:p-0',
          className,
        )}
        {...p}
      />
    ),
    code: ({ node: _, className, ...p }: Props<'code'>) => (
      <code
        className={cn(
          'rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]',
          className,
        )}
        {...p}
      />
    ),
    table: ({ node: _, ...p }: Props<'table'>) => (
      <div className="my-3">
        <Table {...p} />
      </div>
    ),
    thead: ({ node: _, ...p }: Props<'thead'>) => <TableHeader {...p} />,
    tbody: ({ node: _, ...p }: Props<'tbody'>) => <TableBody {...p} />,
    tr: ({ node: _, ...p }: Props<'tr'>) => <TableRow {...p} />,
    th: ({ node: _, ...p }: Props<'th'>) => <TableHead {...p} />,
    td: ({ node: _, ...p }: Props<'td'>) => <TableCell {...p} />,
    img: ({ node: _, src, alt, className, ...p }: Props<'img'>) => {
      const url = typeof src === 'string' ? src : '';
      const shown = isInlineImage(url) || (remoteImages && isRemote(url));
      if (shown) {
        return (
          <img
            alt={alt}
            className={cn('my-2 max-w-full rounded', className)}
            src={url}
            {...p}
          />
        );
      }
      return (
        <span
          className="inline-flex items-center gap-1.5 rounded border border-dashed px-2 py-0.5 text-xs text-muted-foreground"
          title={url || undefined}
        >
          <ImageOffIcon className="size-3.5" />
          {alt || 'image'}
          {isRemote(url) ? ' — remote image hidden' : ' — not available here'}
        </span>
      );
    },
  };
}

// Built once each, not per render: a new `components` object is a new set of
// component types, and React would remount the whole document on every keystroke
// of state above it.
const LOCAL_IMAGES = elements(false);
const ALL_IMAGES = elements(true);

/** Props for {@link MarkdownDocument}. */
export interface MarkdownDocumentProps {
  /** The Markdown, front matter already removed. */
  source: string;
  /** Load `http(s)` images. Off by default: in an untrusted file they are trackers. */
  remoteImages?: boolean;
}

/**
 * Markdown rendered to React elements — never to an HTML string, so nothing in the
 * file reaches the page as markup. Raw HTML blocks are skipped outright.
 */
export function MarkdownDocument({
  source,
  remoteImages = false,
}: MarkdownDocumentProps) {
  return (
    <Markdown
      components={remoteImages ? ALL_IMAGES : LOCAL_IMAGES}
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={urlTransform}
    >
      {source}
    </Markdown>
  );
}

/**
 * A Markdown file, rendered or as source, with remote images behind a button.
 *
 * Loaded by `markdownRenderer` — import that, not this, so the parser stays out of
 * the bundle until a Markdown file is opened.
 */
export function MarkdownFileView({ file }: FileViewProps) {
  const [text, setText] = useState<string>();
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  const [remoteImages, setRemoteImages] = useState(false);
  const tooLarge = file.size > MAX_RENDER_BYTES;

  useEffect(() => {
    let live = true;
    setText(undefined);
    setRemoteImages(false);
    file.text().then((t) => live && setText(t));
    return () => {
      live = false;
    };
  }, [file]);

  if (text === undefined) return null;

  const { frontMatter, body } = splitFrontMatter(text);
  // An approximation, but a cheap one: it only decides whether to offer the button.
  const hasRemoteImages = /!\[[^\]]*\]\(\s*<?https?:\/\//i.test(body);
  const rendered = mode === 'rendered' && !tooLarge;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-2 border-b bg-card px-3 py-1.5 text-xs text-muted-foreground">
        <ToggleGroup
          disabled={tooLarge}
          onValueChange={([next]) => {
            if (next === 'rendered' || next === 'source') setMode(next);
          }}
          size="sm"
          value={[tooLarge ? 'source' : mode]}
          variant="outline"
        >
          <ToggleGroupItem value="rendered">Rendered</ToggleGroupItem>
          <ToggleGroupItem value="source">Source</ToggleGroupItem>
        </ToggleGroup>
        {tooLarge && <span>Too large to render; showing the source.</span>}
        {rendered && hasRemoteImages && !remoteImages && (
          <Button
            className="ml-auto"
            onClick={() => setRemoteImages(true)}
            size="sm"
            variant="outline"
          >
            Show remote images
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rendered ? (
          <article className="mx-auto max-w-3xl px-6 py-4 text-sm">
            {frontMatter !== undefined && (
              <pre className="mb-4 overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
                {frontMatter}
              </pre>
            )}
            <MarkdownDocument remoteImages={remoteImages} source={body} />
          </article>
        ) : (
          <pre className="p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}
