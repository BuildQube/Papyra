# papyra-tiff

The TIFF reader of [papyra](https://github.com/BuildQube/papyra): single and
multi-page, classic and BigTIFF, CCITT Group 3 and Group 4 fax pages included. A
page is never held at full size — it is reduced to a capped papyra `Bitmap` while it
decodes — so a 300-dpi E-size scan opens in tens of milliseconds and megabytes, not
gigabytes.

Most users want the npm package,
[`@build-qube/papyra`](https://www.npmjs.com/package/@build-qube/papyra), or the
Tauri plugin's `tiff` feature,
[`tauri-plugin-papyra`](https://crates.io/crates/tauri-plugin-papyra).
