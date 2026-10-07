import { defineRenderer } from '@/lib/file-preview-core';

/**
 * Source code and plain text, syntax-highlighted.
 *
 * Text has no signature to sniff, so it matches by name or MIME type, and `text`
 * keeps it from being handed a binary that merely has the right extension. It is a
 * `fallback`: a Markdown or CSV renderer takes `.md` or `.csv` wherever it sits in
 * the list, and this one shows them as source only when no such renderer is
 * installed.
 */
export const codeRenderer = defineRenderer({
  id: 'code',
  label: 'Code',
  extensions: [
    '.txt',
    '.log',
    '.md',
    '.csv',
    '.tsv',
    '.json',
    '.jsonc',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.xml',
    '.html',
    '.css',
    '.scss',
    '.js',
    '.mjs',
    '.cjs',
    '.jsx',
    '.ts',
    '.mts',
    '.cts',
    '.tsx',
    '.vue',
    '.svelte',
    '.py',
    '.rb',
    '.php',
    '.java',
    '.kt',
    '.swift',
    '.go',
    '.rs',
    '.c',
    '.h',
    '.cpp',
    '.hpp',
    '.cs',
    '.sh',
    '.bash',
    '.zsh',
    '.sql',
    '.graphql',
  ],
  mimes: [
    'text/*',
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-sh',
  ],
  text: true,
  fallback: true,
  load: () => import('./file-preview-code-view').then((m) => m.CodeFileView),
});
