import { defineRenderer } from '@/lib/file-preview-core';

/**
 * Source code and plain text, syntax-highlighted.
 *
 * The only one of the three with no signature to sniff, so it matches by name or
 * MIME type, and `text` keeps it from being handed a binary that merely has the
 * right extension. Put it **last** in a renderer list: anything that can be
 * recognised by its bytes should be, before a name gets a say.
 */
export const codeRenderer = defineRenderer({
  id: 'code',
  label: 'Code',
  extensions: [
    '.txt',
    '.log',
    '.md',
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
  load: () => import('./file-preview-code-view').then((m) => m.CodeFileView),
});
