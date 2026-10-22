# papyra-hayro

[papyra](https://github.com/BuildQube/papyra)'s PDF engine: the
[`papyra-core`](https://crates.io/crates/papyra-core) traits implemented over
[hayro](https://github.com/LaurenzV/hayro), pure Rust from parse to pixels. Beyond
rendering it reads text with geometry, outlines, links, metadata and page labels,
attachments, and the structure tree of a tagged PDF, and converts pages to SVG.

Most users want the npm package,
[`@build-qube/papyra`](https://www.npmjs.com/package/@build-qube/papyra), or the
Tauri plugin, [`tauri-plugin-papyra`](https://crates.io/crates/tauri-plugin-papyra).
