//! xlsx formatting: the style sheet, theme colours, and each sheet's layout.
//!
//! calamine reads values and nothing about how they look — no number formats, fonts,
//! fills, borders, column widths or row heights. So this module opens the same zip
//! and reads them itself, with the quick-xml and zip that calamine already brings.
//! The cost is a second pass over each worksheet's XML, which only looks at the
//! attributes of `<c>`, `<row>` and `<col>`: values are calamine's job and are skipped.
//!
//! xlsx only. `.xls`, `.xlsb` and `.ods` keep their formatting in other structures
//! entirely, and show unformatted.

use crate::numfmt::{NumberFormat, builtin};
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::sync::Arc;

/// How one edge of a cell's border is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BorderStyle {
  Thin,
  Medium,
  Thick,
  Dashed,
  Dotted,
  Double,
  Hair,
}

/// One edge of a border.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Edge {
  pub style: BorderStyle,
  /// `0xRRGGBB`, or `None` for automatic — black, in Excel.
  pub color: Option<u32>,
}

/// Horizontal alignment. Absent means Excel's default: text left, numbers right.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HAlign {
  Left,
  Center,
  Right,
  Justify,
  /// Centred across the selection, which renders as centred in its own cell here.
  CenterContinuous,
  Fill,
  Distributed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VAlign {
  Top,
  Center,
  Bottom,
  Justify,
  Distributed,
}

/// Everything about how a cell looks except its number format.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CellStyle {
  pub bold: bool,
  pub italic: bool,
  pub underline: bool,
  pub strike: bool,
  /// Font size relative to the workbook's default font: 1.0 is the default size.
  pub font_scale: f32,
  /// `0xRRGGBB`, or `None` for automatic.
  pub color: Option<u32>,
  /// `0xRRGGBB` background, or `None` for none.
  pub fill: Option<u32>,
  /// Top, right, bottom, left.
  pub border: [Option<Edge>; 4],
  pub h_align: Option<HAlign>,
  pub v_align: Option<VAlign>,
  pub wrap: bool,
  /// Indent level; Excel draws each as about three characters.
  pub indent: u32,
  /// Index into [`StyleSheet::formats`].
  pub(crate) format: usize,
}

impl CellStyle {
  /// Draws something on an empty cell: a fill, or a border.
  pub fn is_visible_when_empty(&self) -> bool {
    self.fill.is_some() || self.border.iter().any(Option::is_some)
  }
}

/// A workbook's styles, indexed by a cell's `s` attribute.
#[derive(Debug, Default)]
pub struct StyleSheet {
  pub styles: Vec<CellStyle>,
  pub(crate) formats: Vec<NumberFormat>,
}

impl StyleSheet {
  pub(crate) fn format(&self, style: u16) -> Option<&NumberFormat> {
    let s = self.styles.get(style as usize)?;
    self.formats.get(s.format)
  }
}

/// Column widths and row heights in pixels, as Excel lays the sheet out.
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
  pub default_col_width: f32,
  pub default_row_height: f32,
  /// Inclusive, 0-based column spans with their own width.
  pub cols: Vec<ColSpan>,
  /// Rows with their own height, in row order.
  pub rows: Vec<RowSize>,
  /// `false` when the author turned the gridlines off, which a printed report or a
  /// dashboard usually does.
  pub show_grid_lines: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColSpan {
  pub first: u32,
  pub last: u32,
  /// Pixels; 0 when hidden.
  pub width: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RowSize {
  pub row: u32,
  /// Pixels; 0 when hidden.
  pub height: f32,
}

/// What the worksheet pass found: a style per cell, and the layout.
#[derive(Debug, Default)]
pub(crate) struct SheetMeta {
  /// `(row, col, style)` for every cell with a non-default style, row-major.
  pub cells: Vec<(u32, u32, u16)>,
  pub layout: Option<Layout>,
}

/// Excel's legacy indexed palette — still how `<color indexed="10"/>` is resolved.
const PALETTE: [u32; 64] = [
  0x000000, 0xFFFFFF, 0xFF0000, 0x00FF00, 0x0000FF, 0xFFFF00, 0xFF00FF, 0x00FFFF, 0x000000,
  0xFFFFFF, 0xFF0000, 0x00FF00, 0x0000FF, 0xFFFF00, 0xFF00FF, 0x00FFFF, 0x800000, 0x008000,
  0x000080, 0x808000, 0x800080, 0x008080, 0xC0C0C0, 0x808080, 0x9999FF, 0x993366, 0xFFFFCC,
  0xCCFFFF, 0x660066, 0xFF8080, 0x0066CC, 0xCCCCFF, 0x000080, 0xFF00FF, 0xFFFF00, 0x00FFFF,
  0x800080, 0x800000, 0x008080, 0x0000FF, 0x00CCFF, 0xCCFFFF, 0xCCFFCC, 0xFFFF99, 0x99CCFF,
  0xFF99CC, 0xCC99FF, 0xFFCC99, 0x3366FF, 0x33CCCC, 0x99CC00, 0xFFCC00, 0xFF9900, 0xFF6600,
  0x666699, 0x969696, 0x003366, 0x339966, 0x003300, 0x333300, 0x993300, 0x993366, 0x333399,
  0x333333,
];

/// A colour from the indexed palette. 64 and 65 are "system foreground/background",
/// which is to say automatic.
pub(crate) fn indexed_color(i: usize) -> Option<u32> {
  PALETTE.get(i).copied()
}

/// Office's default theme, for a workbook that ships without one.
const DEFAULT_THEME: [u32; 12] = [
  0x000000, 0xFFFFFF, 0x44546A, 0xE7E6E6, 0x4472C4, 0xED7D31, 0xA5A5A5, 0xFFC000, 0x5B9BD5,
  0x70AD47, 0x0563C1, 0x954F72,
];

// ------------------------------------------------------------------ the zip

/// The xlsx package, opened a second time beside calamine's reader.
pub(crate) struct Package {
  zip: zip::ZipArchive<Cursor<Arc<[u8]>>>,
}

impl Package {
  pub(crate) fn open(bytes: Arc<[u8]>) -> Option<Self> {
    zip::ZipArchive::new(Cursor::new(bytes))
      .ok()
      .map(|zip| Self { zip })
  }

  fn read(&mut self, path: &str) -> Option<Vec<u8>> {
    let mut file = self.zip.by_name(path).ok()?;
    let mut out = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut out).ok()?;
    Some(out)
  }

  /// Worksheet part paths, in workbook order — the order calamine's sheet list uses.
  pub(crate) fn sheet_paths(&mut self) -> Vec<Option<String>> {
    let rels = self
      .read("xl/_rels/workbook.xml.rels")
      .map(|x| relationships(&x))
      .unwrap_or_default();
    let Some(workbook) = self.read("xl/workbook.xml") else {
      return Vec::new();
    };
    let mut out = Vec::new();
    each_element(&workbook, |e| {
      if e.local_name().as_ref() == b"sheet" {
        let path = attr(e, b"id")
          .and_then(|id| rels.get(&id))
          .map(|t| part_path(t));
        out.push(path);
      }
    });
    out
  }

  pub(crate) fn style_sheet(&mut self) -> StyleSheet {
    let theme = self
      .read("xl/theme/theme1.xml")
      .map(|x| theme_colors(&x))
      .unwrap_or(DEFAULT_THEME.to_vec());
    match self.read("xl/styles.xml") {
      Some(xml) => parse_styles(&xml, &theme),
      None => StyleSheet {
        styles: vec![CellStyle {
          font_scale: 1.0,
          ..Default::default()
        }],
        formats: vec![NumberFormat::parse("General")],
      },
    }
  }

  pub(crate) fn sheet_meta(&mut self, path: &str, styles: &StyleSheet) -> SheetMeta {
    self
      .read(path)
      .map(|x| parse_sheet(&x, styles))
      .unwrap_or_default()
  }
}

/// A relationship target as a zip path: relative to `xl/`, or absolute from the root.
fn part_path(target: &str) -> String {
  match target.strip_prefix('/') {
    Some(abs) => abs.to_string(),
    None => format!("xl/{}", target.trim_start_matches("./")),
  }
}

fn relationships(xml: &[u8]) -> HashMap<String, String> {
  let mut out = HashMap::new();
  each_element(xml, |e| {
    if e.local_name().as_ref() == b"Relationship"
      && let (Some(id), Some(target)) = (attr(e, b"Id"), attr(e, b"Target"))
    {
      out.insert(id, target);
    }
  });
  out
}

// -------------------------------------------------------------------- XML

/// Call `f` on every start and empty element, in document order.
fn each_element(xml: &[u8], mut f: impl FnMut(&BytesStart<'_>)) {
  let mut reader = Reader::from_reader(xml);
  let mut buf = Vec::new();
  loop {
    match reader.read_event_into(&mut buf) {
      Ok(Event::Start(e) | Event::Empty(e)) => f(&e),
      Ok(Event::Eof) | Err(_) => break,
      _ => {}
    }
    buf.clear();
  }
}

/// An attribute by local name, unescaped. OOXML parts are UTF-8 by specification,
/// so there is no declared encoding to decode from first.
fn attr(e: &BytesStart<'_>, name: &[u8]) -> Option<String> {
  e.attributes()
    .flatten()
    .find(|a| a.key.local_name().as_ref() == name)
    .and_then(|a| {
      a.normalized_value(XmlVersion::default())
        .ok()
        .map(|v| v.into_owned())
    })
}

fn attr_f32(e: &BytesStart<'_>, name: &[u8]) -> Option<f32> {
  attr(e, name)?.parse().ok()
}

fn attr_u32(e: &BytesStart<'_>, name: &[u8]) -> Option<u32> {
  attr(e, name)?.parse().ok()
}

/// `1`, `true` and `on` are all true in OOXML; an absent flag is false.
fn attr_bool(e: &BytesStart<'_>, name: &[u8]) -> bool {
  attr(e, name).is_some_and(|v| matches!(v.as_str(), "1" | "true" | "on"))
}

/// A boolean element such as `<b/>` or `<b val="0"/>`.
fn flag(e: &BytesStart<'_>) -> bool {
  attr(e, b"val").is_none_or(|v| !matches!(v.as_str(), "0" | "false" | "off"))
}

// ----------------------------------------------------------------- colours

/// The theme's twelve colours, in `clrScheme` order: dk1, lt1, dk2, lt2, accent1–6,
/// hlink, folHlink.
fn theme_colors(xml: &[u8]) -> Vec<u32> {
  let mut out = Vec::new();
  let mut in_scheme = false;
  let mut reader = Reader::from_reader(xml);
  let mut buf = Vec::new();
  loop {
    match reader.read_event_into(&mut buf) {
      Ok(Event::Start(e)) if e.local_name().as_ref() == b"clrScheme" => in_scheme = true,
      Ok(Event::End(e)) if e.local_name().as_ref() == b"clrScheme" => break,
      Ok(Event::Start(e) | Event::Empty(e)) if in_scheme => match e.local_name().as_ref() {
        b"srgbClr" => out.extend(attr(&e, b"val").and_then(|v| hex(&v))),
        // A system colour carries what it last resolved to, which is the best guess.
        b"sysClr" => out.extend(attr(&e, b"lastClr").and_then(|v| hex(&v))),
        _ => {}
      },
      Ok(Event::Eof) | Err(_) => break,
      _ => {}
    }
    buf.clear();
  }
  if out.len() < 12 {
    DEFAULT_THEME.to_vec()
  } else {
    out
  }
}

fn hex(s: &str) -> Option<u32> {
  // ARGB in styles, RGB in themes. The alpha byte is ignored: Excel does too.
  let rgb = if s.len() == 8 { &s[2..] } else { s };
  u32::from_str_radix(rgb, 16).ok()
}

/// A `<color>` element's colour, or `None` for automatic.
fn color(e: &BytesStart<'_>, theme: &[u32]) -> Option<u32> {
  if attr_bool(e, b"auto") {
    return None;
  }
  let base = if let Some(rgb) = attr(e, b"rgb") {
    hex(&rgb)?
  } else if let Some(t) = attr_u32(e, b"theme") {
    // Excel swaps the first two pairs: theme 0 is lt1 and 1 is dk1, so that the
    // default text colour (1) is dark on the default background (0).
    let t = match t {
      0 => 1,
      1 => 0,
      2 => 3,
      3 => 2,
      t => t,
    };
    *theme.get(t as usize)?
  } else {
    indexed_color(attr_u32(e, b"indexed")? as usize)?
  };
  Some(match attr(e, b"tint").and_then(|t| t.parse::<f64>().ok()) {
    Some(tint) if tint != 0.0 => apply_tint(base, tint),
    _ => base,
  })
}

/// Lighten (positive) or darken (negative) a colour by its HSL lightness, as Excel
/// derives the shades in a theme's colour picker.
fn apply_tint(rgb: u32, tint: f64) -> u32 {
  let [r, g, b] = [(rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF].map(|c| f64::from(c) / 255.0);
  let max = r.max(g).max(b);
  let min = r.min(g).min(b);
  let mut l = (max + min) / 2.0;
  let d = max - min;
  let (h, s) = if d == 0.0 {
    (0.0, 0.0)
  } else {
    let s = d / (1.0 - (2.0 * l - 1.0).abs());
    let h = if max == r {
      ((g - b) / d).rem_euclid(6.0)
    } else if max == g {
      (b - r) / d + 2.0
    } else {
      (r - g) / d + 4.0
    };
    (h * 60.0, s)
  };
  l = if tint < 0.0 {
    l * (1.0 + tint)
  } else {
    l * (1.0 - tint) + tint
  };
  let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
  let x = c * (1.0 - ((h / 60.0).rem_euclid(2.0) - 1.0).abs());
  let m = l - c / 2.0;
  let (r, g, b) = match (h / 60.0) as u32 {
    0 => (c, x, 0.0),
    1 => (x, c, 0.0),
    2 => (0.0, c, x),
    3 => (0.0, x, c),
    4 => (x, 0.0, c),
    _ => (c, 0.0, x),
  };
  let byte = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u32;
  (byte(r) << 16) | (byte(g) << 8) | byte(b)
}

// ------------------------------------------------------------------ styles

#[derive(Default, Clone)]
struct Font {
  bold: bool,
  italic: bool,
  underline: bool,
  strike: bool,
  size: Option<f32>,
  color: Option<u32>,
}

fn border_style(name: &str) -> Option<BorderStyle> {
  Some(match name {
    "thin" => BorderStyle::Thin,
    "medium" => BorderStyle::Medium,
    "thick" => BorderStyle::Thick,
    // CSS has no dash-dot; a dash is the nearest thing it can draw.
    "dashed" | "dashDot" | "dashDotDot" | "mediumDashed" | "mediumDashDot" | "mediumDashDotDot"
    | "slantDashDot" => BorderStyle::Dashed,
    "dotted" => BorderStyle::Dotted,
    "double" => BorderStyle::Double,
    "hair" => BorderStyle::Hair,
    _ => return None,
  })
}

fn parse_styles(xml: &[u8], theme: &[u32]) -> StyleSheet {
  let mut custom: HashMap<u32, String> = HashMap::new();
  let mut fonts: Vec<Font> = Vec::new();
  let mut fills: Vec<Option<u32>> = Vec::new();
  let mut borders: Vec<[Option<Edge>; 4]> = Vec::new();
  // Each style with its number format id and its font's size in points; the size
  // becomes relative once the default font, fonts[0], is known for certain.
  let mut xfs: Vec<(CellStyle, u32, Option<f32>)> = Vec::new();

  #[derive(PartialEq, Clone, Copy)]
  enum In {
    Nothing,
    Font,
    Fill,
    Border(usize),
    CellXf,
  }
  let mut section: &[u8] = b"";
  let mut at = In::Nothing;
  let mut pattern_solid = false;

  let mut reader = Reader::from_reader(xml);
  let mut buf = Vec::new();
  loop {
    let event = reader.read_event_into(&mut buf);
    let (e, empty) = match &event {
      Ok(Event::Start(e)) => (e.clone(), false),
      Ok(Event::Empty(e)) => (e.clone(), true),
      Ok(Event::End(e)) => {
        match e.local_name().as_ref() {
          b"font" | b"fill" | b"xf" => at = In::Nothing,
          b"left" | b"right" | b"top" | b"bottom" => at = In::Border(usize::MAX),
          b"border" => at = In::Nothing,
          b"fonts" | b"fills" | b"borders" | b"cellXfs" | b"numFmts" => section = b"",
          _ => {}
        }
        buf.clear();
        continue;
      }
      Ok(Event::Eof) | Err(_) => break,
      _ => {
        buf.clear();
        continue;
      }
    };
    let name = e.local_name();
    match name.as_ref() {
      b"numFmts" => section = b"numFmts",
      b"fonts" => section = b"fonts",
      b"fills" => section = b"fills",
      b"borders" => section = b"borders",
      b"cellXfs" => section = b"cellXfs",
      b"cellStyleXfs" | b"dxfs" | b"cellStyles" => section = b"other",
      b"numFmt" if section == b"numFmts" => {
        if let (Some(id), Some(code)) = (attr_u32(&e, b"numFmtId"), attr(&e, b"formatCode")) {
          custom.insert(id, code);
        }
      }
      b"font" if section == b"fonts" => {
        fonts.push(Font::default());
        at = if empty { In::Nothing } else { In::Font };
      }
      b"b" if at == In::Font => fonts.last_mut().expect("pushed").bold = flag(&e),
      b"i" if at == In::Font => fonts.last_mut().expect("pushed").italic = flag(&e),
      b"strike" if at == In::Font => fonts.last_mut().expect("pushed").strike = flag(&e),
      b"u" if at == In::Font => {
        fonts.last_mut().expect("pushed").underline = attr(&e, b"val").is_none_or(|v| v != "none")
      }
      b"sz" if at == In::Font => fonts.last_mut().expect("pushed").size = attr_f32(&e, b"val"),
      b"color" if at == In::Font => fonts.last_mut().expect("pushed").color = color(&e, theme),
      b"fill" if section == b"fills" => {
        fills.push(None);
        pattern_solid = false;
        at = if empty { In::Nothing } else { In::Fill };
      }
      b"patternFill" if at == In::Fill => {
        // `gray125` is the reserved second fill every file carries; `none` is none.
        pattern_solid = attr(&e, b"patternType").is_some_and(|p| p != "none" && p != "gray125");
      }
      b"fgColor" if at == In::Fill && pattern_solid => {
        *fills.last_mut().expect("pushed") = color(&e, theme);
      }
      // A gradient shows as its first stop: a flat approximation beats none.
      b"color" if at == In::Fill && fills.last().is_some_and(Option::is_none) => {
        *fills.last_mut().expect("pushed") = color(&e, theme);
      }
      b"border" if section == b"borders" => {
        borders.push([None; 4]);
        at = if empty {
          In::Nothing
        } else {
          In::Border(usize::MAX)
        };
      }
      side @ (b"top" | b"right" | b"bottom" | b"left") if matches!(at, In::Border(_)) => {
        let edge = match side {
          b"top" => 0,
          b"right" => 1,
          b"bottom" => 2,
          _ => 3,
        };
        if let Some(style) = attr(&e, b"style").and_then(|s| border_style(&s)) {
          borders.last_mut().expect("pushed")[edge] = Some(Edge { style, color: None });
          at = if empty {
            In::Border(usize::MAX)
          } else {
            In::Border(edge)
          };
        }
      }
      b"color" => {
        if let In::Border(edge) = at
          && edge < 4
          && let Some(Some(e2)) = borders.last_mut().map(|b| &mut b[edge])
        {
          e2.color = color(&e, theme);
        }
      }
      b"xf" if section == b"cellXfs" => {
        let font = attr_u32(&e, b"fontId")
          .and_then(|i| fonts.get(i as usize))
          .cloned()
          .unwrap_or_default();
        let style = CellStyle {
          bold: font.bold,
          italic: font.italic,
          underline: font.underline,
          strike: font.strike,
          font_scale: 1.0,
          color: font.color,
          fill: attr_u32(&e, b"fillId")
            .and_then(|i| fills.get(i as usize).copied())
            .flatten(),
          border: attr_u32(&e, b"borderId")
            .and_then(|i| borders.get(i as usize).copied())
            .unwrap_or_default(),
          ..Default::default()
        };
        xfs.push((style, attr_u32(&e, b"numFmtId").unwrap_or(0), font.size));
        at = if empty { In::Nothing } else { In::CellXf };
      }
      b"alignment" if at == In::CellXf => {
        let s = &mut xfs.last_mut().expect("pushed").0;
        s.h_align = attr(&e, b"horizontal").and_then(|h| {
          Some(match h.as_str() {
            "left" => HAlign::Left,
            "center" => HAlign::Center,
            "right" => HAlign::Right,
            "justify" => HAlign::Justify,
            "centerContinuous" => HAlign::CenterContinuous,
            "fill" => HAlign::Fill,
            "distributed" => HAlign::Distributed,
            _ => return None,
          })
        });
        s.v_align = attr(&e, b"vertical").and_then(|v| {
          Some(match v.as_str() {
            "top" => VAlign::Top,
            "center" => VAlign::Center,
            "bottom" => VAlign::Bottom,
            "justify" => VAlign::Justify,
            "distributed" => VAlign::Distributed,
            _ => return None,
          })
        });
        s.wrap = attr_bool(&e, b"wrapText");
        s.indent = attr_u32(&e, b"indent").unwrap_or(0);
      }
      _ => {}
    }
    buf.clear();
  }

  let default_size = fonts.first().and_then(|f| f.size).unwrap_or(11.0);
  let mut format_ids: Vec<u32> = Vec::new();
  let mut styles = Vec::with_capacity(xfs.len().max(1));
  for (mut style, id, size) in xfs {
    style.font_scale = size.map_or(1.0, |pt| pt / default_size);
    style.format = match format_ids.iter().position(|&f| f == id) {
      Some(k) => k,
      None => {
        format_ids.push(id);
        format_ids.len() - 1
      }
    };
    styles.push(style);
  }
  if styles.is_empty() {
    styles.push(CellStyle {
      font_scale: 1.0,
      ..Default::default()
    });
    format_ids.push(0);
  }
  let formats = format_ids
    .iter()
    .map(|id| {
      let code = custom
        .get(id)
        .map(String::as_str)
        .or_else(|| builtin(*id))
        .unwrap_or("General");
      NumberFormat::parse(code)
    })
    .collect();
  StyleSheet { styles, formats }
}

// ------------------------------------------------------------------- sheets

/// A cell reference's 0-based (row, col), e.g. `B3` → (2, 1).
fn cell_ref(r: &str) -> Option<(u32, u32)> {
  let split = r.find(|c: char| c.is_ascii_digit())?;
  let (letters, digits) = r.split_at(split);
  let mut col = 0u32;
  for b in letters.bytes() {
    col = col * 26 + u32::from(b.to_ascii_uppercase().checked_sub(b'A')?) + 1;
  }
  let row: u32 = digits.parse().ok()?;
  Some((row.checked_sub(1)?, col.checked_sub(1)?))
}

/// Excel's character-width units to pixels, for Calibri 11's 7px maximum digit width.
///
/// The spec's own formula: a stored width already includes the cell padding, so
/// 9.140625 — the default column — comes out at 64px.
fn width_px(chars: f32) -> f32 {
  const DIGIT: f32 = 7.0;
  (((256.0 * chars + (128.0 / DIGIT).trunc()) / 256.0) * DIGIT).trunc()
}

/// Points to pixels at 96 DPI.
fn points_px(pt: f32) -> f32 {
  pt * 96.0 / 72.0
}

fn parse_sheet(xml: &[u8], styles: &StyleSheet) -> SheetMeta {
  let mut meta = SheetMeta::default();
  let mut layout = Layout {
    default_col_width: 64.0,
    default_row_height: 20.0,
    cols: Vec::new(),
    rows: Vec::new(),
    show_grid_lines: true,
  };
  let mut row = 0u32;
  let mut col = 0u32;
  let mut reader = Reader::from_reader(xml);
  let mut buf = Vec::new();
  loop {
    match reader.read_event_into(&mut buf) {
      Ok(Event::Start(e) | Event::Empty(e)) => match e.local_name().as_ref() {
        b"sheetView" => {
          if attr(&e, b"showGridLines").is_some_and(|v| v == "0" || v == "false") {
            layout.show_grid_lines = false;
          }
        }
        b"sheetFormatPr" => {
          if let Some(w) = attr_f32(&e, b"defaultColWidth") {
            layout.default_col_width = width_px(w);
          } else if let Some(base) = attr_f32(&e, b"baseColWidth") {
            // Base width in characters, plus padding, rounded up to 8px as Excel does.
            layout.default_col_width = ((base * 7.0 + 5.0) / 8.0).ceil() * 8.0;
          }
          if let Some(h) = attr_f32(&e, b"defaultRowHeight") {
            layout.default_row_height = points_px(h);
          }
        }
        b"col" => {
          let first = attr_u32(&e, b"min").unwrap_or(1).max(1) - 1;
          // A span to the last column (16384) is common; it changes nothing past the
          // data, so it is kept as given and clamped by whoever reads it.
          let last = attr_u32(&e, b"max").unwrap_or(first + 1).max(1) - 1;
          let width = if attr_bool(&e, b"hidden") {
            0.0
          } else {
            attr_f32(&e, b"width").map_or(layout.default_col_width, width_px)
          };
          layout.cols.push(ColSpan { first, last, width });
        }
        b"row" => {
          row = attr_u32(&e, b"r").map_or(row + 1, |r| r.max(1)) - 1;
          col = 0;
          let hidden = attr_bool(&e, b"hidden");
          let height = attr_f32(&e, b"ht").filter(|_| attr_bool(&e, b"customHeight") || hidden);
          if hidden {
            layout.rows.push(RowSize { row, height: 0.0 });
          } else if let Some(h) = height {
            layout.rows.push(RowSize {
              row,
              height: points_px(h),
            });
          } else if let Some(h) = attr_f32(&e, b"ht") {
            // Not custom, but Excel measured it — usually for a larger font — and a
            // row drawn at the default would clip the text it was sized for.
            let h = points_px(h);
            if (h - layout.default_row_height).abs() > 0.5 {
              layout.rows.push(RowSize { row, height: h });
            }
          }
        }
        b"c" => {
          let (r, c) = attr(&e, b"r")
            .and_then(|r| cell_ref(&r))
            .unwrap_or((row, col));
          row = r;
          col = c + 1;
          if let Some(s) = attr_u32(&e, b"s")
            && s > 0
            && (s as usize) < styles.styles.len()
          {
            meta.cells.push((r, c, s as u16));
          }
        }
        _ => {}
      },
      // The values are calamine's, and the cell text is the bulk of the file; the
      // reader still has to tokenise it, but nothing here looks.
      Ok(Event::Eof) | Err(_) => break,
      _ => {}
    }
    buf.clear();
  }
  meta.cells.sort_unstable_by_key(|&(r, c, _)| (r, c));
  meta.layout = Some(layout);
  meta
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cell_refs() {
    assert_eq!(cell_ref("A1"), Some((0, 0)));
    assert_eq!(cell_ref("B3"), Some((2, 1)));
    assert_eq!(cell_ref("AA10"), Some((9, 26)));
    assert_eq!(cell_ref("XFD1048576"), Some((1_048_575, 16_383)));
    assert_eq!(cell_ref("1A"), None);
  }

  #[test]
  fn widths_match_excel() {
    assert_eq!(width_px(9.140625), 64.0);
    assert_eq!(width_px(0.0), 0.0);
    // Excel's own column-width dialog: "20.00 (145 pixels)".
    assert_eq!(width_px(20.710_938), 145.0);
    assert_eq!(points_px(15.0), 20.0);
  }

  #[test]
  fn tint_lightens_and_darkens() {
    assert_eq!(apply_tint(0x000000, 0.5), 0x808080);
    assert_eq!(apply_tint(0xFFFFFF, -0.5), 0x808080);
    // Office's "Blue, Accent 1, Lighter 80%".
    assert_eq!(apply_tint(0x4472C4, 0.7999816888943144), 0xDAE3F3);
  }

  #[test]
  fn theme_indices_swap_light_and_dark() {
    let xml = br#"<color theme="1"/>"#;
    let mut got = None;
    each_element(xml, |e| got = color(e, &DEFAULT_THEME));
    assert_eq!(got, Some(0x000000));
  }

  #[test]
  fn reads_a_style_sheet() {
    let xml = br#"<styleSheet>
      <numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
      <fonts count="2">
        <font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
        <font><b/><i val="0"/><sz val="22"/><color rgb="FFFF0000"/></font>
      </fonts>
      <fills count="3">
        <fill><patternFill patternType="none"/></fill>
        <fill><patternFill patternType="gray125"/></fill>
        <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
      </fills>
      <borders count="2">
        <border><left/><right/><top/><bottom/><diagonal/></border>
        <border><left style="thin"><color indexed="64"/></left><right/><top/><bottom style="double"><color rgb="FF0000FF"/></bottom></border>
      </borders>
      <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
      <cellXfs count="2">
        <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
        <xf numFmtId="164" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1">
          <alignment horizontal="center" vertical="top" wrapText="1" indent="2"/>
        </xf>
      </cellXfs>
    </styleSheet>"#;
    let sheet = parse_styles(xml, &DEFAULT_THEME);
    assert_eq!(sheet.styles.len(), 2);
    let plain = &sheet.styles[0];
    assert_eq!(plain.fill, None);
    assert_eq!(plain.color, Some(0x000000));
    assert_eq!(plain.font_scale, 1.0);
    let fancy = &sheet.styles[1];
    assert!(fancy.bold && !fancy.italic);
    assert_eq!(fancy.font_scale, 2.0);
    assert_eq!(fancy.color, Some(0xFF0000));
    assert_eq!(fancy.fill, Some(0xFFFF00));
    assert_eq!(
      fancy.border[3],
      Some(Edge {
        style: BorderStyle::Thin,
        color: None
      })
    );
    assert_eq!(
      fancy.border[2],
      Some(Edge {
        style: BorderStyle::Double,
        color: Some(0x0000FF)
      })
    );
    assert_eq!(fancy.h_align, Some(HAlign::Center));
    assert_eq!(fancy.v_align, Some(VAlign::Top));
    assert!(fancy.wrap);
    assert_eq!(fancy.indent, 2);
    assert_eq!(
      sheet.format(1).unwrap().format(1234.5, false).text,
      "$1,234.50"
    );
  }

  #[test]
  fn reads_a_sheet_layout() {
    let xml = br#"<worksheet>
      <sheetViews><sheetView showGridLines="0" workbookViewId="0"/></sheetViews>
      <sheetFormatPr defaultRowHeight="15"/>
      <cols><col min="2" max="3" width="20.7109375" customWidth="1"/><col min="5" max="5" hidden="1" width="9"/></cols>
      <sheetData>
        <row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="s"><v>0</v></c><c s="1"><v>2</v></c></row>
        <row r="4" hidden="1"><c r="C4"><v>1</v></c></row>
      </sheetData>
    </worksheet>"#;
    let styles = StyleSheet {
      styles: vec![CellStyle::default(), CellStyle::default()],
      formats: vec![NumberFormat::parse("General")],
    };
    let meta = parse_sheet(xml, &styles);
    // The second cell has no `r`, so it is the one after A1.
    assert_eq!(meta.cells, vec![(0, 0, 1), (0, 1, 1)]);
    let layout = meta.layout.unwrap();
    assert!(!layout.show_grid_lines);
    assert_eq!(layout.default_row_height, 20.0);
    assert_eq!(
      layout.cols[0],
      ColSpan {
        first: 1,
        last: 2,
        width: 145.0
      }
    );
    assert_eq!(layout.cols[1].width, 0.0);
    assert_eq!(
      layout.rows,
      vec![
        RowSize {
          row: 0,
          height: 40.0
        },
        RowSize {
          row: 3,
          height: 0.0
        }
      ]
    );
  }
}
