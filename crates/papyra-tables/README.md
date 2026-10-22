# papyra-tables

The spreadsheet half of [papyra](https://github.com/BuildQube/papyra): Excel
(`.xlsx`, `.xlsm`, `.xlsb`, `.xls`) and OpenDocument (`.ods`) over calamine, and CSV
and TSV with the encoding and delimiter sniffed. Every format reads into the same
sparse `Sheet`, which hands out windows of cells as flat buffers, and xlsx keeps its
styles, column widths, row heights and number formats.

Most users want the npm package,
[`@build-qube/papyra`](https://www.npmjs.com/package/@build-qube/papyra), or the
Tauri plugin's `tables` feature,
[`tauri-plugin-papyra`](https://crates.io/crates/tauri-plugin-papyra).
