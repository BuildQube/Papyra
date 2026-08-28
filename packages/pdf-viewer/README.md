# @workspace/pdf-viewer

The PDF viewer components, authored as a **shadcn registry**. Private and unbuilt,
like `@workspace/ui`, and consumed as source; it depends on both that package and
`@build-qube/papyra`, which is why it is not part of `@workspace/ui` — the generic
Button/Card package has no business depending on a PDF engine.

## The import convention is load-bearing

Every file here imports through shadcn's canonical aliases:

```tsx
import { Button } from '@/components/ui/button';   // a shadcn primitive
import { Outline } from '@/components/pdf-outline'; // a sibling in this registry
import { formatZoom } from '@/lib/pdf-zoom';
import { usePageLabels } from '@/hooks/use-pdf-page-labels';
import { cn } from '@/lib/utils';
```

**Not `@workspace/ui/components/button`.** `shadcn build` copies file content
byte-for-byte — it rewrites nothing — and `shadcn add` rewrites only those five
alias forms, mapping each onto the consumer's own `components.json`. A
`@workspace/…` specifier therefore ships verbatim into someone else's project and
fails to resolve there. Verified against the real CLI: a probe item importing both
forms had the `@/…` ones rewritten to the consumer's aliases and the `@workspace/…`
ones left untouched.

So `@/` means *this package*, repo-wide. `apps/demo` declares the same mappings in
its `tsconfig.json` and `vite.config.ts` (most specific first — `@/components/ui/*`
and `@/lib/utils` resolve into `@workspace/ui`, everything else here). The demo never
used `@/` for its own files, which is what made the name available.

## Flat, prefixed filenames

`shadcn add` **flattens** paths: a registry file at `components/pdf-viewer/outline.tsx`
lands as `<components-alias>/outline.tsx` in the consumer, subdirectory dropped. So
grouping cannot come from a folder, and every file carries a `pdf-` prefix instead —
these land in a flat directory beside the consumer's own components.

## Adding a shadcn primitive

Run it against this package, not the app; the `ui` alias points back at
`@workspace/ui`, so primitives land there and viewer components land here:

```bash
bunx shadcn@latest add dialog -c packages/pdf-viewer
```

## Tailwind

`apps/demo/src/app.css` names this package in an `@source`. Tailwind's automatic
detection is rooted at the package holding the CSS entry, so without that line a
class used only here is silently never generated.
