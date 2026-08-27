---
'@build-qube/papyra': patch
---

Document every remaining public export, and generate an API reference from those
comments.

75 exported members carried no TSDoc — `CacheStats.hits`, `PageImage.toWebp`,
`backend()`, the `Document` class itself — so they reached consumers as bare names
in an editor tooltip. They are documented now, and the emitted `.d.ts` carries the
prose with them.

Keeping it that way is mechanical rather than a matter of discipline: the reference
at `/docs` is rendered from TypeDoc's model of this package, and an export with no
doc comment now fails the build instead of shipping a blank entry.

The package also has a README for the first time, so its npm page is no longer blank
— a quickstart, and the two things most likely to bite (`fitWidth` over `dpi`, and
cross-origin isolation in the browser). It opens the reference page too, from the
same file.

No API change.
