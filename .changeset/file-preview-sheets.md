---
'@workspace/pdf-viewer': minor
---

File preview: spreadsheets and CSV, as two more renderer items.

- **`file-preview-spreadsheet`** (`spreadsheetRenderer`, id `spreadsheet`) shows
  `.xlsx`, `.xlsm`, `.xlsb`, legacy `.xls` and `.ods`. Visible sheets become tabs,
  and the status line counts hidden ones instead of showing them. A
  password-protected workbook gets a card saying so, with no prompt, because
  there is nothing to decrypt it with.
- **`file-preview-csv`** (`csvRenderer`, id `csv`) shows `.csv` and `.tsv`. The
  status line names the encoding and delimiter it guessed, so a wrong guess is
  visible rather than looking like broken data.
- **`file-preview-sheet`** is the grid both of them install. It draws only the
  cells on screen, so a 100,000-row CSV keeps under a hundred cells in the DOM.
  Past a few million pixels of height the scrollbar maps proportionally, staying
  under the browser's cap on element size. Headers stick, merged cells span, and
  column widths are estimated from the first and last rows.

Both renderers match by name. An `.xls` shares its container with `.doc` and an
`.xlsx` with `.docx`, so claiming those signatures would also claim Word files.
papyra sniffs the bytes again, so a `.xls` that is really a CSV still shows.

Detection now prefers the most specific match: the extension, then an exact MIME
type, then a wildcard. Before, `code`'s `text/*` would take a `text/csv` file
whenever `code` was listed first. Windows with Excel installed reports `.csv`
files as `application/vnd.ms-excel`, and the extension now wins over that.

Both items need `@build-qube/papyra@^0.4.0`, the first release with `openWorkbook`.
