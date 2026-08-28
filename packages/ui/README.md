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

`biome.json` turns `style/useComponentExportOnlyModules` off for
`packages/ui/src/components/**`: every shadcn component exports its `cva` variants
alongside the component itself, so the Fast Refresh rule would warn forever on a
file layout we re-take from upstream on each `add`.

## Wiring it into a consuming app

`apps/demo` already has the plumbing — `@tailwindcss/vite` in `vite.config.ts`, the
`@/*` and `@workspace/ui/*` paths in `tsconfig.json`, and its own `components.json`.
Two switches are deliberately **not** flipped yet, because both change how the demo
looks and the demo still ships 1191 lines of hand-written CSS:

1. `import '@workspace/ui/globals.css'` in `src/main.tsx`, **before** `./styles.css`.
   Tailwind's preflight lands in `@layer base`, and unlayered CSS beats layered CSS
   regardless of specificity, so `styles.css` keeps winning for every property it
   sets — but preflight still resets what it does not (heading sizes, list markers,
   `img { display: block }`).
2. Wrapping the tree in `ThemeProvider` (`src/components/theme-provider.tsx`), which
   puts `light`/`dark` on `<html>` for the `dark:` variant to key off.

Both belong to the migration, not to the scaffold.
