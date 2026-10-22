# papyra-encode

Turns a [`papyra-core`](https://crates.io/crates/papyra-core) `Bitmap` into WebP,
PNG or JPEG bytes. Every codec is pure Rust, so it builds for `wasm32` with no C
toolchain; that is also why WebP is lossless (VP8L) only and there is no AVIF.

Part of [papyra](https://github.com/BuildQube/papyra).
