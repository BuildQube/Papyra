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

## State

`PdfViewerProvider` puts a store in scope; the selector hooks subscribe to one slice
each. The context carries the **store**, never the state, so it never re-renders
anything — a page change replaces `page` and leaves `search` and `document` pointing
at the same objects, and `useSyncExternalStore` compares by `Object.is`, so a
component reading only `search` does not re-render. With a 400-page thumbnail strip
mounted, a plain context here would walk the whole tree on every page change.
`test/integration/pdf-viewer-store.test.ts` pins that property.

The store also carries the **view mode**, single-page or continuous, even though the
blocks each render only one of the two: the full viewer is continuous and the basic
one is a single page. Keeping it in state means a toggle, a saved preference and a
deep link are the same thing, and adding the toggle to a block later is a UI change
rather than a state change. The demo already exercises both.

Two things deliberately stay out of the store:

- **Zoom.** A pinch changes the scale every animation frame; a store notification per
  frame would re-render every subscriber for a value only the page surface reads.
  `useZoom` keeps it local and commits the settled value.
- **Routing.** The store knows nothing about URLs, which is what lets these
  components work under a different router or none. `apps/demo/src/lib/urlSync.ts`
  is the adapter, and it lives in the app.

The components themselves stay **controlled** — `Sidebar` still takes `matches` and
`onMatches` rather than reading the store. That is what keeps `memo` effective and
lets each one be documented and demonstrated on its own; the provider supplies the
props, it does not replace them.

## The registry

`registry.json` is the source; `bun run build:registry` turns it into
`apps/demo/public/r/*.json`, which the demo serves alongside itself. Turbo runs it
before the demo's build, so the items ship with the site.

```bash
npx shadcn@latest add https://buildqube.github.io/Papyra/r/pdf-sidebar.json
```

**Sibling items are named by absolute URL.** A bare `registryDependencies` entry like
`"button"` always means an *official* shadcn item, never a same-registry one, so
every cross-item edge carries a `{{REGISTRY}}` placeholder that
`scripts/build-registry.ts` substitutes at build time. `PAPYRA_REGISTRY` overrides the
destination for a fork or a preview; the default is production, deliberately, because
a base derived from `PAPYRA_BASE` would let a local build emit items pointing at a
host that does not serve them — a failure only the person installing them would ever
see.

**The items declare `@build-qube/papyra@^0.2.0`, which is not published yet.** They
use `doc.pageLabels()`, `doc.links()` and `doc.fingerprint`, none of which exist in
the published 0.1.0; the queued changeset that adds them makes the next release 0.2.0.
Until it ships, an install stops at `npm error notarget No matching version found`,
which is the honest failure — an unversioned dependency would instead install 0.1.0
and fail later, inside the consumer's build, with a type error about a property that
does not exist.

## Adding a shadcn primitive

Run it against this package, not the app; the `ui` alias points back at
`@workspace/ui`, so primitives land there and viewer components land here:

```bash
bunx shadcn@latest add dialog -c packages/pdf-viewer
```

## Props are documented, and the build enforces it

Every component exports a named `*Props` interface — `OutlineProps`, `ZoomBarProps`
and so on — and `packages/docs-gen` runs a second TypeDoc pass over this package into
`apps/demo/public/papyra-registry-api.json`, which the demo's `/components` route
renders as a props table.

That config sets `treatValidationWarningsAsErrors`, so **a prop with no TSDoc fails
the build**. Adding a component here means documenting its props; there is no way to
ship one with a blank cell in the table. The initial pass had 91 such members.

Every file is its own TypeDoc entry point (`entryPointStrategy: "expand"`) because
registry items are installed one at a time and the package has no index to walk from.
The consequence to know: a `{@link}` **across files** has no target, so cross-item
references are written as plain code spans instead — which is also honest, since a
consumer may have installed one item and not the other.

## The showcase

`apps/demo`'s `/components` route renders this registry: the sidebar, the install
command, the dependency badges and the props table all come from the two artifacts
the build already produces — `r/registry.json` and `papyra-registry-api.json`.
Nothing on that page is hand-written, so a component whose props change cannot leave
a stale table behind; the docs build fails first.

An item's headline export is found by name: `ZoomBarProps` means `ZoomBar`. Guessing
from declaration order picks whatever the file happens to export first, which for
`pdf-viewer-provider` is the context, not the provider.

## Tailwind

`packages/ui/src/styles/globals.css` names this package in an `@source`. Tailwind's
automatic detection reaches that package and whichever app holds the CSS entry, but
no further, so without that line a class used only here is silently never generated.
