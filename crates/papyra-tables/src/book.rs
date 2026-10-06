//! Excel and OpenDocument, through calamine.

use crate::styles::{Package, StyleSheet};
use crate::{Format, Merge, Result, Sheet, SheetInfo, SheetKind, TableError, Visibility};
use calamine::{Dimensions, Ods, Reader as _, Sheets, Xls, Xlsb, Xlsx};
use std::io::Cursor;
use std::sync::Arc;

/// Shared rather than owned, so trying a second format does not copy the file.
type Bytes = Cursor<Arc<[u8]>>;

pub(crate) struct Reader {
  sheets: Sheets<Bytes>,
  /// What calamine does not read, for xlsx only.
  xlsx: Option<XlsxFormatting>,
}

struct XlsxFormatting {
  package: Package,
  /// Worksheet part per sheet, in calamine's order.
  paths: Vec<Option<String>>,
  styles: Arc<StyleSheet>,
  date1904: bool,
}

impl Reader {
  /// Open `bytes` as `hint`, falling back through the other formats.
  ///
  /// Not `calamine::open_workbook_auto_from_rs`: it tries each reader in turn and
  /// reports any failure as "cannot detect file format", which throws away the one
  /// failure worth reporting — that the file is encrypted. An encrypted xlsx is not a
  /// zip at all but a compound file, the same container as an `.xls`, so it is the xls
  /// attempt that sees it and the xlsx reader that recognises it.
  pub(crate) fn open(bytes: Vec<u8>, hint: Format) -> Result<(Self, Format)> {
    let order: &[Format] = match hint {
      Format::Xls => &[Format::Xls, Format::Xlsx, Format::Xlsb],
      Format::Xlsb => &[Format::Xlsb, Format::Xlsx, Format::Ods],
      Format::Ods => &[Format::Ods, Format::Xlsx, Format::Xlsb],
      _ => &[Format::Xlsx, Format::Xlsb, Format::Ods],
    };
    let bytes: Arc<[u8]> = bytes.into();
    let mut encrypted = false;
    for &format in order {
      let data = Cursor::new(bytes.clone());
      let opened = match format {
        Format::Xls => Xls::new(data)
          .map(Sheets::Xls)
          .map_err(|e| matches!(e, calamine::XlsError::Password)),
        Format::Xlsx => Xlsx::new(data)
          .map(Sheets::Xlsx)
          .map_err(|e| matches!(e, calamine::XlsxError::Password)),
        Format::Xlsb => Xlsb::new(data)
          .map(Sheets::Xlsb)
          .map_err(|e| matches!(e, calamine::XlsbError::Password)),
        Format::Ods => Ods::new(data)
          .map(Sheets::Ods)
          .map_err(|e| matches!(e, calamine::OdsError::Password)),
        Format::Csv | Format::Tsv => unreachable!("delimited text never reaches calamine"),
      };
      match opened {
        Ok(sheets) => {
          let xlsx = match &sheets {
            Sheets::Xlsx(x) => Package::open(bytes.clone()).map(|mut package| XlsxFormatting {
              paths: package.sheet_paths(),
              styles: Arc::new(package.style_sheet()),
              date1904: x.has_1904_epoch(),
              package,
            }),
            _ => None,
          };
          return Ok((Self { sheets, xlsx }, format));
        }
        Err(is_password) => encrypted |= is_password,
      }
    }
    Err(if encrypted {
      TableError::Encrypted
    } else {
      TableError::UnknownFormat
    })
  }

  pub(crate) fn sheets(&self) -> Vec<SheetInfo> {
    self
      .sheets
      .sheets_metadata()
      .iter()
      .map(|s| SheetInfo {
        name: s.name.clone(),
        kind: match s.typ {
          calamine::SheetType::WorkSheet => SheetKind::Worksheet,
          calamine::SheetType::ChartSheet => SheetKind::Chartsheet,
          calamine::SheetType::DialogSheet => SheetKind::Dialog,
          calamine::SheetType::MacroSheet => SheetKind::Macro,
          calamine::SheetType::Vba => SheetKind::Vba,
        },
        visibility: match s.visible {
          calamine::SheetVisible::Visible => Visibility::Visible,
          calamine::SheetVisible::Hidden => Visibility::Hidden,
          calamine::SheetVisible::VeryHidden => Visibility::VeryHidden,
        },
      })
      .collect()
  }

  pub(crate) fn read_sheet(&mut self, index: usize, name: &str) -> Result<Sheet> {
    let range = match self.sheets.worksheet_range_at(index) {
      Some(range) => range.map_err(parse)?,
      // A chartsheet has a slot in the list and no cells; an empty sheet is the
      // honest answer for it.
      None => Default::default(),
    };
    let merges = self.merges(index)?;
    let origin = range.start().unwrap_or((0, 0));
    let width = range.width() as u32;
    let cells = range.cells().map(|(_, _, d)| d.clone().into()).collect();
    let sheet = Sheet::new(name.to_string(), origin, width, cells, merges);
    Ok(match &mut self.xlsx {
      Some(x) => {
        let meta = match x.paths.get(index).cloned().flatten() {
          Some(path) => x.package.sheet_meta(&path, &x.styles),
          None => Default::default(),
        };
        sheet.with_formatting(x.styles.clone(), meta, x.date1904)
      }
      None => sheet,
    })
  }

  /// Merged regions. calamine reads them for xlsx and xls; xlsb and ods have none to
  /// offer, which leaves a merged title as a value in its top-left cell — still right,
  /// just not centred across the span.
  fn merges(&mut self, index: usize) -> Result<Vec<Merge>> {
    let dims = match &mut self.sheets {
      Sheets::Xlsx(x) => x.merge_cells_by_sheet_id(index).map_err(parse)?,
      Sheets::Xls(x) => x.merge_cells_by_sheet_id(index).map_err(parse)?,
      Sheets::Xlsb(_) | Sheets::Ods(_) => Vec::new(),
    };
    Ok(dims.into_iter().map(to_merge).collect())
  }
}

fn to_merge(d: Dimensions) -> Merge {
  Merge {
    row_start: d.start.0,
    col_start: d.start.1,
    row_end: d.end.0,
    col_end: d.end.1,
  }
}

fn parse(e: impl std::fmt::Display) -> TableError {
  TableError::Parse(e.to_string())
}
