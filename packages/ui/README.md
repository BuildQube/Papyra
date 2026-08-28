# @workspace/ui

Private, unbuilt. Every UI component in the monorepo lives here and is consumed as
**source** — the `exports` map points at `src/`, not a `dist/`, so there is no build
step to keep in sync and the consuming app's Vite/Tailwind pipeline sees the real
`.tsx`. That is also what lets Tailwind v4 find the class names: its scanner follows
the import graph, and a pre-bundled package would hand it minified strings.

```tsx
import { Button } from '@workspace/ui/components/button';
import { cn } from '@workspace/ui/lib/utils';
import '@workspace/ui/globals.css';
```

## What is ours

`src/components` is vendored — an `add` overwrites it — with one exception:
`copy-button.tsx` is written here, and `biome.json` re-enables the linter for that
one file. Anything else authored in this directory should get the same treatment,
or it silently stops being linted.

## Adding components

Run shadcn from the app, not from here — `-c apps/demo` makes it read
`apps/demo/components.json`, whose `ui` alias points back at this package, so the
component file lands in `src/components/` while any app-level file it needs lands in
the app:

```bash
bunx shadcn@latest add dialog -c apps/demo
```

shadcn writes double quotes and its own spacing; this repo is biome (single quotes,
80 cols). Run `bun run format` after an `add` or `bun run check` fails in CI.

`biome.json` turns the **linter** off for `packages/ui/src/components/**` — the
formatter and the import assist still run. This directory is vendored: an `add`
overwrites it, so a lint fix here is undone by the next upgrade rather than sent
upstream. Across the initial 28 components biome flagged ten such things
(`useSemanticElements` on `role="group"`, `noArrayIndexKey`, `noDoubleEquals`,
`noLabelWithoutControl`, and the `cva` variants exported beside each component).
Anything we actually write — `src/lib`, `src/hooks`, and every app — stays linted.

## Theme

The palette is shadcn's neutral base with papyra's accent, #6ea8fe, on `--primary`
and `--ring` — **not** on `--accent`, which in shadcn is the hover surface, so
tinting it would turn every hover blue.

Two things here are not shadcn's and will not survive a blind `shadcn add` that
rewrites `globals.css`:

- `--syntax-intrinsic` / `--syntax-literal` / `--syntax-keyword`, themed per mode
  and surfaced as `text-syntax-*`. The API reference needs them because semantic
  tokens do not stretch to syntax: `text-muted-foreground` says "less important",
  and a type keyword is not less important than a literal, it is a different thing.
- `@utility checkerboard`, the transparency checkerboard the export view paints
  behind a transparent SVG.

`apps/demo` is built entirely from this package — `@tailwindcss/vite` in
`vite.config.ts`, the `@/*` and `@workspace/ui/*` paths in `tsconfig.json`, its own
`components.json`, `globals.css` as the single CSS import in `src/main.tsx`, and
`ThemeProvider` putting `light`/`dark` on `<html>`.
