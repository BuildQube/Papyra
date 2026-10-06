//! Spreadsheets and delimited text, over `papyra-tables`.
//!
//! The same split as the PDF side: loading and reading a sheet are tasks, because a
//! sheet is parsed whole and a large one takes real time, while a window over a sheet
//! already read is a synchronous copy whose size the caller chose.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use papyra_tables::{Format, LoadOptions, TableError};
use std::sync::Arc;

/// See `TAG_PASSWORD_REQUIRED` in `lib.rs`. Keep in step with `TAGS` in `errors.ts`.
const TAG_ENCRYPTED: &str = "papyra/encrypted-workbook";

fn map_err(e: TableError) -> Error {
  let message = match &e {
    TableError::Encrypted => format!("{TAG_ENCRYPTED} {e}"),
    _ => e.to_string(),
  };
  Error::new(Status::GenericFailure, message)
}

/// How to read the bytes. Every field is optional and sniffed when absent.
#[napi(object)]
pub struct WorkbookOptions {
  /// `"xlsx"`, `"xlsm"`, `"xlsb"`, `"xls"`, `"ods"`, `"csv"` or `"tsv"`. Only needed
  /// to call a file TSV, or to skip sniffing.
  pub format: Option<String>,
  /// CSV and TSV only: a single ASCII character.
  pub delimiter: Option<String>,
  /// CSV and TSV only: a WHATWG encoding label such as `"windows-1252"`.
  pub encoding: Option<String>,
}

fn load_options(options: Option<WorkbookOptions>) -> Result<LoadOptions> {
  let Some(o) = options else {
    return Ok(LoadOptions::default());
  };
  let format = match o.format {
    Some(name) => Some(
      Format::parse(&name)
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("unknown format {name:?}")))?,
    ),
    None => None,
  };
  let delimiter = match o.delimiter.as_deref().map(str::as_bytes) {
    None => None,
    Some([b]) if b.is_ascii() => Some(*b),
    Some(_) => {
      return Err(Error::new(
        Status::InvalidArg,
        "delimiter must be a single ASCII character",
      ));
    }
  };
  Ok(LoadOptions {
    format,
    delimited: papyra_tables::DelimitedOptions {
      delimiter,
      encoding: o.encoding,
    },
  })
}

/// A sheet's entry in the workbook.
#[napi(object)]
pub struct SheetInfo {
  pub name: String,
  /// `"worksheet"`, `"chartsheet"`, `"dialog"`, `"macro"` or `"vba"`.
  pub kind: String,
  /// `"visible"`, `"hidden"` or `"veryHidden"`.
  pub visibility: String,
}

fn to_sheet_info(s: &papyra_tables::SheetInfo) -> SheetInfo {
  use papyra_tables::{SheetKind as K, Visibility as V};
  SheetInfo {
    name: s.name.clone(),
    kind: match s.kind {
      K::Worksheet => "worksheet",
      K::Chartsheet => "chartsheet",
      K::Dialog => "dialog",
      K::Macro => "macro",
      K::Vba => "vba",
    }
    .to_string(),
    visibility: match s.visibility {
      V::Visible => "visible",
      V::Hidden => "hidden",
      V::VeryHidden => "veryHidden",
    }
    .to_string(),
  }
}

/// Parse the container and list its sheets, off the JS thread.
///
/// For CSV and TSV this is the whole parse; for a workbook it reads the directory and,
/// for xlsx, the shared-string table — which on a large export is most of the file.
pub struct LoadWorkbookTask {
  bytes: Option<Vec<u8>>,
  options: LoadOptions,
}

impl Task for LoadWorkbookTask {
  type Output = papyra_tables::Workbook;
  type JsValue = Workbook;

  fn compute(&mut self) -> Result<Self::Output> {
    let bytes = self.bytes.take().unwrap_or_default();
    papyra_tables::Workbook::load(bytes, &self.options).map_err(map_err)
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(Workbook {
      inner: Arc::new(out),
    })
  }
}

/// Open a spreadsheet or delimited text file.
#[napi(ts_return_type = "Promise<Workbook>")]
pub fn load_workbook(
  data: Uint8Array,
  options: Option<WorkbookOptions>,
) -> Result<AsyncTask<LoadWorkbookTask>> {
  crate::ensure_heap_reserved();
  Ok(AsyncTask::new(LoadWorkbookTask {
    bytes: Some(data.to_vec()),
    options: load_options(options)?,
  }))
}

#[napi]
pub struct Workbook {
  inner: Arc<papyra_tables::Workbook>,
}

#[napi]
impl Workbook {
  /// The container actually read: `"xlsx"`, `"xlsb"`, `"xls"`, `"ods"`, `"csv"` or
  /// `"tsv"`. A macro-enabled workbook reads as `"xlsx"`.
  #[napi(getter)]
  pub fn format(&self) -> &'static str {
    self.inner.format().as_str()
  }

  #[napi(getter)]
  pub fn sheets(&self) -> Vec<SheetInfo> {
    self.inner.sheets().iter().map(to_sheet_info).collect()
  }

  /// CSV and TSV only: the encoding the text was decoded from, e.g. `"windows-1252"`.
  #[napi(getter)]
  pub fn encoding(&self) -> Option<&'static str> {
    self.inner.encoding()
  }

  /// CSV and TSV only: the delimiter, given or sniffed.
  #[napi(getter)]
  pub fn delimiter(&self) -> Option<String> {
    self.inner.delimiter().map(|d| char::from(d).to_string())
  }

  /// Read one sheet's cells, off the JS thread. A sheet is read once and kept.
  #[napi(ts_return_type = "Promise<Sheet>")]
  pub fn sheet(&self, index: u32) -> AsyncTask<SheetTask> {
    AsyncTask::new(SheetTask {
      book: self.inner.clone(),
      index: index as usize,
    })
  }
}

pub struct SheetTask {
  book: Arc<papyra_tables::Workbook>,
  index: usize,
}

impl Task for SheetTask {
  type Output = Arc<papyra_tables::Sheet>;
  type JsValue = Sheet;

  fn compute(&mut self) -> Result<Self::Output> {
    self.book.sheet(self.index).map_err(map_err)
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(Sheet { inner: out })
  }
}

/// A rectangle of cells, packed. See `Window` in `papyra-tables`.
#[napi(object)]
pub struct CellWindow {
  pub row_start: u32,
  pub col_start: u32,
  pub rows: u32,
  pub cols: u32,
  /// One kind tag per cell, row-major: 0 empty, 1 number, 2 text, 3 bool, 4 date,
  /// 5 duration, 6 error.
  pub kinds: Uint8Array,
  /// One number per cell: the value, a bool as 0/1, a date's serial, a duration in
  /// days. NaN when there is none.
  pub numbers: Float64Array,
  /// Every cell's display text, concatenated.
  pub text: String,
  /// UTF-16 offsets into `text`, one more than there are cells.
  pub offsets: Uint32Array,
}

#[napi]
pub struct Sheet {
  inner: Arc<papyra_tables::Sheet>,
}

#[napi]
impl Sheet {
  #[napi(getter)]
  pub fn name(&self) -> String {
    self.inner.name.clone()
  }

  /// One past the last used row, counting from the sheet's first row.
  #[napi(getter)]
  pub fn rows(&self) -> u32 {
    self.inner.rows
  }

  /// One past the last used column, counting from column A.
  #[napi(getter)]
  pub fn cols(&self) -> u32 {
    self.inner.cols
  }

  /// Merged regions as flat quads — `rowStart, colStart, rowEnd, colEnd`, inclusive —
  /// so a sheet with thousands of them is one allocation, not thousands of objects.
  #[napi(getter)]
  pub fn merges(&self) -> Uint32Array {
    let mut out = Vec::with_capacity(self.inner.merges.len() * 4);
    for m in &self.inner.merges {
      out.extend([m.row_start, m.col_start, m.row_end, m.col_end]);
    }
    Uint32Array::new(out)
  }

  /// `[rowStart, rowEnd) x [colStart, colEnd)`, clamped to the sheet.
  ///
  /// Synchronous: the sheet is already parsed, and a window is as large as the
  /// caller asks for — a screenful is a few thousand cells and well under a
  /// millisecond. Ask for a screenful.
  #[napi]
  pub fn window(&self, row_start: u32, row_end: u32, col_start: u32, col_end: u32) -> CellWindow {
    let w = self.inner.window(row_start, row_end, col_start, col_end);
    CellWindow {
      row_start: w.row_start,
      col_start: w.col_start,
      rows: w.rows,
      cols: w.cols,
      kinds: Uint8Array::new(w.kinds),
      numbers: Float64Array::new(w.numbers),
      text: w.text,
      offsets: Uint32Array::new(w.offsets),
    }
  }
}
