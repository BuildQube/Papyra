---
'@build-qube/papyra-native': patch
---

Render CAD stroke text correctly: a capital M drawn as one open polyline no longer
comes out as a hollow box. hayro 0.7 mistook any five-point path that touched its
bounding box's four corners for a rectangle; papyra now renders on hayro 0.8, which
only takes a path for a rectangle when its edges really are one.
