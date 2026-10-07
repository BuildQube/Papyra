---
'@build-qube/papyra': minor
'@build-qube/papyra-native': minor
---

Spreadsheets: `openWorkbook()` reads Excel (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`), OpenDocument (`.ods`), CSV and TSV, in Rust, on both runtimes.

```ts
const book = await openWorkbook(file);
const sheet = await book.sheet(0);
const cells = sheet.window({ rowStart: 0, rowEnd: 50 });
cells.text(0, 0); // 'Item'
```

Only sheet names are read up front; a sheet's cells are parsed the first time
`book.sheet()` asks for it, off the JS thread, and kept. A grid then reads it a
`window()` at a time, which is synchronous and arrives as four flat buffers rather
than an object per cell — `text()` and `kind()` decode nothing they are not asked
for.

- **Every Excel format, including the old ones.** Legacy `.xls` and binary `.xlsb`
  come through calamine with the rest, along with cached formula results, merged
  regions (xlsx and xls), hidden sheets, booleans, errors such as `#DIV/0!`, and
  dates as ISO 8601 beside their serial.
- **CSV that was not written by a programmer.** The encoding is sniffed — a BOM,
  then valid UTF-8, then a statistical guess — so an Excel-on-Windows export in
  windows-1252 reads `Café` and not `Caf�`. The delimiter is sniffed too, so a
  semicolon-separated file from a decimal-comma locale splits correctly. A field
  that is plainly a number is typed as one and keeps its text (`2.50` stays
  `2.50`); `007` stays text.
- **Bounded, whatever the file says.** A sheet holds at most `maxCells` cells
  (default 8 million), and past that it is its first whole rows, with
  `sheet.truncated` set. xlsx and xlsb are streamed into sparse storage, so a file
  with values at opposite corners costs two cells, not the 17 billion between them.
  Zip parts are read by bytes actually inflated, never by their declared size, and
  a decompression bomb is refused rather than read until memory runs out.
- **`EncryptedWorkbookError`** for a password-protected workbook. Not a
  `PasswordError`: there is no decryption to hand a password to.

**xlsx formatting.** Number formats are applied, so `text` is what Excel shows:
`$1,234.50`, `(987.25)`, `25.6%`, `15-Mar-24`. That covers sections, conditions,
`[Red]`-style colours (`CellWindow.color`), percent, thousands scaling, scientific,
fractions, the date and time tokens including elapsed `[h]`, and the 1900 leap-year
bug. The value underneath is unchanged.
`Sheet.styles` and `CellWindow.style` give fonts, fills, borders, alignment,
wrapping and indent. `Sheet.layout` gives column widths and row heights in
Excel's own pixels, hidden rows and columns, and whether gridlines are shown.
`cssColor` turns a style's colour into CSS. Formatting is English-only: locale
tags are ignored. The other formats read unformatted.

The readers ship in the same native addon and wasm build as the PDF renderer, which
grows the wasm by about 610 KB gzipped.
