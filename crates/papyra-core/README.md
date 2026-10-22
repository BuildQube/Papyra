# papyra-core

The engine-agnostic half of [papyra](https://github.com/BuildQube/papyra): the
`Engine` and `Document` traits, `Bitmap`, `PageSize` and `RenderOptions`. It depends
on no PDF library, so a second backend can implement the traits without touching the
callers.

`papyra-hayro` is the implementation papyra ships. Most users want the npm package,
[`@build-qube/papyra`](https://www.npmjs.com/package/@build-qube/papyra), or the
Tauri plugin, [`tauri-plugin-papyra`](https://crates.io/crates/tauri-plugin-papyra).
