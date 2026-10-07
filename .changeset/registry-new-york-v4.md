---
'@workspace/pdf-viewer': patch
---

Fix 404s when installing through the `@papyra` namespace into a Tailwind v4 project
whose `components.json` style is `new-york`, or that names no style.

The shadcn CLI rewrites that style to `new-york-v4` before filling in `{style}`, and the
registry had no directory by that name. Those projects now get the Radix items.

The search results list also no longer uses `Item`'s `xs` size, which the `new-york-v4`
`Item` does not have. It looks the same as before.
