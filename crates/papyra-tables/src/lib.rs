//! Spreadsheet and delimited-text readers for papyra.
//!
//! Knows nothing about PDFs and nothing about napi: bytes go in, a [`Workbook`] of
//! [`Sheet`]s comes out, and a sheet hands out rectangular [`Window`]s for a grid to
//! draw. Excel and OpenDocument go through calamine; CSV and TSV through the `csv`
//! crate, after the encoding and the delimiter have been worked out.
//!
//! Both paths produce the same `Sheet`, which is the point — one grid renders a
//! `.xls` from 2003 and a semicolon-separated export from a German bank alike.

mod book;
mod cell;
mod delimited;
mod numfmt;
mod styles;

pub use cell::{Cell, CellKind, Window};
pub use delimited::DelimitedOptions;
pub use styles::{BorderStyle, CellStyle, ColSpan, Edge, HAlign, Layout, RowSize, VAlign};

use std::sync::{Arc, Mutex};

/// Everything that can go wrong reading a table.
#[derive(Debug, thiserror::Error)]
pub enum TableError {
  /// The workbook is encrypted. Excel encrypts the whole package, so there is nothing
  /// to read without the password — and calamine cannot decrypt, with one or without.
  #[error("this workbook is password-protected")]
  Encrypted,
  /// Not a format this crate reads.
  #[error("unrecognised spreadsheet format")]
  UnknownFormat,
  #[error("no sheet at index {0}")]
  SheetOutOfRange(usize),
  #[error("{0}")]
  Parse(String),
  /// A part of the file inflates past what papyra will hold, which is how a
  /// decompression bomb presents. Refused rather than read until memory runs out —
  /// on wasm that traps the instance, and every other view on the page with it.
  #[error("{0} is larger than papyra will read")]
  TooLarge(String),
}

/// The default cap on cells held per sheet. At roughly 48 bytes a cell that is
/// about 400 MB, which a browser tab survives; past it a sheet is truncated to its
/// first whole rows and says so. [`LoadOptions::max_cells`] moves it.
pub const DEFAULT_MAX_CELLS: usize = 8_000_000;

/// Collects a sheet's non-empty cells, up to a cap.
pub(crate) struct Cells {
  cells: Vec<(u32, u32, Cell)>,
  limit: usize,
  truncated: bool,
  /// An extent the reader knows of beyond the last value, as `(rows, cols)`.
  extent: (u32, u32),
}

impl Cells {
  pub(crate) fn new(limit: usize) -> Self {
    Self {
      cells: Vec::new(),
      limit,
      truncated: false,
      extent: (0, 0),
    }
  }

  /// Make the sheet at least `rows` by `cols`, values or not.
  pub(crate) fn extend_to(&mut self, rows: u32, cols: u32) {
    self.extent = (self.extent.0.max(rows), self.extent.1.max(cols));
  }

  /// Add a cell. `false` once the cap is reached, and reading should stop.
  pub(crate) fn push(&mut self, row: u32, col: u32, cell: Cell) -> bool {
    if cell == Cell::Empty {
      return true;
    }
    if self.cells.len() >= self.limit {
      // End on a whole row: half a row reads as data that is not there. Unless
      // the row is all there is — one row wider than the cap — in which case its
      // first part is better than nothing.
      self.truncated = true;
      if self.cells.iter().any(|&(r, ..)| r < row) {
        self.cells.retain(|&(r, ..)| r < row);
      }
      return false;
    }
    self.cells.push((row, col, cell));
    true
  }

  pub(crate) fn truncated(&self) -> bool {
    self.truncated
  }

  /// Sorted, for lookup. Readers emit cells in row order, so this is a check more
  /// than a sort — but nothing in the formats promises it.
  pub(crate) fn finish(mut self) -> Self {
    self.cells.sort_by_key(|&(r, c, _)| (r, c));
    // A cell written twice keeps its last value, as a reader replaying the file would.
    self.cells.dedup_by(|later, earlier| {
      let same = (later.0, later.1) == (earlier.0, earlier.1);
      if same {
        std::mem::swap(later, earlier);
      }
      same
    });
    self
  }
}

pub type Result<T> = std::result::Result<T, TableError>;

/// The container a workbook was read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
  /// Office Open XML, macro-enabled or not. calamine reads `.xlsm` identically.
  Xlsx,
  /// Excel's binary Office Open XML variant.
  Xlsb,
  /// BIFF8 inside an OLE compound file — Excel 97 to 2003.
  Xls,
  /// OpenDocument.
  Ods,
  Csv,
  Tsv,
}

impl Format {
  /// Lower-case name, matching the usual file extension.
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Xlsx => "xlsx",
      Self::Xlsb => "xlsb",
      Self::Xls => "xls",
      Self::Ods => "ods",
      Self::Csv => "csv",
      Self::Tsv => "tsv",
    }
  }

  /// Parse an extension-like name. `xlsm`, `xltx` and `xltm` are all `Xlsx` to a reader.
  pub fn parse(name: &str) -> Option<Self> {
    Some(match name.to_ascii_lowercase().as_str() {
      "xlsx" | "xlsm" | "xltx" | "xltm" => Self::Xlsx,
      "xlsb" => Self::Xlsb,
      "xls" | "xlt" => Self::Xls,
      "ods" | "ots" => Self::Ods,
      "csv" => Self::Csv,
      "tsv" | "tab" => Self::Tsv,
      _ => return None,
    })
  }

  /// Sniff the format from the leading bytes.
  ///
  /// The two binary containers have magic numbers; text has none, so anything that is
  /// neither is taken to be delimited text. A zip is narrowed later by its entries —
  /// xlsx, xlsb and ods are all zips — so this answers `Xlsx` for every one of them
  /// and [`Workbook::load`] tries the others.
  pub fn sniff(bytes: &[u8]) -> Self {
    if bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
      Self::Xls
    } else if bytes.starts_with(b"PK\x03\x04") {
      Self::Xlsx
    } else {
      Self::Csv
    }
  }

  fn is_delimited(self) -> bool {
    matches!(self, Self::Csv | Self::Tsv)
  }
}

/// Whether a sheet shows in the application's tab bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
  Visible,
  /// Hidden, but the user can unhide it.
  Hidden,
  /// Hidden, and only a macro can unhide it. Excel only.
  VeryHidden,
}

/// What a sheet holds. Only worksheets have cells worth showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SheetKind {
  Worksheet,
  Chartsheet,
  Dialog,
  Macro,
  Vba,
}

/// A sheet's entry in the workbook, available without reading its cells.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SheetInfo {
  pub name: String,
  pub kind: SheetKind,
  pub visibility: Visibility,
}

/// Rows and columns a merged cell covers, inclusive at both ends, 0-based.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Merge {
  pub row_start: u32,
  pub col_start: u32,
  pub row_end: u32,
  pub col_end: u32,
}

/// One sheet's cells, read.
///
/// Coordinates are the sheet's own: row 0 is the row Excel calls 1, whatever row the
/// data starts on. A sheet whose only value is in F10 is ten rows by six columns with
/// one cell set, so a grid draws it where the author put it.
///
/// Cells are held sparsely — only the ones with a value — so memory follows what
/// the file contains and not its bounding box. A sheet with values in A1 and
/// XFD1048576 is two cells, not seventeen billion.
#[derive(Debug, Clone, PartialEq)]
pub struct Sheet {
  pub name: String,
  /// One past the last row holding a value or covered by a merge.
  pub rows: u32,
  /// One past the last column holding a value or covered by a merge.
  pub cols: u32,
  pub merges: Vec<Merge>,
  /// Column widths and row heights, for xlsx. `None` for every other format, which
  /// leaves sizing to whoever draws the sheet.
  pub layout: Option<Layout>,
  /// The sheet held more cells than the cap, and this is its first whole rows.
  pub truncated: bool,
  /// `(row, col, value)` for every non-empty cell, row-major.
  cells: Vec<(u32, u32, Cell)>,
  formatting: Option<Formatting>,
}

/// An xlsx sheet's formatting, which no other format carries.
#[derive(Debug, Clone)]
struct Formatting {
  styles: Arc<styles::StyleSheet>,
  /// `(row, col, style)`, row-major, for every cell whose style is not the default.
  /// Sparse because styles routinely reach far past the data — a formatted but
  /// empty block, a bordered print area.
  cells: Vec<(u32, u32, u16)>,
  date1904: bool,
}

impl PartialEq for Formatting {
  fn eq(&self, other: &Self) -> bool {
    Arc::ptr_eq(&self.styles, &other.styles) && self.cells == other.cells
  }
}

impl Sheet {
  pub(crate) fn new(name: String, cells: Cells, merges: Vec<Merge>) -> Self {
    let Cells {
      cells,
      truncated,
      extent,
      ..
    } = cells.finish();
    let rows = cells.last().map_or(0, |&(r, ..)| r + 1).max(extent.0);
    let cols = cells
      .iter()
      .map(|&(_, c, _)| c + 1)
      .max()
      .unwrap_or(0)
      .max(extent.1);
    // A merge can reach past the last value — a title spanning empty columns — and
    // the grid has to be wide enough to draw it. On a truncated sheet only the merges
    // that start in the rows kept are kept.
    let merges: Vec<Merge> = merges
      .into_iter()
      .filter(|m| !truncated || m.row_start < rows)
      .collect();
    let (mut rows, mut cols) = (rows, cols);
    for m in &merges {
      if !truncated {
        rows = rows.max(m.row_end + 1);
      }
      cols = cols.max(m.col_end + 1);
    }
    Self {
      name,
      rows,
      cols,
      merges,
      layout: None,
      truncated,
      cells,
      formatting: None,
    }
  }

  /// Attach what the xlsx style pass found.
  pub(crate) fn with_formatting(
    mut self,
    styles: Arc<styles::StyleSheet>,
    meta: styles::SheetMeta,
    date1904: bool,
  ) -> Self {
    // A fill or a border shows on an empty cell, so the grid has to reach it — a
    // coloured header band often runs past the last column with a value in it.
    for &(r, c, s) in &meta.cells {
      // A truncated sheet ends where its cells were cut, fills or not.
      if (!self.truncated || r < self.rows)
        && styles
          .styles
          .get(s as usize)
          .is_some_and(|s| s.is_visible_when_empty())
      {
        self.rows = self.rows.max(r + 1);
        self.cols = self.cols.max(c + 1);
      }
    }
    self.layout = meta.layout;
    self.formatting = Some(Formatting {
      styles,
      cells: meta.cells,
      date1904,
    });
    self
  }

  /// The styles cells refer to by index. Empty when the format carries none.
  pub fn styles(&self) -> &[CellStyle] {
    self.formatting.as_ref().map_or(&[], |f| &f.styles.styles)
  }

  /// The style index of the cell at `(row, col)`; 0, the default, when it has none.
  pub fn style(&self, row: u32, col: u32) -> u16 {
    let Some(f) = &self.formatting else { return 0 };
    f.cells
      .binary_search_by_key(&(row, col), |&(r, c, _)| (r, c))
      .map_or(0, |i| f.cells[i].2)
  }

  /// What the cell at `(row, col)` shows: its value through its number format, and
  /// any colour the format chose.
  pub fn display(&self, row: u32, col: u32) -> (std::borrow::Cow<'_, str>, Option<u32>) {
    let cell = self.cell(row, col);
    let Some(f) = &self.formatting else {
      return (cell.text(), None);
    };
    let Some(format) = f.styles.format(self.style(row, col)) else {
      return (cell.text(), None);
    };
    let number = match cell {
      Cell::Number(n) => Some(*n),
      // A date or duration keeps its ISO form under General, and the serial is NaN
      // when the file only stored that form.
      Cell::Date(n, _) | Cell::Duration(n, _) if n.is_finite() && !format.is_general() => Some(*n),
      Cell::Text(s) => {
        return match format.format_text(s) {
          Some(t) => (t.text.into(), t.color),
          None => (cell.text(), None),
        };
      }
      _ => None,
    };
    match number {
      Some(n) if !format.is_general() => {
        let t = format.format(n, f.date1904);
        (t.text.into(), t.color)
      }
      _ => (cell.text(), None),
    }
  }

  /// The cell at `(row, col)`. Anything without a value is empty.
  pub fn cell(&self, row: u32, col: u32) -> &Cell {
    static EMPTY: Cell = Cell::Empty;
    self
      .cells
      .binary_search_by_key(&(row, col), |&(r, c, _)| (r, c))
      .map_or(&EMPTY, |i| &self.cells[i].2)
  }

  /// Encode `[row_start, row_end) x [col_start, col_end)` for transfer, clamped to
  /// the sheet.
  pub fn window(&self, row_start: u32, row_end: u32, col_start: u32, col_end: u32) -> Window {
    let row_end = row_end.min(self.rows);
    let col_end = col_end.min(self.cols);
    let row_start = row_start.min(row_end);
    let col_start = col_start.min(col_end);
    Window::encode(
      row_start,
      col_start,
      row_end - row_start,
      col_end - col_start,
      |r, c| {
        let (text, color) = self.display(r, c);
        cell::Entry {
          cell: self.cell(r, c),
          text,
          style: self.style(r, c),
          color,
        }
      },
    )
  }
}

/// Options for [`Workbook::load`].
#[derive(Debug, Clone)]
pub struct LoadOptions {
  /// Skip sniffing. Needed to tell a TSV from a CSV, which share every byte but one.
  pub format: Option<Format>,
  /// Applies to CSV and TSV only.
  pub delimited: DelimitedOptions,
  /// Cells held per sheet before it is truncated. See [`DEFAULT_MAX_CELLS`].
  pub max_cells: usize,
}

impl Default for LoadOptions {
  fn default() -> Self {
    Self {
      format: None,
      delimited: DelimitedOptions::default(),
      max_cells: DEFAULT_MAX_CELLS,
    }
  }
}

enum Source {
  /// Boxed: calamine's readers are a few hundred bytes, and a CSV carries none.
  Book(Box<Mutex<book::Reader>>),
  /// Delimited text is a single sheet, read entirely while loading: there is no index
  /// to read part of it from.
  Text(Arc<Sheet>),
}

/// An opened workbook.
///
/// Excel and OpenDocument sheets are read on first request and then kept, because a
/// workbook routinely carries a dozen sheets nobody opens.
pub struct Workbook {
  format: Format,
  sheets: Vec<SheetInfo>,
  source: Source,
  loaded: Mutex<Vec<Option<Arc<Sheet>>>>,
  /// The encoding delimited text was decoded from, e.g. `"windows-1252"`.
  encoding: Option<&'static str>,
  delimiter: Option<u8>,
}

impl Workbook {
  pub fn load(bytes: Vec<u8>, options: &LoadOptions) -> Result<Self> {
    let format = options.format.unwrap_or_else(|| Format::sniff(&bytes));
    if format.is_delimited() {
      let mut opts = options.delimited.clone();
      if format == Format::Tsv && opts.delimiter.is_none() {
        opts.delimiter = Some(b'\t');
      }
      let text = delimited::read(&bytes, &opts, options.max_cells)?;
      let format = if text.delimiter == b'\t' {
        Format::Tsv
      } else {
        Format::Csv
      };
      let info = SheetInfo {
        name: text.sheet.name.clone(),
        kind: SheetKind::Worksheet,
        visibility: Visibility::Visible,
      };
      return Ok(Self {
        format,
        sheets: vec![info],
        source: Source::Text(Arc::new(text.sheet)),
        loaded: Mutex::new(Vec::new()),
        encoding: Some(text.encoding),
        delimiter: Some(text.delimiter),
      });
    }

    let (reader, format) = book::Reader::open(bytes, format, options.max_cells)?;
    let sheets = reader.sheets();
    Ok(Self {
      format,
      loaded: Mutex::new(vec![None; sheets.len()]),
      sheets,
      source: Source::Book(Box::new(Mutex::new(reader))),
      encoding: None,
      delimiter: None,
    })
  }

  pub fn format(&self) -> Format {
    self.format
  }

  pub fn sheets(&self) -> &[SheetInfo] {
    &self.sheets
  }

  /// The text encoding delimited input was decoded from. `None` for a workbook.
  pub fn encoding(&self) -> Option<&'static str> {
    self.encoding
  }

  /// The delimiter used, sniffed or given. `None` for a workbook.
  pub fn delimiter(&self) -> Option<u8> {
    self.delimiter
  }

  /// Read one sheet's cells, or return them if they were read before.
  pub fn sheet(&self, index: usize) -> Result<Arc<Sheet>> {
    if index >= self.sheets.len() {
      return Err(TableError::SheetOutOfRange(index));
    }
    let reader = match &self.source {
      Source::Text(sheet) => return Ok(sheet.clone()),
      Source::Book(reader) => reader,
    };
    if let Some(sheet) = lock(&self.loaded)[index].clone() {
      return Ok(sheet);
    }
    // Two callers asking for the same sheet at once both read it, rather than one
    // holding `loaded` across the parse and blocking requests for every other sheet.
    // The reader's own lock serialises the parsing either way.
    let sheet = Arc::new(lock(reader).read_sheet(index, &self.sheets[index].name)?);
    Ok(lock(&self.loaded)[index].get_or_insert(sheet).clone())
  }
}

/// A poisoned lock here means a panic mid-parse, which napi already turned into a
/// rejected promise. The data behind it is a cache or a reader that has not been
/// mutated half-way in any way that matters, so carry on rather than poison every
/// later call on the workbook too.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
  m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn sample(name: &str) -> Vec<u8> {
    std::fs::read(format!(
      "{}/tests/fixtures/{name}",
      env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
  }

  #[test]
  fn workbook_is_send_and_sync() {
    fn check<T: Send + Sync>() {}
    check::<Workbook>();
  }

  #[test]
  fn sniffs_the_two_binary_containers_and_falls_back_to_text() {
    assert_eq!(Format::sniff(&sample("sample.xls")), Format::Xls);
    assert_eq!(Format::sniff(&sample("sample.xlsx")), Format::Xlsx);
    assert_eq!(Format::sniff(b"a,b\n1,2\n"), Format::Csv);
  }

  /// The shared expectations from `tests/fixtures/generate.py`, against every format
  /// that can represent them.
  fn assert_summary(book: &Workbook) {
    let s = book.sheet(0).unwrap();
    assert_eq!(s.name, "Summary");
    assert_eq!((s.rows, s.cols), (5, 4));
    assert_eq!(s.cell(0, 0), &Cell::Text("Item".into()));
    assert_eq!(s.cell(1, 1), &Cell::Number(12.0));
    assert_eq!(s.cell(2, 0), &Cell::Text("Nuts \u{2014} M8".into()));
    assert_eq!(s.cell(2, 2), &Cell::Number(0.1));
    assert_eq!(s.cell(4, 0), &Cell::Bool(true));
    assert_eq!(s.cell(1, 3).text(), "2024-03-15");
    assert_eq!(s.cell(2, 3).text(), "2024-03-15T13:30:00");
    assert_eq!(s.cell(99, 99), &Cell::Empty);
  }

  #[test]
  fn reads_xlsx() {
    let book = Workbook::load(sample("sample.xlsx"), &LoadOptions::default()).unwrap();
    assert_eq!(book.format(), Format::Xlsx);
    assert_summary(&book);
    let s = book.sheet(0).unwrap();
    assert_eq!(s.cell(4, 2), &Cell::Error("#DIV/0!".into()));
    assert_eq!(
      s.merges,
      vec![Merge {
        row_start: 3,
        col_start: 0,
        row_end: 3,
        col_end: 1
      }]
    );
  }

  #[test]
  fn reads_xls() {
    let book = Workbook::load(sample("sample.xls"), &LoadOptions::default()).unwrap();
    assert_eq!(book.format(), Format::Xls);
    assert_summary(&book);
    assert_eq!(book.sheet(0).unwrap().merges.len(), 1);
  }

  #[test]
  fn reads_ods() {
    let book = Workbook::load(sample("sample.ods"), &LoadOptions::default()).unwrap();
    assert_eq!(book.format(), Format::Ods);
    assert_summary(&book);
  }

  #[test]
  fn applies_xlsx_number_formats_and_styles() {
    let book = Workbook::load(sample("styled.xlsx"), &LoadOptions::default()).unwrap();
    let s = book.sheet(0).unwrap();
    let text = |r, c| s.display(r, c).0.into_owned();

    // The values are unchanged; only what they display as is.
    assert_eq!(s.cell(2, 1), &Cell::Number(1234.5));
    assert_eq!(text(2, 1), "1,234.50");
    assert_eq!(text(3, 1), "(987.25)");
    assert_eq!(s.display(3, 1).1, Some(0xFF0000));
    assert_eq!(text(2, 2), "25.6%");
    assert_eq!(text(2, 3), "15-Mar-24");
    assert_eq!(text(3, 3), "1-Dec-24");
    // An unformatted cell is unchanged.
    assert_eq!(text(2, 0), "Steel");

    let style = |r, c| &s.styles()[s.style(r, c) as usize];
    let title = style(0, 0);
    assert!(title.bold);
    assert_eq!(title.font_scale, 2.0);
    assert_eq!(title.color, Some(0x1F4E79));
    let header = style(1, 1);
    assert_eq!(header.fill, Some(0x4472C4));
    assert_eq!(header.color, Some(0xFFFFFF));
    assert_eq!(header.h_align, Some(HAlign::Center));
    assert_eq!(header.border[2].map(|e| e.style), Some(BorderStyle::Double));
    assert!(style(2, 0).italic);
    assert_eq!(
      style(2, 1).border[0].map(|e| e.style),
      Some(BorderStyle::Thin)
    );
    assert!(style(4, 0).wrap);
    assert_eq!(style(4, 0).v_align, Some(VAlign::Top));
    assert_eq!(s.style(0, 9), 0);

    // A filled cell with nothing in it still widens the sheet to reach it.
    assert_eq!(s.cols, 5);
    let layout = s.layout.as_ref().unwrap();
    assert!(!layout.show_grid_lines);
    assert!(layout.cols.contains(&ColSpan {
      first: 0,
      last: 0,
      width: 145.0
    }));
    assert!(layout.cols.iter().any(|c| c.first == 5 && c.width == 0.0));
    assert!(layout.rows.contains(&RowSize {
      row: 0,
      height: 40.0
    }));
    assert!(layout.rows.contains(&RowSize {
      row: 5,
      height: 0.0
    }));

    // The window carries the same: a style per cell, and the format's colour.
    let w = s.window(3, 4, 1, 2);
    assert_eq!(w.text, "(987.25)");
    assert_eq!(w.colors, vec![0x01FF_0000]);
    assert_eq!(w.styles, vec![s.style(3, 1)]);
  }

  #[test]
  fn far_apart_cells_cost_two_cells_not_their_bounding_box() {
    // A1 and XFD1048576: through calamine's dense `worksheet_range` this is a
    // seventeen-billion-cell allocation — a hung process natively, and a usize
    // overflow and an abort on wasm32. Streamed, it is two cells.
    let book = Workbook::load(sample("extent.xlsx"), &LoadOptions::default()).unwrap();
    let s = book.sheet(0).unwrap();
    assert_eq!((s.rows, s.cols), (1_048_576, 16_384));
    assert_eq!(s.cells.len(), 2);
    assert_eq!(s.cell(1_048_575, 16_383), &Cell::Text("bottom".into()));
    let w = s.window(1_048_570, 1_048_576, 16_380, 16_384);
    assert!(w.text.ends_with("bottom"));
  }

  /// Rewrite the uncompressed size `name` declares, in both the local header and the
  /// central directory, leaving the data alone.
  fn forge_declared_size(mut zip: Vec<u8>, name: &str, size: u32) -> Vec<u8> {
    let name = name.as_bytes();
    let mut patched = 0;
    let mut i = 0;
    while i + 46 <= zip.len() {
      let sig = u32::from_le_bytes(zip[i..i + 4].try_into().unwrap());
      let (size_at, name_len_at, name_at) = match sig {
        0x0403_4b50 => (22, 26, 30),
        0x0201_4b50 => (24, 28, 46),
        _ => {
          i += 1;
          continue;
        }
      };
      let len = u16::from_le_bytes(
        zip[i + name_len_at..i + name_len_at + 2]
          .try_into()
          .unwrap(),
      );
      if zip.get(i + name_at..i + name_at + len as usize) == Some(name) {
        zip[i + size_at..i + size_at + 4].copy_from_slice(&size.to_le_bytes());
        patched += 1;
      }
      i += 4;
    }
    assert_eq!(patched, 2, "both headers");
    zip
  }

  #[test]
  fn a_forged_entry_size_is_never_allocated() {
    // 4 GB declared for a few-kilobyte part. Reserved up front, that is an abort on
    // wasm32 and a 4 GB allocation natively, for a file smaller than this comment.
    for part in [
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/workbook.xml",
    ] {
      let bytes = forge_declared_size(sample("styled.xlsx"), part, 0xFFFF_FFF0);
      // Whether the zip reader then notices the lie is its business; the load must
      // end in a result either way, never in a dead process.
      if let Ok(book) = Workbook::load(bytes, &LoadOptions::default()) {
        let _ = book.sheet(0);
      }
    }
  }

  #[test]
  fn past_the_cap_a_workbook_is_its_first_whole_rows() {
    let opts = LoadOptions {
      max_cells: 5,
      ..Default::default()
    };
    // The summary sheet has four values a row: five cells is one whole row and one
    // more, so the sheet is the header row alone.
    let book = Workbook::load(sample("sample.xlsx"), &opts).unwrap();
    let s = book.sheet(0).unwrap();
    assert!(s.truncated);
    assert_eq!(s.rows, 1);
    assert_eq!(s.cell(0, 3), &Cell::Text("Due".into()));
    assert_eq!(s.cell(1, 0), &Cell::Empty);
    // The merge on row 4 started past the cut, so it went with the rows.
    assert!(s.merges.is_empty());

    let whole = Workbook::load(sample("sample.xlsx"), &LoadOptions::default()).unwrap();
    assert!(!whole.sheet(0).unwrap().truncated);
  }

  #[test]
  fn other_formats_carry_no_styles() {
    for name in ["sample.xls", "sample.ods"] {
      let book = Workbook::load(sample(name), &LoadOptions::default()).unwrap();
      let s = book.sheet(0).unwrap();
      assert!(s.styles().is_empty(), "{name}");
      assert!(s.layout.is_none(), "{name}");
      assert_eq!(s.window(0, 5, 0, 4).styles, vec![0; 20], "{name}");
    }
  }

  #[test]
  fn a_sheet_keeps_its_offset_from_a1() {
    for name in ["sample.xlsx", "sample.xls"] {
      let book = Workbook::load(sample(name), &LoadOptions::default()).unwrap();
      assert_eq!(book.sheets()[1].visibility, Visibility::Hidden, "{name}");
      let s = book.sheet(1).unwrap();
      assert_eq!((s.rows, s.cols), (10, 6), "{name}");
      assert_eq!(s.cell(9, 5), &Cell::Text("far".into()), "{name}");
      assert_eq!(s.cell(0, 0), &Cell::Empty, "{name}");
    }
  }

  #[test]
  fn a_sheet_is_read_once() {
    let book = Workbook::load(sample("sample.xlsx"), &LoadOptions::default()).unwrap();
    assert!(Arc::ptr_eq(
      &book.sheet(0).unwrap(),
      &book.sheet(0).unwrap()
    ));
    assert!(matches!(book.sheet(2), Err(TableError::SheetOutOfRange(2))));
  }

  #[test]
  fn a_merge_past_the_data_widens_the_sheet() {
    let merge = Merge {
      row_start: 0,
      col_start: 0,
      row_end: 0,
      col_end: 7,
    };
    let mut cells = Cells::new(10);
    cells.push(0, 0, Cell::Number(1.0));
    let s = Sheet::new("s".into(), cells, vec![merge]);
    assert_eq!((s.rows, s.cols), (1, 8));
  }

  #[test]
  fn an_encrypted_xlsx_says_so() {
    // A compound file, so it sniffs as xls. The xls reader rejects it for lacking a
    // workbook stream; the xlsx reader is the one that recognises the encryption.
    let bytes = sample("encrypted.xlsx");
    assert_eq!(Format::sniff(&bytes), Format::Xls);
    assert!(matches!(
      Workbook::load(bytes, &LoadOptions::default()),
      Err(TableError::Encrypted)
    ));
  }

  #[test]
  fn garbage_is_an_error_not_a_panic() {
    let mut bytes = b"PK\x03\x04".to_vec();
    bytes.extend_from_slice(&[0u8; 64]);
    assert!(matches!(
      Workbook::load(bytes, &LoadOptions::default()),
      Err(TableError::UnknownFormat)
    ));
  }

  #[test]
  fn delimited_text_is_one_sheet() {
    let opts = LoadOptions {
      format: Some(Format::Tsv),
      ..Default::default()
    };
    let book = Workbook::load(b"a\tb\n1\t2\n".to_vec(), &opts).unwrap();
    assert_eq!(book.format(), Format::Tsv);
    assert_eq!(book.delimiter(), Some(b'\t'));
    assert_eq!(book.encoding(), Some("UTF-8"));
    assert_eq!(book.sheets().len(), 1);
    assert_eq!(
      book.sheet(0).unwrap().cell(1, 1),
      &Cell::ParsedNumber(2.0, "2".into())
    );
  }
}
