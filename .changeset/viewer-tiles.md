---
"@workspace/pdf-viewer": minor
---

The page column shows a page past its 24 MP bitmap in sharp 1024px tiles instead of
stretching it: an ARCH-E sheet at 400% no longer blurs. The stretched bitmap stays
underneath until the tiles over it land, tiles render at steps of √2 so a pinch
does not re-render at every frame, and only what is on screen is rendered. Every item now declares `@build-qube/papyra@^0.7.0`.
