import { useEffect, useState } from 'react';
import type { HighlighterCore } from 'shiki/core';
import type { FileViewProps } from '@/lib/file-preview-core';
import { extensionOf } from '@/lib/file-preview-core';

/**
 * Past this, a file is shown as plain text.
 *
 * Highlighting is a synchronous tokenisation on the main thread; a multi-megabyte log
 * freezes the tab for seconds to colour text nobody will read top to bottom.
 */
const MAX_HIGHLIGHT_BYTES = 512 * 1024;

/** Extensions shiki does not know by name, mapped onto ones it does. */
const LANGUAGE_OF: Record<string, string> = {
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  h: 'c',
  hpp: 'cpp',
  txt: 'text',
  log: 'log',
};

let highlighter: Promise<HighlighterCore> | undefined;

/**
 * One highlighter for every code view on the page, with no languages yet.
 *
 * The JavaScript regex engine rather than oniguruma, because oniguruma is a wasm
 * module — a second one, beside papyra's, for the sake of colouring text. Grammars
 * load one at a time as files need them, so a page that only ever shows JSON fetches
 * one grammar, not shiki's two hundred.
 */
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
    createHighlighterCore({
      themes: [
        import('shiki/themes/github-light.mjs'),
        import('shiki/themes/github-dark.mjs'),
      ],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    }),
  );
  return highlighter;
}

async function highlight(name: string, text: string): Promise<string> {
  const [h, { bundledLanguages }] = await Promise.all([
    getHighlighter(),
    import('shiki/langs'),
  ]);
  const ext = extensionOf(name).slice(1);
  const wanted = LANGUAGE_OF[ext] ?? ext;
  // Indexed by whatever the file's name says, so absent is the usual case.
  const grammar = (
    bundledLanguages as Partial<Record<string, (typeof bundledLanguages)['js']>>
  )[wanted];
  const lang = grammar ? wanted : 'text';
  if (grammar) await h.loadLanguage(grammar);
  return h.codeToHtml(text, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
    // Colours as CSS variables only, so the theme follows the app's own dark class
    // instead of shiki's inline choice of one.
    defaultColor: false,
  });
}

/**
 * Text with syntax highlighting. Plain text first, colour once the grammar arrives.
 *
 * Loaded by `codeRenderer` — import that, not this, so shiki stays out of the bundle
 * until a code file is opened.
 */
export function CodeFileView({ file }: FileViewProps) {
  const [text, setText] = useState<string>();
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    let live = true;
    setText(undefined);
    setHtml(undefined);
    file.text().then((t) => {
      if (!live) return;
      setText(t);
      if (file.size > MAX_HIGHLIGHT_BYTES) return;
      highlight(file.name, t).then(
        (h) => live && setHtml(h),
        // A grammar that fails to load leaves the text readable, which is the point.
        () => undefined,
      );
    });
    return () => {
      live = false;
    };
  }, [file]);

  const className =
    'min-h-0 flex-1 overflow-auto bg-muted/40 font-mono text-xs leading-relaxed';

  if (html) {
    return (
      <div
        className={`${className} [&_pre]:min-w-max [&_pre]:p-4 [&_span]:text-(--shiki-light) dark:[&_span]:text-(--shiki-dark)`}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki escapes the source text; the markup is only its own spans.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <div className={className}>
      <pre className="min-w-max p-4">{text}</pre>
    </div>
  );
}
