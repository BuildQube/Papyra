---
"@build-qube/papyra": minor
"@build-qube/papyra-tauri": minor
---

`PagedEngine.renderTile(doc, index, tile, options)` renders one window of a page —
the pixels the whole render would have there — so a page past the 100 MP cap can be
shown in pieces at any zoom. The cap applies to the tile. Tiles are cached (apart
from pages, so they never evict them) and coalesced, on their own queue; `doc.capabilities.tiles` says whether an
engine has them. papyra's engine and `TauriEngine` do, through the addon's
`renderTileAsync` and `x`/`y`/`width`/`height` on the `papyra://` page URL; papyra
runs tiles one at a time in wasm, which measured faster than four. Backends opt in
with `PagedBackend.renderTile` and may set `tileConcurrency`.

`@build-qube/papyra-tauri` now needs `@build-qube/papyra@^0.7.0`.
