//! CSV and TSV: decode the bytes, find the delimiter, split.
//!
//! Splitting is the easy part and the `csv` crate does it. What a JS parser gets
//! wrong is everything before that — a CSV saved by Excel on Windows is
//! Windows-1252, not UTF-8, and one saved in a locale with a decimal comma is
//! separated by semicolons. Neither is announced anywhere in the file.

use crate::{Cell, Cells, Result, Sheet, TableError};
use encoding_rs::{Encoding, UTF_8};
use std::borrow::Cow;

/// How to read delimited text. Every field is sniffed when absent.
#[derive(Debug, Clone, Default)]
pub struct DelimitedOptions {
  /// A single ASCII byte, e.g. `b';'`.
  pub delimiter: Option<u8>,
  /// A WHATWG encoding label, e.g. `"windows-1252"` or `"shift_jis"`.
  pub encoding: Option<String>,
}

pub(crate) struct Delimited {
  pub sheet: Sheet,
  pub encoding: &'static str,
  pub delimiter: u8,
}

/// Candidates in preference order: a tie goes to the earlier one.
const DELIMITERS: &[u8; 4] = b",;\t|";

/// How much text the delimiter sniff looks at. Enough for a few hundred rows of
/// anything ordinary, and it never parses the whole of a large file twice.
const SNIFF_BYTES: usize = 64 * 1024;

/// What text has, since it carries no sheet name of its own. The caller knows the
/// file name and is welcome to show that instead.
const SHEET_NAME: &str = "Sheet1";

pub(crate) fn read(bytes: &[u8], opts: &DelimitedOptions, max_cells: usize) -> Result<Delimited> {
  let (text, encoding) = decode(bytes, opts.encoding.as_deref())?;
  let delimiter = match opts.delimiter {
    Some(d) => d,
    None => sniff_delimiter(&text),
  };

  let mut reader = csv::ReaderBuilder::new()
    .has_headers(false)
    // Ragged rows are normal — a trailing note, a short summary line — and the grid
    // draws a short row as one with empty cells at the end, which is what it is.
    .flexible(true)
    .delimiter(delimiter)
    .from_reader(text.as_bytes());

  let mut cells = Cells::new(max_cells);
  let mut record = csv::StringRecord::new();
  let mut rows = 0u32;
  let mut width = 0u32;
  'records: loop {
    match reader.read_record(&mut record) {
      Ok(true) => {}
      Ok(false) => break,
      Err(e) => return Err(TableError::Parse(e.to_string())),
    }
    for (col, field) in record.iter().enumerate() {
      if !cells.push(rows, col as u32, to_cell(field)) {
        break 'records;
      }
    }
    width = width.max(record.len() as u32);
    rows += 1;
  }
  // A row or column of empty fields is still part of the file. Sizing from the cells
  // alone would drop a trailing blank column, and with it the header that names it.
  if !cells.truncated() {
    cells.extend_to(rows, width);
  }
  Ok(Delimited {
    sheet: Sheet::new(SHEET_NAME.to_string(), cells, Vec::new()),
    encoding: encoding.name(),
    delimiter,
  })
}

/// Bytes to text: a label if given, else a byte-order mark, else UTF-8 if the bytes
/// are valid UTF-8, else chardetng's guess.
///
/// Valid UTF-8 is checked before guessing because it is nearly conclusive — text in
/// a legacy encoding that happens to validate is vanishingly rare once it holds any
/// byte above 0x7F — and chardetng is tuned for the opposite question.
fn decode<'a>(bytes: &'a [u8], label: Option<&str>) -> Result<(Cow<'a, str>, &'static Encoding)> {
  let (encoding, bom) = match label {
    Some(label) => {
      let encoding = Encoding::for_label(label.as_bytes())
        .ok_or_else(|| TableError::Parse(format!("unknown encoding {label:?}")))?;
      // An explicit label still loses to a BOM for the same encoding, so the BOM
      // does not end up as a stray character at the start of the first cell.
      match Encoding::for_bom(bytes) {
        Some((found, len)) if found == encoding => (encoding, len),
        _ => (encoding, 0),
      }
    }
    None => match Encoding::for_bom(bytes) {
      Some(found) => found,
      None if std::str::from_utf8(bytes).is_ok() => (UTF_8, 0),
      None => {
        let mut detector = chardetng::EncodingDetector::new();
        detector.feed(bytes, true);
        (detector.guess(None, false), 0)
      }
    },
  };
  let (text, _) = encoding.decode_without_bom_handling(&bytes[bom..]);
  Ok((text, encoding))
}

/// Pick the candidate that splits the most sampled rows into the same number of
/// fields, more than one. Consistency rather than frequency, because a comma inside
/// prose shows up often and consistently in nothing.
fn sniff_delimiter(text: &str) -> u8 {
  let mut end = text.len().min(SNIFF_BYTES);
  while !text.is_char_boundary(end) {
    end -= 1;
  }
  let sample = &text[..end];
  // A sample that was cut short ends in a partial row, which would count against
  // whichever delimiter is right.
  let sample = match sample.rfind('\n') {
    Some(i) if end < text.len() => &sample[..i],
    _ => sample,
  };

  let mut best = (0.0f64, b',');
  for &delimiter in DELIMITERS {
    let mut reader = csv::ReaderBuilder::new()
      .has_headers(false)
      .flexible(true)
      .delimiter(delimiter)
      .from_reader(sample.as_bytes());
    let counts: Vec<usize> = reader
      .records()
      .map_while(|r| r.ok())
      .map(|r| r.len())
      .collect();
    let Some(mode) = mode(&counts) else { continue };
    if mode < 2 {
      continue;
    }
    let consistency = counts.iter().filter(|&&n| n == mode).count() as f64 / counts.len() as f64;
    if consistency > best.0 {
      best = (consistency, delimiter);
    }
  }
  best.1
}

fn mode(counts: &[usize]) -> Option<usize> {
  let mut tally = std::collections::HashMap::new();
  for &n in counts {
    *tally.entry(n).or_insert(0usize) += 1;
  }
  // Ties go to the wider count, so a header row cannot outvote the data under it.
  tally
    .into_iter()
    .max_by_key(|&(n, hits)| (hits, n))
    .map(|(n, _)| n)
}

fn to_cell(field: &str) -> Cell {
  if field.is_empty() {
    return Cell::Empty;
  }
  match number(field) {
    Some(n) => Cell::ParsedNumber(n, field.to_string()),
    None => Cell::Text(field.to_string()),
  }
}

/// A field that is unambiguously a number, and nothing that merely parses as one.
///
/// `007` and `01234` are identifiers — zip codes, part numbers — and turning them
/// into 7 and 1234 is the best-known way to corrupt a CSV. Rust's float parser also
/// accepts `inf` and `NaN`, which no one exporting a CSV meant as numbers.
fn number(field: &str) -> Option<f64> {
  let digits = field.strip_prefix(['-', '+']).unwrap_or(field);
  if !digits.starts_with(|c: char| c.is_ascii_digit() || c == '.') {
    return None;
  }
  if !digits
    .bytes()
    .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'-' | b'+'))
  {
    return None;
  }
  let integer = digits.split(['.', 'e', 'E']).next().unwrap_or("");
  if integer.len() > 1 && integer.starts_with('0') {
    return None;
  }
  field.parse::<f64>().ok().filter(|n| n.is_finite())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn read_default(bytes: &[u8]) -> Delimited {
    read(bytes, &DelimitedOptions::default(), usize::MAX).unwrap()
  }

  #[test]
  fn picks_semicolons_when_commas_are_decimal_points() {
    let d = read_default(b"Name;Amount\nA;1,5\nB;2,25\n");
    assert_eq!(d.delimiter, b';');
    assert_eq!(d.sheet.cell(1, 1), &Cell::Text("1,5".into()));
  }

  #[test]
  fn picks_tabs_and_pipes() {
    assert_eq!(read_default(b"a\tb\tc\n1\t2\t3\n").delimiter, b'\t');
    assert_eq!(read_default(b"a|b\n1|2\n").delimiter, b'|');
  }

  #[test]
  fn a_single_column_falls_back_to_commas() {
    let d = read_default(b"just\none\ncolumn\n");
    assert_eq!(d.delimiter, b',');
    assert_eq!((d.sheet.rows, d.sheet.cols), (3, 1));
  }

  #[test]
  fn quoted_delimiters_and_newlines_stay_in_the_field() {
    let d = read_default(b"a,b\n\"x, y\",\"two\nlines\"\n");
    assert_eq!(d.sheet.cell(1, 0), &Cell::Text("x, y".into()));
    assert_eq!(d.sheet.cell(1, 1), &Cell::Text("two\nlines".into()));
    assert_eq!(d.sheet.rows, 2);
  }

  #[test]
  fn ragged_rows_are_padded() {
    let d = read_default(b"a,b,c\n1\n");
    assert_eq!((d.sheet.rows, d.sheet.cols), (2, 3));
    assert_eq!(d.sheet.cell(1, 2), &Cell::Empty);
  }

  #[test]
  fn windows_1252_is_detected_rather_than_mangled() {
    // "Café,€5" as Excel on Windows saves it: é is 0xE9 and € is 0x80.
    let d = read_default(b"Caf\xE9,\x805\nx,y\n");
    assert_eq!(d.encoding, "windows-1252");
    assert_eq!(d.sheet.cell(0, 0), &Cell::Text("Café".into()));
    assert_eq!(d.sheet.cell(0, 1), &Cell::Text("€5".into()));
  }

  #[test]
  fn a_bom_is_honoured_and_removed() {
    let d = read_default(b"\xEF\xBB\xBFa,b\n1,2\n");
    assert_eq!(d.encoding, "UTF-8");
    assert_eq!(d.sheet.cell(0, 0), &Cell::Text("a".into()));

    let utf16: Vec<u8> = [0xFF, 0xFE]
      .into_iter()
      .chain("a,b\n".encode_utf16().flat_map(u16::to_le_bytes))
      .collect();
    let d = read_default(&utf16);
    assert_eq!(d.encoding, "UTF-16LE");
    assert_eq!(d.sheet.cell(0, 1), &Cell::Text("b".into()));
  }

  #[test]
  fn an_explicit_encoding_wins() {
    let opts = DelimitedOptions {
      encoding: Some("iso-8859-7".into()),
      ..Default::default()
    };
    // 0xE1 is α in Greek and á in Latin-1.
    let d = read(b"\xE1,b\n", &opts, usize::MAX).unwrap();
    assert_eq!(d.sheet.cell(0, 0), &Cell::Text("α".into()));
    assert!(
      read(
        b"a",
        &DelimitedOptions {
          encoding: Some("klingon".into()),
          ..Default::default()
        },
        usize::MAX
      )
      .is_err()
    );
  }

  #[test]
  fn past_the_cap_a_csv_is_its_first_whole_rows() {
    let d = read(b"a,b,c\n1,2,3\n4,5,6\n", &DelimitedOptions::default(), 7).unwrap();
    // Seven cells fit two whole rows and one cell of the third; the third goes.
    assert!(d.sheet.truncated);
    assert_eq!((d.sheet.rows, d.sheet.cols), (2, 3));
    assert_eq!(d.sheet.cell(2, 0), &Cell::Empty);

    let all = read(b"a,b,c\n1,2,3\n", &DelimitedOptions::default(), 6).unwrap();
    assert!(!all.sheet.truncated);
  }

  #[test]
  fn a_blank_last_column_still_counts() {
    let d = read_default(b"a,b,\n1,2,\n");
    assert_eq!(d.sheet.cols, 3);
  }

  #[test]
  fn numbers_are_numbers_and_identifiers_are_not() {
    assert_eq!(number("12"), Some(12.0));
    assert_eq!(number("-0.5"), Some(-0.5));
    assert_eq!(number(".5"), Some(0.5));
    assert_eq!(number("1e3"), Some(1000.0));
    assert_eq!(number("0"), Some(0.0));
    assert_eq!(number("0.25"), Some(0.25));
    assert_eq!(number("007"), None);
    assert_eq!(number("inf"), None);
    assert_eq!(number("NaN"), None);
    assert_eq!(number(" 1"), None);
    assert_eq!(number("1,000"), None);
    assert_eq!(number("2024-03-15"), None);
    assert_eq!(number("-"), None);
  }

  #[test]
  fn a_parsed_number_keeps_its_text() {
    let d = read_default(b"a,b\n2.50,1e3\n");
    assert_eq!(d.sheet.cell(1, 0), &Cell::ParsedNumber(2.5, "2.50".into()));
    assert_eq!(d.sheet.cell(1, 0).text(), "2.50");
    assert_eq!(d.sheet.cell(1, 1).text(), "1e3");
  }
}
