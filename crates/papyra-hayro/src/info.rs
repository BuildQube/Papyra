//! The information dictionary and the page labels.
//!
//! hayro parses the information dictionary for us — [`Pdf::metadata`] — but hands
//! back raw bytes and its own date type, so what is left is decoding and a conversion
//! JavaScript can read. Page labels it does not touch at all.

use crate::dest::{MAX_DEPTH, MAX_ENTRIES};
use crate::strings::decode_non_empty;
use hayro_syntax::object::String as PdfString;
use hayro_syntax::object::dict::keys;
use hayro_syntax::object::{Array, DateTime, Dict, MaybeRef, Name, Object, ObjectIdentifier};
use hayro_syntax::xref::XRef;
use hayro_syntax::{Pdf, PdfVersion};
use papyra_core::Metadata;
use std::collections::HashSet;

/// Read the document information dictionary.
pub fn read_metadata(pdf: &Pdf) -> Metadata {
  let raw = pdf.metadata();
  Metadata {
    title: raw.title.as_deref().and_then(decode_non_empty),
    author: raw.author.as_deref().and_then(decode_non_empty),
    subject: raw.subject.as_deref().and_then(decode_non_empty),
    keywords: raw.keywords.as_deref().and_then(decode_non_empty),
    creator: raw.creator.as_deref().and_then(decode_non_empty),
    producer: raw.producer.as_deref().and_then(decode_non_empty),
    created: raw.creation_date.as_ref().map(to_iso8601),
    modified: raw.modification_date.as_ref().map(to_iso8601),
  }
}

/// Convert a PDF date *string* to ISO 8601.
///
/// A second parser, reluctantly. hayro parses this format already, but
/// `DateTime::from_bytes` is `pub(crate)` and the only `DateTime` it hands out is the
/// information dictionary's — so a date anywhere else in the file, such as an embedded
/// file's `/Params /ModDate`, is unreachable through it.
///
/// The format is `D:YYYYMMDDHHmmSSOHH'mm'`, truncatable after any field. Everything
/// after the year is optional and defaulted the way [`to_iso8601`] defaults it: month
/// and day to 1, the rest to zero, so a date the file wrote as `D:2024` comes back as
/// the same approximation rather than as something no parser accepts.
pub(crate) fn date_string_to_iso8601(bytes: &[u8]) -> Option<String> {
  let digits = bytes.strip_prefix(b"D:").unwrap_or(bytes);
  // Anything shorter than a year is not a date, and a non-numeric year means this is
  // some other string that happened to be in a date slot.
  let field = |at: usize, len: usize, default: u32| -> u32 {
    digits
      .get(at..at + len)
      .and_then(|s| std::str::from_utf8(s).ok())
      .and_then(|s| s.parse::<u32>().ok())
      .unwrap_or(default)
  };
  if digits.len() < 4 || !digits[..4].iter().all(u8::is_ascii_digit) {
    return None;
  }

  let year = field(0, 4, 0);
  let month = field(4, 2, 1).clamp(1, 12);
  let day = field(6, 2, 1).clamp(1, 31);
  let (hour, minute, second) = (field(8, 2, 0), field(10, 2, 0), field(12, 2, 0));

  // `O` is `+`, `-` or `Z`; absent means local time, which we report as UTC rather
  // than inventing an offset the file did not state.
  let zone = match digits.get(14) {
    Some(b'+') | Some(b'-') => {
      let sign = if digits[14] == b'-' { '-' } else { '+' };
      format!("{sign}{:02}:{:02}", field(15, 2, 0), field(18, 2, 0))
    }
    _ => "Z".to_string(),
  };

  Some(format!(
    "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}{zone}"
  ))
}

/// Convert a PDF date to ISO 8601, which is what `new Date(...)` parses.
///
/// Month and day are clamped to 1. A PDF date is legally as short as `D:2024`, and
/// hayro reports the missing components as zero — `2024-00-00` is not a date any
/// parser accepts, whereas `2024-01-01` is the same approximation the file itself made.
pub(crate) fn to_iso8601(date: &DateTime) -> String {
  let zone = if date.utc_offset_hour == 0 && date.utc_offset_minute == 0 {
    "Z".to_string()
  } else {
    let sign = if date.utc_offset_hour < 0 { '-' } else { '+' };
    format!(
      "{sign}{:02}:{:02}",
      date.utc_offset_hour.unsigned_abs(),
      date.utc_offset_minute
    )
  };
  format!(
    "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{zone}",
    date.year,
    date.month.max(1),
    date.day.max(1),
    date.hour,
    date.minute,
    date.second
  )
}

/// The version a document declares, as the string the specification spells it with.
///
/// hayro resolves this for us — the catalog's `/Version` overrides the header for
/// 1.4 and later, which is how an incrementally updated file reports the version it
/// was last saved as rather than the one it was created as.
///
/// One caveat worth knowing: hayro falls back to 1.0 for a header it cannot read, so
/// `"1.0"` means either a genuine PDF 1.0 — which is close to extinct — or a file
/// whose header is damaged. The two are indistinguishable from here.
pub fn version_string(version: PdfVersion) -> String {
  match version {
    PdfVersion::Pdf10 => "1.0",
    PdfVersion::Pdf11 => "1.1",
    PdfVersion::Pdf12 => "1.2",
    PdfVersion::Pdf13 => "1.3",
    PdfVersion::Pdf14 => "1.4",
    PdfVersion::Pdf15 => "1.5",
    PdfVersion::Pdf16 => "1.6",
    PdfVersion::Pdf17 => "1.7",
    PdfVersion::Pdf20 => "2.0",
  }
  .to_string()
}

/// How a range of pages is numbered (PDF 32000-1, table 159).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Style {
  Decimal,
  RomanLower,
  RomanUpper,
  LetterLower,
  LetterUpper,
}

/// One `/PageLabels` range: where it starts, and how it numbers from there.
#[derive(Debug, Clone, PartialEq)]
struct Range {
  /// Style is optional. Without one the label is the prefix alone, which is how a
  /// cover sheet gets a label with no number in it.
  style: Option<Style>,
  prefix: String,
  /// `/St`, the number the range counts from. Defaults to 1.
  start_at: u32,
}

/// Read the label printed on each page, one entry per page.
///
/// Empty when the document defines no `/PageLabels` — that is the caller's signal to
/// fall back to the page index. A document that *does* define labels but says nothing
/// about a particular page yields an empty string for it, which is a different thing:
/// the document was asked and had no answer.
pub fn read_page_labels(pdf: &Pdf) -> Vec<String> {
  let xref = pdf.xref();
  let Some(catalog) = xref.get::<Dict>(xref.root_id()) else {
    return Vec::new();
  };
  let Some(root) = catalog.get::<Dict>(keys::PAGE_LABELS) else {
    return Vec::new();
  };

  let mut ranges = Vec::new();
  read_number_tree(xref, &root, 0, &mut HashSet::new(), &mut ranges);
  if ranges.is_empty() {
    return Vec::new();
  }
  ranges.sort_by_key(|(start, _)| *start);

  let count = pdf.pages().len();
  let mut labels = vec![String::new(); count];
  for (i, (start, range)) in ranges.iter().enumerate() {
    if *start >= count {
      continue;
    }
    // Clamping the lower bound to `start` covers two ranges that claim the same
    // page, which a malformed number tree can do and which would otherwise ask for
    // a backwards slice.
    let end = ranges
      .get(i + 1)
      .map_or(count, |(next, _)| *next)
      .clamp(*start, count);
    for (offset, label) in labels[*start..end].iter_mut().enumerate() {
      let number = range.start_at as usize + offset;
      *label = format!("{}{}", range.prefix, numeral(range.style, number));
    }
  }
  labels
}

/// Walk a number tree, collecting `(page index, range)` pairs.
///
/// Bounded by `visited` rather than by depth alone, for the reason spelled out on the
/// name tree in [`crate::dest`]: a node whose `/Kids` points back at an ancestor
/// branches rather than repeats, so a depth cap turns a cycle into billions of visits
/// instead of an infinite loop.
fn read_number_tree(
  xref: &XRef,
  node: &Dict<'_>,
  depth: usize,
  visited: &mut HashSet<ObjectIdentifier>,
  out: &mut Vec<(usize, Range)>,
) {
  if depth >= MAX_DEPTH || out.len() >= MAX_ENTRIES {
    return;
  }

  if let Some(nums) = node.get::<Array<'_>>(keys::NUMS) {
    // Flat `[ index dict index dict ... ]`.
    let mut iter = nums.raw_iter();
    while let Some(key) = iter.next() {
      let Some(value) = iter.next() else { break };
      let MaybeRef::NotRef(Object::Number(index)) = key else {
        continue;
      };
      let index = index.as_f64();
      // A negative or fractional key addresses no page.
      if index < 0.0 || index.fract() != 0.0 {
        continue;
      }
      let entry = match value {
        MaybeRef::Ref(id) => xref.get::<Dict<'_>>(id.into()),
        MaybeRef::NotRef(Object::Dict(dict)) => Some(dict),
        MaybeRef::NotRef(_) => None,
      };
      if let Some(entry) = entry {
        out.push((index as usize, range_of(&entry)));
      }
    }
  }

  let Some(kids) = node.get::<Array<'_>>(keys::KIDS) else {
    return;
  };
  for kid in kids.raw_iter() {
    match kid {
      MaybeRef::Ref(kid_ref) => {
        if !visited.insert(kid_ref.into()) {
          continue;
        }
        if let Some(kid) = xref.get::<Dict<'_>>(kid_ref.into()) {
          read_number_tree(xref, &kid, depth + 1, visited, out);
        }
      }
      // An inline kid is nested syntax, so it cannot point back at an ancestor.
      MaybeRef::NotRef(Object::Dict(kid)) => read_number_tree(xref, &kid, depth + 1, visited, out),
      MaybeRef::NotRef(_) => {}
    }
  }
}

fn range_of(entry: &Dict<'_>) -> Range {
  let style = entry
    .get::<Name<'_>>(keys::S)
    .and_then(|name| match &*name {
      b"D" => Some(Style::Decimal),
      b"r" => Some(Style::RomanLower),
      b"R" => Some(Style::RomanUpper),
      b"a" => Some(Style::LetterLower),
      b"A" => Some(Style::LetterUpper),
      _ => None,
    });
  Range {
    style,
    prefix: entry
      .get::<PdfString>(keys::P)
      .and_then(|prefix| decode_non_empty(prefix.as_bytes()))
      .unwrap_or_default(),
    // `/St` must be >= 1; a file that says 0 gets the default rather than a label
    // that counts from zero.
    start_at: entry
      .get::<u32>(keys::ST)
      .filter(|st| *st >= 1)
      .unwrap_or(1),
  }
}

fn numeral(style: Option<Style>, number: usize) -> String {
  match style {
    None => String::new(),
    Some(Style::Decimal) => number.to_string(),
    Some(Style::RomanLower) => roman(number).to_lowercase(),
    Some(Style::RomanUpper) => roman(number),
    Some(Style::LetterLower) => letters(number, b'a'),
    Some(Style::LetterUpper) => letters(number, b'A'),
  }
}

/// Roman numerals, with thousands as repeated `M`.
///
/// No document numbers a page 4000, but the arithmetic has to terminate on one that
/// claims to.
fn roman(number: usize) -> String {
  const PARTS: [(usize, &str); 13] = [
    (1000, "M"),
    (900, "CM"),
    (500, "D"),
    (400, "CD"),
    (100, "C"),
    (90, "XC"),
    (50, "L"),
    (40, "XL"),
    (10, "X"),
    (9, "IX"),
    (5, "V"),
    (4, "IV"),
    (1, "I"),
  ];

  let mut left = number;
  let mut out = String::new();
  for (value, digit) in PARTS {
    while left >= value {
      out.push_str(digit);
      left -= value;
    }
  }
  out
}

/// `a`-`z`, then `aa`-`zz`, then `aaa`-`ccc` (PDF 32000-1, table 159).
///
/// A repeated letter, not base 26 — page 27 is `aa`, not `ab`.
fn letters(number: usize, first: u8) -> String {
  if number == 0 {
    return String::new();
  }
  let letter = (first + ((number - 1) % 26) as u8) as char;
  let repeats = (number - 1) / 26 + 1;
  std::iter::repeat_n(letter, repeats).collect()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::fixtures::build_pdf;
  use std::sync::Arc;

  /// A document of `pages` empty pages, with whatever the catalog needs.
  ///
  /// Page objects go last: `build_pdf` numbers its xref by position, so the objects
  /// have to stay contiguous from 1 and a gap would corrupt the table.
  fn document(pages: usize, catalog_extra: &str, objects: &[(u32, &str)]) -> Pdf {
    let first = objects.iter().map(|(n, _)| *n + 1).max().unwrap_or(4) as usize;
    let kids: Vec<String> = (0..pages).map(|i| format!("{} 0 R", first + i)).collect();
    let mut all = vec![
      (
        1,
        format!("<< /Type /Catalog /Pages 2 0 R {catalog_extra} >>"),
      ),
      (
        2,
        format!(
          "<< /Type /Pages /Kids [{}] /Count {pages} >>",
          kids.join(" ")
        ),
      ),
      (3, "<< /Length 0 >>\nstream\nendstream".to_string()),
    ];
    all.extend(objects.iter().map(|(n, body)| (*n, body.to_string())));
    all.extend((0..pages).map(|i| {
      (
        (first + i) as u32,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R >>".to_string(),
      )
    }));
    all.sort_by_key(|(n, _)| *n);
    Pdf::new(Arc::new(build_pdf(&all))).expect("fixture should parse")
  }

  // ---- metadata ----

  #[test]
  fn reads_the_information_dictionary() {
    // `build_pdf` writes its own trailer, so the Info dict is reached through the
    // one place hayro looks for it.
    let bytes = build_pdf(&[
      (1, "<< /Type /Catalog /Pages 2 0 R >>".to_string()),
      (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string()),
      (
        3,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>".to_string(),
      ),
      (4, "<< /Length 0 >>\nstream\nendstream".to_string()),
    ]);
    let pdf = Pdf::new(Arc::new(bytes)).expect("fixture should parse");
    // No `/Info`, so every field is absent rather than empty-stringed.
    assert_eq!(read_metadata(&pdf), Metadata::default());
  }

  #[test]
  fn formats_a_date_as_iso8601() {
    let date = DateTime {
      year: 2024,
      month: 3,
      day: 9,
      hour: 14,
      minute: 5,
      second: 30,
      utc_offset_hour: -7,
      utc_offset_minute: 0,
    };
    assert_eq!(to_iso8601(&date), "2024-03-09T14:05:30-07:00");
  }

  #[test]
  fn formats_a_utc_date_with_z() {
    let date = DateTime {
      year: 2024,
      month: 3,
      day: 9,
      hour: 0,
      minute: 0,
      second: 0,
      utc_offset_hour: 0,
      utc_offset_minute: 0,
    };
    assert_eq!(to_iso8601(&date), "2024-03-09T00:00:00Z");
  }

  #[test]
  fn clamps_a_date_that_omitted_its_month_and_day() {
    // `D:2024` is legal. Reporting `2024-00-00` would not parse anywhere.
    let date = DateTime {
      year: 2024,
      month: 0,
      day: 0,
      hour: 0,
      minute: 0,
      second: 0,
      utc_offset_hour: 0,
      utc_offset_minute: 0,
    };
    assert_eq!(to_iso8601(&date), "2024-01-01T00:00:00Z");
  }

  #[test]
  fn reads_the_declared_version() {
    // `build_pdf` writes a `%PDF-1.7` header and no catalog `/Version`.
    let pdf = document(1, "", &[]);
    assert_eq!(version_string(pdf.version()), "1.7");
  }

  #[test]
  fn every_version_maps_to_its_spec_spelling() {
    let cases = [
      (PdfVersion::Pdf10, "1.0"),
      (PdfVersion::Pdf14, "1.4"),
      (PdfVersion::Pdf17, "1.7"),
      (PdfVersion::Pdf20, "2.0"),
    ];
    for (version, expected) in cases {
      assert_eq!(version_string(version), expected);
    }
  }

  // ---- page labels ----

  #[test]
  fn no_page_labels_yields_no_entries() {
    // Empty, not `["1", "2", "3"]` — the caller needs to know the document said
    // nothing so it can fall back to the index.
    assert!(read_page_labels(&document(3, "", &[])).is_empty());
  }

  #[test]
  fn numbers_front_matter_in_roman_and_the_body_in_decimal() {
    let labels = read_page_labels(&document(
      6,
      "/PageLabels 4 0 R",
      &[(4, "<< /Nums [0 << /S /r >> 3 << /S /D /St 1 >>] >>")],
    ));
    assert_eq!(labels, vec!["i", "ii", "iii", "1", "2", "3"]);
  }

  #[test]
  fn applies_a_prefix_and_a_starting_number() {
    let labels = read_page_labels(&document(
      3,
      "/PageLabels 4 0 R",
      &[(4, "<< /Nums [0 << /S /D /P (A-) /St 5 >>] >>")],
    ));
    assert_eq!(labels, vec!["A-5", "A-6", "A-7"]);
  }

  #[test]
  fn a_range_with_no_style_is_its_prefix_alone() {
    // How a cover sheet gets a label that is not a number.
    let labels = read_page_labels(&document(
      2,
      "/PageLabels 4 0 R",
      &[(4, "<< /Nums [0 << /P (Cover) >> 1 << /S /D >>] >>")],
    ));
    assert_eq!(labels, vec!["Cover", "1"]);
  }

  #[test]
  fn a_page_before_the_first_range_has_an_empty_label() {
    // Distinct from "no /PageLabels at all": here the document was asked and had
    // nothing to say about page 0.
    let labels = read_page_labels(&document(
      3,
      "/PageLabels 4 0 R",
      &[(4, "<< /Nums [1 << /S /D >>] >>")],
    ));
    assert_eq!(labels, vec!["", "1", "2"]);
  }

  #[test]
  fn reads_ranges_out_of_a_kids_tree() {
    let labels = read_page_labels(&document(
      4,
      "/PageLabels 4 0 R",
      &[
        (4, "<< /Kids [5 0 R] >>"),
        (5, "<< /Nums [0 << /S /R >> 2 << /S /D >>] >>"),
      ],
    ));
    assert_eq!(labels, vec!["I", "II", "1", "2"]);
  }

  #[test]
  fn terminates_on_a_kids_cycle() {
    let labels = read_page_labels(&document(
      2,
      "/PageLabels 4 0 R",
      &[
        (4, "<< /Kids [5 0 R] /Nums [0 << /S /D >>] >>"),
        (5, "<< /Kids [4 0 R] >>"),
      ],
    ));
    assert_eq!(labels, vec!["1", "2"]);
  }

  #[test]
  fn ignores_a_range_starting_past_the_last_page() {
    let labels = read_page_labels(&document(
      2,
      "/PageLabels 4 0 R",
      &[(4, "<< /Nums [0 << /S /D >> 900 << /S /r >>] >>")],
    ));
    assert_eq!(labels, vec!["1", "2"]);
  }

  // ---- numerals ----

  #[test]
  fn converts_roman_numerals() {
    let cases = [
      (1, "I"),
      (4, "IV"),
      (9, "IX"),
      (14, "XIV"),
      (40, "XL"),
      (1990, "MCMXC"),
      (4000, "MMMM"),
    ];
    for (number, expected) in cases {
      assert_eq!(roman(number), expected, "for {number}");
    }
  }

  #[test]
  fn letters_repeat_rather_than_counting_in_base_26() {
    // Table 159: a-z, then aa-zz. Page 27 is `aa`, not `ab`.
    assert_eq!(letters(1, b'a'), "a");
    assert_eq!(letters(26, b'a'), "z");
    assert_eq!(letters(27, b'a'), "aa");
    assert_eq!(letters(52, b'A'), "ZZ");
    assert_eq!(letters(53, b'A'), "AAA");
  }
}
