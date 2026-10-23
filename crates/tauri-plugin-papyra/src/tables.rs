//! Spreadsheets and delimited text, with the `tables` feature.
//!
//! Field for field the napi bindings' shapes, so papyra's `Workbook` and `Sheet`
//! read these unchanged. A window of cells travels as one binary response rather
//! than JSON: see [`pack`].

use std::sync::Arc;

use papyra_tables::{LoadOptions, Window};
use serde::{Deserialize, Serialize};
use tauri::ipc::Response as Bytes;
use tauri::{Runtime, State, Webview};

use crate::commands::{blocking, body, header};
use crate::error::{Error, Result};
use crate::{Doc, Documents};

/// Header `WorkbookOptions` travel in, as percent-encoded JSON: the body is the file.
const OPTIONS_HEADER: &str = "x-papyra-options";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Options {
  format: Option<String>,
  delimiter: Option<String>,
  encoding: Option<String>,
  max_cells: Option<usize>,
}

#[derive(Serialize)]
pub struct SheetInfo {
  pub name: String,
  pub kind: &'static str,
  pub visibility: &'static str,
}

#[derive(Serialize)]
pub struct WorkbookOpened {
  pub id: u32,
  pub format: &'static str,
  pub sheets: Vec<SheetInfo>,
  pub encoding: Option<&'static str>,
  pub delimiter: Option<String>,
}

/// The most cells one window may hold, about 19 MB in each of host and WebView. A
/// window is dense, so this is what the host allocates however high an app sets
/// `maxCells` for the sparse sheet — and what a phone keeps while a sheet is shown.
const DENSE_CELLS: usize = 1 << 20;

/// Every sheet may be fetched this densely, whatever it stores: a few screenfuls.
const DENSE_FLOOR: usize = 1 << 16;

/// How much denser than its stored cells a sheet may be fetched. A sheet's extent is
/// its bounding box, which the file's author sets: ten kilobytes with values in A1 and
/// XFD1048576 is seventeen billion cells dense.
const DENSE_RATIO: usize = 16;

/// The most text one window may carry. Many cells naming one huge shared string
/// otherwise grow it without bound.
const MAX_TEXT: usize = 64 << 20;

/// The dense cells one sheet of this workbook may be fetched as.
fn dense_cap(s: &papyra_tables::Sheet, max_cells: usize) -> usize {
  max_cells.min((s.stored_cells() * DENSE_RATIO).max(DENSE_FLOOR))
}

fn workbook(docs: &Documents, id: u32) -> Result<(Arc<papyra_tables::Workbook>, usize)> {
  match docs.get(id)? {
    Doc::Workbook(book, max_cells) => Ok((book, max_cells)),
    _ => Err(Error::WrongKind(id, "workbook")),
  }
}

/// Open a spreadsheet or delimited text sent as the request body, its options in
/// the `x-papyra-options` header. Lists the sheets; none is read yet.
#[tauri::command]
pub(crate) async fn open_workbook<R: Runtime>(
  webview: Webview<R>,
  request: tauri::ipc::Request<'_>,
  docs: State<'_, Documents>,
) -> Result<WorkbookOpened> {
  let bytes = body(&request)?;
  let o: Options = match header(&request, OPTIONS_HEADER)? {
    Some(json) => serde_json::from_str(&json).map_err(|e| Error::Options(e.to_string()))?,
    None => Options::default(),
  };
  let options = LoadOptions::parse(
    o.format.as_deref(),
    o.delimiter.as_deref(),
    o.encoding,
    o.max_cells,
  )
  .map_err(Error::Options)?;
  let max_cells = options.max_cells.min(DENSE_CELLS);
  let book = blocking(move || Ok(papyra_tables::Workbook::load(bytes, &options)?)).await?;
  let book = Arc::new(book);
  Ok(WorkbookOpened {
    format: book.format().as_str(),
    sheets: book
      .sheets()
      .iter()
      .map(|s| SheetInfo {
        name: s.name.clone(),
        kind: s.kind.as_str(),
        visibility: s.visibility.as_str(),
      })
      .collect(),
    encoding: book.encoding(),
    delimiter: book.delimiter().map(|d| char::from(d).to_string()),
    id: docs.insert(webview.label(), Doc::Workbook(book.clone(), max_cells))?,
  })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BorderEdge {
  pub style: &'static str,
  pub color: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellStyle {
  pub bold: bool,
  pub italic: bool,
  pub underline: bool,
  pub strike: bool,
  pub font_scale: f32,
  pub color: Option<u32>,
  pub fill: Option<u32>,
  pub border_top: Option<BorderEdge>,
  pub border_right: Option<BorderEdge>,
  pub border_bottom: Option<BorderEdge>,
  pub border_left: Option<BorderEdge>,
  pub horizontal: Option<&'static str>,
  pub vertical: Option<&'static str>,
  pub wrap: bool,
  pub indent: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetLayout {
  pub default_col_width: f32,
  pub default_row_height: f32,
  /// Flat triples: `first, last, width`.
  pub cols: Vec<f32>,
  /// Flat pairs: `row, height`.
  pub rows: Vec<f32>,
  pub show_grid_lines: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sheet {
  pub name: String,
  pub rows: u32,
  pub cols: u32,
  pub truncated: bool,
  /// Flat quads: `rowStart, colStart, rowEnd, colEnd`, inclusive.
  pub merges: Vec<u32>,
  pub styles: Vec<CellStyle>,
  pub layout: Option<SheetLayout>,
}

fn edge(e: Option<papyra_tables::Edge>) -> Option<BorderEdge> {
  e.map(|e| BorderEdge {
    style: e.style.as_str(),
    color: e.color,
  })
}

/// Read one sheet, and describe it: everything but its cells, which [`window`]
/// reads. Parsed once; later calls for the same sheet are free.
///
/// `rows` stops where the sheet's first rows fill [`dense_cap`], and says `truncated`
/// when that cut it: the cells are held sparse, but the WebView fetches the sheet
/// whole as one dense window.
#[tauri::command]
pub(crate) async fn sheet(id: u32, index: usize, docs: State<'_, Documents>) -> Result<Sheet> {
  let (book, max_cells) = workbook(&docs, id)?;
  blocking(move || {
    let s = book.sheet(index)?;
    let rows = match s.cols {
      0 => s.rows,
      cols => s
        .rows
        .min(u32::try_from(dense_cap(&s, max_cells) / cols as usize).unwrap_or(u32::MAX)),
    };
    Ok(Sheet {
      name: s.name.clone(),
      rows,
      cols: s.cols,
      truncated: s.truncated || rows < s.rows,
      merges: s
        .merges
        .iter()
        .flat_map(|m| [m.row_start, m.col_start, m.row_end, m.col_end])
        .collect(),
      styles: s
        .styles()
        .iter()
        .map(|st| {
          let [top, right, bottom, left] = st.border;
          CellStyle {
            bold: st.bold,
            italic: st.italic,
            underline: st.underline,
            strike: st.strike,
            font_scale: st.font_scale,
            color: st.color,
            fill: st.fill,
            border_top: edge(top),
            border_right: edge(right),
            border_bottom: edge(bottom),
            border_left: edge(left),
            horizontal: st.h_align.map(|h| h.as_str()),
            vertical: st.v_align.map(|v| v.as_str()),
            wrap: st.wrap,
            indent: st.indent,
          }
        })
        .collect(),
      layout: s.layout.as_ref().map(|l| SheetLayout {
        default_col_width: l.default_col_width,
        default_row_height: l.default_row_height,
        cols: l
          .cols
          .iter()
          .flat_map(|c| [c.first as f32, c.last as f32, c.width])
          .collect(),
        rows: l
          .rows
          .iter()
          .flat_map(|r| [r.row as f32, r.height])
          .collect(),
        show_grid_lines: l.show_grid_lines,
      }),
    })
  })
  .await
}

/// `[rowStart, rowEnd) x [colStart, colEnd)` of one sheet, clamped to it, packed by
/// [`pack`]. Refused past [`dense_cap`] cells or [`MAX_TEXT`] bytes of text: a
/// window is dense, and the file's author sets its extent.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn window(
  id: u32,
  sheet: usize,
  row_start: u32,
  row_end: u32,
  col_start: u32,
  col_end: u32,
  docs: State<'_, Documents>,
) -> Result<Bytes> {
  let (book, max_cells) = workbook(&docs, id)?;
  blocking(move || {
    let s = book.sheet(sheet)?;
    let span = |start: u32, end: u32, len: u32| u64::from(end.min(len).saturating_sub(start));
    let area = span(row_start, row_end, s.rows) * span(col_start, col_end, s.cols);
    let cap = dense_cap(&s, max_cells);
    if area > cap as u64 {
      return Err(Error::WindowTooLarge(area, cap));
    }
    Ok(Bytes::new(pack(
      &s.window(row_start, row_end, col_start, col_end, MAX_TEXT)?,
    )))
  })
  .await
}

/// A window as one buffer, each array aligned for a typed-array view over it:
///
/// `rowStart colStart rows cols` (u32 each), `kinds` (u8 × n), padding to 8,
/// `numbers` (f64 × n), `colors` (u32 × n), `offsets` (u32 × n + 1), `styles`
/// (u16 × n), then `text` as UTF-8 to the end. Little-endian, which is every
/// platform Tauri runs on. `offsets` are UTF-16 offsets into the decoded text, as
/// the bindings' are.
pub(crate) fn pack(w: &Window) -> Vec<u8> {
  let n = w.kinds.len();
  let mut out = Vec::with_capacity(16 + n * 19 + 12 + w.text.len());
  for v in [w.row_start, w.col_start, w.rows, w.cols] {
    out.extend(v.to_le_bytes());
  }
  out.extend(&w.kinds);
  out.resize(out.len().next_multiple_of(8), 0);
  out.extend(w.numbers.iter().flat_map(|v| v.to_le_bytes()));
  out.extend(w.colors.iter().flat_map(|v| v.to_le_bytes()));
  out.extend(w.offsets.iter().flat_map(|v| v.to_le_bytes()));
  out.extend(w.styles.iter().flat_map(|v| v.to_le_bytes()));
  out.extend(w.text.as_bytes());
  out
}
