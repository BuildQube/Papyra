//! Cell values, and the packed form a window of them crosses the boundary in.

use calamine::{Data, ExcelDateTime};
use chrono::{Datelike, Timelike};

/// One cell's value.
///
/// Display text comes from [`Cell::text`] and is deliberately plain: number formats
/// are not applied yet, so a currency cell reads `1234.5` rather than `$1,234.50`. The
/// raw value is always kept beside it, so applying formats later changes the text and
/// nothing else.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
  Empty,
  Number(f64),
  /// A number read from delimited text, kept as written: `2.50` stays `2.50`, and
  /// `1e3` stays `1e3`. CSV has no types, so the text is the value's only authority.
  ParsedNumber(f64, String),
  Text(String),
  Bool(bool),
  /// An Excel date serial, and the date as ISO 8601. OpenDocument stores the ISO form
  /// only, and its serial is NaN.
  Date(f64, String),
  /// A length of time in days, and as `[h]:mm:ss`.
  Duration(f64, String),
  /// An error a formula evaluated to, e.g. `#DIV/0!`.
  Error(String),
}

/// The kind tags a [`Window`] carries, one byte per cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CellKind {
  Empty = 0,
  Number = 1,
  Text = 2,
  Bool = 3,
  Date = 4,
  Duration = 5,
  Error = 6,
}

impl Cell {
  pub fn kind(&self) -> CellKind {
    match self {
      Self::Empty => CellKind::Empty,
      Self::Number(_) | Self::ParsedNumber(..) => CellKind::Number,
      Self::Text(_) => CellKind::Text,
      Self::Bool(_) => CellKind::Bool,
      Self::Date(..) => CellKind::Date,
      Self::Duration(..) => CellKind::Duration,
      Self::Error(_) => CellKind::Error,
    }
  }

  /// The numeric value: the number, a bool as 1 or 0, a date's serial, a duration in
  /// days. NaN for everything else.
  pub fn number(&self) -> f64 {
    match self {
      Self::Number(n) | Self::ParsedNumber(n, _) | Self::Date(n, _) | Self::Duration(n, _) => *n,
      Self::Bool(b) => f64::from(u8::from(*b)),
      _ => f64::NAN,
    }
  }

  /// What a grid shows.
  pub fn text(&self) -> std::borrow::Cow<'_, str> {
    use std::borrow::Cow;
    match self {
      Self::Empty => Cow::Borrowed(""),
      Self::Number(n) => Cow::Owned(general(*n)),
      Self::ParsedNumber(_, s)
      | Self::Text(s)
      | Self::Date(_, s)
      | Self::Duration(_, s)
      | Self::Error(s) => Cow::Borrowed(s),
      // Excel's own spelling, which is also what a CSV export of the cell contains.
      Self::Bool(true) => Cow::Borrowed("TRUE"),
      Self::Bool(false) => Cow::Borrowed("FALSE"),
    }
  }
}

impl From<Data> for Cell {
  fn from(d: Data) -> Self {
    match d {
      Data::Empty => Self::Empty,
      Data::Int(i) => Self::Number(i as f64),
      Data::Float(f) => Self::Number(f),
      Data::String(s) if s.is_empty() => Self::Empty,
      Data::String(s) => Self::Text(s),
      Data::Bool(b) => Self::Bool(b),
      Data::DateTime(dt) => date_time(dt),
      Data::DateTimeIso(s) => Self::Date(f64::NAN, s),
      Data::DurationIso(s) => Self::Duration(f64::NAN, s),
      Data::Error(e) => Self::Error(e.to_string()),
    }
  }
}

fn date_time(dt: ExcelDateTime) -> Cell {
  let serial = dt.as_f64();
  if dt.is_duration() {
    return Cell::Duration(serial, duration(serial));
  }
  let Some(at) = dt.as_datetime() else {
    // Outside chrono's range, which a corrupt serial can be. The number is still true.
    return Cell::Number(serial);
  };
  // Formatted by hand: chrono's `format` sits behind its `alloc` feature, and three
  // fixed layouts do not need a strftime interpreter.
  let date = format!("{:04}-{:02}-{:02}", at.year(), at.month(), at.day());
  let time = format!("{:02}:{:02}:{:02}", at.hour(), at.minute(), at.second());
  let text = if serial < 1.0 {
    // A time with no date. Excel's day 0 is 1900-01-00, which is not a date at all.
    time
  } else if serial.fract() == 0.0 {
    date
  } else {
    format!("{date}T{time}")
  };
  Cell::Date(serial, text)
}

/// `[h]:mm:ss` — Excel's format for a duration, where the hours do not wrap at 24.
fn duration(days: f64) -> String {
  let total = (days * 86_400.0).round() as i64;
  let sign = if total < 0 { "-" } else { "" };
  let total = total.abs();
  format!(
    "{sign}{}:{:02}:{:02}",
    total / 3600,
    total / 60 % 60,
    total % 60
  )
}

/// A number as Excel's General format would show it, minus the column-width rules.
///
/// Excel keeps 15 significant digits, so rounding there first is what turns the
/// stored `0.30000000000000004` back into the `0.3` the user typed. Rust's `Display`
/// then gives the shortest string that round-trips, with no trailing zeros.
pub(crate) fn general(n: f64) -> String {
  if !n.is_finite() {
    return n.to_string();
  }
  let rounded: f64 = format!("{n:.14e}").parse().unwrap_or(n);
  let magnitude = rounded.abs();
  if magnitude != 0.0 && !(1e-9..1e15).contains(&magnitude) {
    // Excel's own switch to scientific, roughly — `1.5E+20`, not twenty digits.
    let s = format!("{rounded:e}");
    return match s.split_once('e') {
      Some((m, e)) if e.starts_with('-') => format!("{m}E{e}"),
      Some((m, e)) => format!("{m}E+{e}"),
      None => s,
    };
  }
  format!("{rounded}")
}

/// A rectangle of cells, packed for one trip across the napi boundary.
///
/// One JS object per cell costs more to build than the parse did, so a window is
/// four flat buffers instead: a kind byte and a number per cell, and every cell's text
/// in one string with offsets into it. The offsets are UTF-16 code units, which is
/// what JavaScript's `String.prototype.slice` counts in — byte offsets would put every
/// cell after the first non-ASCII character in the wrong place.
#[derive(Debug, Clone, PartialEq)]
pub struct Window {
  pub row_start: u32,
  pub col_start: u32,
  pub rows: u32,
  pub cols: u32,
  /// [`CellKind`] per cell, row-major.
  pub kinds: Vec<u8>,
  /// [`Cell::number`] per cell, row-major.
  pub numbers: Vec<f64>,
  /// Every cell's [`Cell::text`], concatenated.
  pub text: String,
  /// `rows * cols + 1` offsets into `text`; cell `i` is `offsets[i]..offsets[i + 1]`.
  pub offsets: Vec<u32>,
  /// Index into the sheet's styles per cell; 0 is the default style.
  pub styles: Vec<u16>,
  /// A colour the number format chose per cell — `[Red]` on a negative section —
  /// as `0x01RRGGBB`, or 0 for none. The high byte keeps black distinct from none.
  pub colors: Vec<u32>,
}

/// One cell, as a window is built from it.
pub(crate) struct Entry<'a> {
  pub cell: &'a Cell,
  pub text: std::borrow::Cow<'a, str>,
  pub style: u16,
  pub color: Option<u32>,
}

impl Window {
  pub(crate) fn encode<'a>(
    row_start: u32,
    col_start: u32,
    rows: u32,
    cols: u32,
    mut entry: impl FnMut(u32, u32) -> Entry<'a>,
  ) -> Self {
    let n = rows as usize * cols as usize;
    let mut w = Self {
      row_start,
      col_start,
      rows,
      cols,
      kinds: Vec::with_capacity(n),
      numbers: Vec::with_capacity(n),
      text: String::new(),
      offsets: Vec::with_capacity(n + 1),
      styles: Vec::with_capacity(n),
      colors: Vec::with_capacity(n),
    };
    let mut at = 0u32;
    w.offsets.push(0);
    for r in row_start..row_start + rows {
      for c in col_start..col_start + cols {
        let e = entry(r, c);
        w.kinds.push(e.cell.kind() as u8);
        w.numbers.push(e.cell.number());
        at += e.text.encode_utf16().count() as u32;
        w.text.push_str(&e.text);
        w.offsets.push(at);
        w.styles.push(e.style);
        w.colors.push(e.color.map_or(0, |c| 0x0100_0000 | c));
      }
    }
    w
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn general_undoes_float_noise_and_switches_to_scientific() {
    assert_eq!(general(0.1 + 0.2), "0.3");
    assert_eq!(general(12.0), "12");
    assert_eq!(general(-0.25), "-0.25");
    assert_eq!(general(1.5e20), "1.5E+20");
    assert_eq!(general(2e-12), "2E-12");
    assert_eq!(general(0.0), "0");
  }

  #[test]
  fn durations_do_not_wrap_at_a_day() {
    assert_eq!(duration(1.5), "36:00:00");
    assert_eq!(duration(-1.0 / 24.0), "-1:00:00");
  }

  #[test]
  fn an_empty_string_is_an_empty_cell() {
    // xlsx writes `<c t="s"/>`-style empties for styled blank cells; a grid should
    // not tell them apart from cells that were never touched.
    assert_eq!(Cell::from(Data::String(String::new())), Cell::Empty);
  }

  #[test]
  fn window_offsets_count_utf16_units() {
    let cells = [
      Cell::Text("\u{1F600}".into()),
      Cell::Text("é".into()),
      Cell::Bool(true),
    ];
    let w = Window::encode(0, 0, 1, 3, |_, c| Entry {
      cell: &cells[c as usize],
      text: cells[c as usize].text(),
      style: 0,
      color: (c == 2).then_some(0),
    });
    // An emoji is one char, four UTF-8 bytes and two UTF-16 units.
    assert_eq!(w.offsets, vec![0, 2, 3, 7]);
    assert_eq!(w.kinds, vec![2, 2, 3]);
    assert_eq!(w.numbers[2], 1.0);
    assert!(w.numbers[0].is_nan());
    // Black is a colour, and distinct from none.
    assert_eq!(w.colors, vec![0, 0, 0x0100_0000]);
  }
}
