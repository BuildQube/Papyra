---
'@build-qube/papyra': minor
---

Add `@build-qube/papyra/office` (experimental): Word (`.docx`, `.docm`, `.dotx`,
`.dotm`) and PowerPoint (`.pptx` and its template, show and macro-enabled twins)
pages, laid out and drawn in Rust over WordCraft and DeckCraft.

`PapyraOfficeEngine` is a `PagedEngine`, so its pages get the same queue, coalescing,
render cache and `fitWidth` sizing as a PDF's; `officeEngine` is the shared instance,
and `officeEngine.addFont(bytes)` registers the metric-compatible fonts the layout
depends on. Documents report `RENDER_ONLY` capabilities: pages, no text or links.

It runs on a separate addon, the optional peer `@build-qube/papyra-office-native`,
which `/office` imports on first use, so neither the main entry nor `/core` ever
loads it. That package is not published yet.
