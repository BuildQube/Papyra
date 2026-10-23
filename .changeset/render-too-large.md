---
"@build-qube/papyra": minor
"@build-qube/papyra-native": minor
---

A render too large to make now rejects with `RenderTooLargeError` (a `RangeError`)
instead of aborting. On wasm, a failed allocation or a panic killed the worker and
left the promise pending forever. The bindings now refuse any side over 65280
(vello_cpu panics past that) or any bitmap over 2 GiB, and allocate the bitmap
fallibly. The 100 MP cap papyra already had throws the same class, and refuses the
side limit too. hayro's own buffers (soft masks, patterns, image decoding) are
still allocated infallibly, so a render on a nearly full wasm heap can still abort.

On wasm, `renderPages` now refuses up front a batch whose bitmaps add up to more
than 2 GiB. Every page it holds stays in wasm memory until it is collected, and
wasm32 stops at 4 GB. A 90-sheet ARCH-E set at 150 DPI is 10 GB. Use `stream` or
`render` for a document like that.

`PapyraError` in the `papyra-core` crate is now `#[non_exhaustive]`, and gains a
`TooLarge` variant. This is the minor release for Rust consumers: a `match` on it
needs a wildcard arm from now on, so later variants will not be breaking changes.
