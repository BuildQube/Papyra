---
'@workspace/pdf-viewer': minor
---

Every registry item now has a Radix flavour as well as a Base UI one.

The namespace URL now carries `{style}`, which the shadcn CLI fills from the
project's `components.json`. A Base UI project gets the Base UI items and a Radix
project gets the Radix ones, from the same command:

```bash
npx shadcn@latest registry add @papyra=https://buildqube.github.io/Papyra/r/{style}/{name}.json
```

A project that registered the old `…/r/{name}.json` namespace keeps getting the
Base UI items. Re-running the command above switches it. React Aria projects are not
supported. The full URLs still work too: `r/` for Base UI and `r/radix/` for Radix.

On Radix, the viewer's mobile drawer is sized to the open panel instead of a fixed 80%
of the screen height.

The find bar's "pages partly unreadable" badge now brings its own `TooltipProvider`.
Under Radix, without a provider, it crashed the viewer on any document with unreadable
text.
