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

pub use cell::{Cell, CellKind, Window};
pub use delimited::DelimitedOptions;

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

/// One sheet's cells, fully read.
///
/// Coordinates are the sheet's own: row 0 is the row Excel calls 1, whatever row the
/// data starts on. A sheet whose only value is in F10 is ten rows by six columns with
/// one cell set, so a grid draws it where the author put it.
#[derive(Debug, Clone, PartialEq)]
pub struct Sheet {
  pub name: String,
  /// One past the last row holding a value or covered by a merge.
  pub rows: u32,
  /// One past the last column holding a value or covered by a merge.
  pub cols: u32,
  pub merges: Vec<Merge>,
  /// Where `cells` starts. Everything above and to the left of it is empty.
  origin: (u32, u32),
  /// Row-major over the used range, `width` cells to a row.
  cells: Vec<Cell>,
  width: u32,
}

impl Sheet {
  pub(crate) fn new(
    name: String,
    origin: (u32, u32),
    width: u32,
    cells: Vec<Cell>,
    merges: Vec<Merge>,
  ) -> Self {
    let height = (cells.len() as u32).checked_div(width).unwrap_or(0);
    let (mut rows, mut cols) = if cells.is_empty() {
      (0, 0)
    } else {
      (origin.0 + height, origin.1 + width)
    };
    // A merge can reach past the last value — a title spanning empty columns — and
    // the grid has to be wide enough to draw it.
    for m in &merges {
      rows = rows.max(m.row_end + 1);
      cols = cols.max(m.col_end + 1);
    }
    Self {
      name,
      rows,
      cols,
      merges,
      origin,
      cells,
      width,
    }
  }

  /// The cell at `(row, col)`. Anything outside the used range is empty.
  pub fn cell(&self, row: u32, col: u32) -> &Cell {
    static EMPTY: Cell = Cell::Empty;
    let (r0, c0) = self.origin;
    if row < r0 || col < c0 || col - c0 >= self.width {
      return &EMPTY;
    }
    let index = (row - r0) as usize * self.width as usize + (col - c0) as usize;
    self.cells.get(index).unwrap_or(&EMPTY)
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
      |r, c| self.cell(r, c),
    )
  }
}

/// Options for [`Workbook::load`].
#[derive(Debug, Clone, Default)]
pub struct LoadOptions {
  /// Skip sniffing. Needed to tell a TSV from a CSV, which share every byte but one.
  pub format: Option<Format>,
  /// Applies to CSV and TSV only.
  pub delimited: DelimitedOptions,
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
      let text = delimited::read(&bytes, &opts)?;
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

    let (reader, format) = book::Reader::open(bytes, format)?;
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
    let s = Sheet::new("s".into(), (0, 0), 1, vec![Cell::Number(1.0)], vec![merge]);
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
