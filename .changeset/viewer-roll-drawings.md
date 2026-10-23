---
"@workspace/pdf-viewer": patch
---

The page bitmap is now capped at 65280px on its long side as well as by area, so a
roll drawing longer than about 177:1 gets a stretched bitmap with tiles over it
instead of a `RenderTooLargeError`.
