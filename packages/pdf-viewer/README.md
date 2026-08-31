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

## Flat, prefixed filenames, and where `src/blocks` goes

`shadcn add` picks an installed file's directory from its **`type`**, never its path:
`registry:block` and `registry:component` both land in the consumer's `components`
alias. The filename comes from matching the target directory's last segment inside
the source path and taking what follows, falling back to the basename when there is
no match. So `src/components/x.tsx` and `src/blocks/x.tsx` both install as
`<components-alias>/x.tsx` — the two directories here are one directory there.

That is why grouping cannot come from a folder *name* in the consumer, and every file
carries a `pdf-` prefix instead. It is also why `src/blocks` is a **sibling** of
`src/components` rather than `src/components/blocks`: a subdirectory *under* the one
the alias resolves to survives the move — `src/components/blocks/x.tsx` would install
as `<components-alias>/blocks/x.tsx` — and every `@/components/pdf-…` import would
then be pointing a level up from the file that satisfies it.

The consequence in this repo: a block naming a sibling block still writes
`@/components/…`, because that is true in a consumer. `tsconfig.json` lists
`src/blocks` as a second candidate for `@/components/*`, and `apps/demo`'s vite alias
carries the same fallback in a `customResolver`, since alias entries are
first-match-wins.

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

The store also carries the **rotation** and the **annotation switch**, for the same
reason: both are document-wide display state that the toolbar writes, the page column
reads, and the thumbnail strip has an opinion about.

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

## Rotation costs no render

papyra renders pages upright — the engine has no transform knob, and the whole point
of `viewport()` is that it does not need one. A rotate button changes three things and
none of them is a rasterisation:

- **The boxes.** `ContinuousPages` lays out from `rotateSize(size, rotation)`, so a
  turned portrait page is a landscape box and the column re-flows.
- **The pixels.** `paintToCanvas(page, canvas, { rotation })` turns the bitmap in the
  draw call. `PageSurface` does re-submit its render on a rotation change, but that
  resubmission is a cache hit — the demo's status line shows the "cached" count going
  up and "0 rendering" throughout. Re-submitting is cheaper than the alternative,
  which is retaining a multi-megabyte bitmap per mounted surface just to repaint it
  later.
- **The overlays.** `Links` and `Highlights` take a `pageViewport` rather than a bare
  scale, and map through `viewportRect`/`viewportQuad`. This is the part that is easy
  to get subtly wrong and hard to notice: a highlight a quarter turn out still looks
  like a highlight. `rotated.pdf` in the demo fixtures is the case to check against —
  its diagonal label's highlight has to stay a parallelogram at the *text's* own
  angle while the *view* turns underneath it.

Sizing has one trap. A render's `fitWidth` fits the page's own width; a viewport's
fits the width **on screen**, which at 90° is the page's height. Build the viewport,
then hand `vp.dpi` to the render — the blocks do this, and `useZoom` is given the
rotated size so the fit modes measure what the reader sees.

The thumbnail strip is the one place that is deliberately inconsistent: it follows the
rotation, because that is a repaint, but it does **not** follow the annotation switch,
because that would re-stream every page in the document on a toggle. The strip is a
navigation aid with no overlay of its own, which is the case the switch exists for.

## The registry

`registry.json` is the source; `bun run build:registry` turns it into
`apps/demo/public/r/*.json`, which the demo serves alongside itself. Turbo runs it
before the demo's build, so the items ship with the site.

```bash
npx shadcn@latest add https://buildqube.github.io/Papyra/r/pdf-sidebar.json
```

**This package is versioned even though it is never published.** An item installed by
URL carries no version with it, so `package.json` and `CHANGELOG.md` here are the only
record of what changed under a given item's name — `.changeset/config.json` therefore
leaves it out of `ignore` and sets `privatePackages: { version: true, tag: false }`.
Changing an item means writing a changeset for it, the same as for the wrapper.

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

## Blocks

Five, from a whole reader down to a picture of a page:

| Item | What it is |
| --- | --- |
| `pdf-viewer` | Sidebar, toolbar, continuous column. The reader. |
| `pdf-viewer-basic` | One page, a pager and zoom. The one to embed. |
| `pdf-page-preview` | A page as an image. No interaction. |
| `pdf-thumbnail-picker` | Pick a page out of a grid. |
| `pdf-preview-dialog` | A document in a dialog, for attachments. |

`pdf-viewer` is **continuous only** and `pdf-viewer-basic` is single-page. Carrying
both modes in one block would double the zoom-anchoring work for a choice most
applications make once — and the two anchor differently, which is the actual cost: a
single page scales about the cursor exactly, while a continuous column cannot, because
the gaps between pages do not scale with the pages. The mode still lives in the store,
so adding a toggle is a UI change rather than a state change.

Only `pdf-viewer` uses the store. The others hold what little state they have —
a page index, a selection — and are controlled or uncontrolled at the caller's
choice, which keeps them usable anywhere.

Blocks take a `Document`, never a `File`. Opening a PDF means owning a file input, a
password prompt and a policy for failures, all of which belong to the application.

Every block wraps itself in `PdfIsolationGuard`. papyra's browser build needs
`SharedArrayBuffer`, so the page must be cross-origin isolated, and without the two
headers the symptom is a blank area and a console message nobody reads. The guard
turns that into a two-line config change.

## The showcase

`apps/demo`'s `/components` route renders this registry: the sidebar, the install
command, the dependency badges and the props table all come from the two artifacts
the build already produces — `r/registry.json` and `papyra-registry-api.json`.
Nothing on that page is hand-written, so a component whose props change cannot leave
a stale table behind; the docs build fails first.

Blocks additionally get a **live preview** — the real component, over a real
document. It renders whatever the reader already has open, and `sample.pdf`
otherwise, so the page works cold; that file is generated by
`scripts/make-sample-pdf.ts` rather than copied, so nothing here carries someone
else's licence. Previews mount on an `IntersectionObserver` and are never unmounted:
starting a dozen render queues at once would beat the reader to the first one, and
tearing a viewer down on scroll-past would throw away the render cache that is the
expensive part.

An item's headline export is found by name: `ZoomBarProps` means `ZoomBar`. Guessing
from declaration order picks whatever the file happens to export first, which for
`pdf-viewer-provider` is the context, not the provider.

## Tailwind

`packages/ui/src/styles/globals.css` names this package in an `@source`. Tailwind's
automatic detection reaches that package and whichever app holds the CSS entry, but
no further, so without that line a class used only here is silently never generated.
