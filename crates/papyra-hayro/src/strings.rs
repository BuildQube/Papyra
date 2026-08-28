//! Decoding PDF text strings.
//!
//! Its own module because three unrelated readers need it — outline titles, link
//! tooltips, and the information dictionary — and every one of them would otherwise
//! reach for `from_utf8_lossy` and get the dashes wrong.

/// PDFDocEncoding's `0x80..=0x9F` block (PDF 32000-1, annex D.2).
///
/// Latin-1 puts unused C1 control codes here, so the two encodings agree everywhere
/// *except* this range — which is precisely where the em and en dashes live, and a
/// bookmark title like `A101 — SITE PLAN` is mostly dash. Decoding as Latin-1 would
/// bury a control character in the middle of the title.
const PDF_DOC_ENCODING_C1: [char; 32] = [
  '\u{2022}', '\u{2020}', '\u{2021}', '\u{2026}', '\u{2014}', '\u{2013}', '\u{0192}', '\u{2044}',
  '\u{2039}', '\u{203A}', '\u{2212}', '\u{2030}', '\u{201E}', '\u{201C}', '\u{201D}', '\u{2018}',
  '\u{2019}', '\u{201A}', '\u{2122}', '\u{FB01}', '\u{FB02}', '\u{0141}', '\u{0152}', '\u{0160}',
  '\u{0178}', '\u{017D}', '\u{0131}', '\u{0142}', '\u{0153}', '\u{0161}', '\u{017E}', '\u{FFFD}',
];

/// Decode UTF-16 code units of a known endianness.
///
/// `as_chunks` leaves a trailing odd byte in the remainder, which is the right answer
/// for a truncated string: half a code unit decodes to nothing.
fn decode_utf16(bytes: &[u8], to_unit: fn([u8; 2]) -> u16) -> String {
  let (pairs, _trailing) = bytes.as_chunks::<2>();
  let units: Vec<u16> = pairs.iter().copied().map(to_unit).collect();
  String::from_utf16_lossy(&units)
}

/// Decode a PDF text string.
///
/// hayro hands back raw bytes, so the encoding is ours to sort out: UTF-16 and UTF-8
/// announce themselves with a BOM, and everything else is PDFDocEncoding.
pub fn decode_text_string(bytes: &[u8]) -> Option<String> {
  if bytes.is_empty() {
    return None;
  }

  if let [0xFE, 0xFF, rest @ ..] = bytes {
    return Some(decode_utf16(rest, u16::from_be_bytes));
  }

  if let [0xFF, 0xFE, rest @ ..] = bytes {
    return Some(decode_utf16(rest, u16::from_le_bytes));
  }

  if let [0xEF, 0xBB, 0xBF, rest @ ..] = bytes {
    return Some(String::from_utf8_lossy(rest).into_owned());
  }

  Some(
    bytes
      .iter()
      .map(|byte| match byte {
        0x80..=0x9F => PDF_DOC_ENCODING_C1[(byte - 0x80) as usize],
        _ => *byte as char,
      })
      .collect(),
  )
}

/// Decode a text string and discard it if it carries no content.
///
/// Producers write `/Author ()` and `/Title ( )` often enough that a caller checking
/// "is there a title" would otherwise have to trim every field itself.
pub fn decode_non_empty(bytes: &[u8]) -> Option<String> {
  let decoded = decode_text_string(bytes)?;
  let trimmed = decoded.trim();
  if trimmed.is_empty() {
    return None;
  }
  Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn decodes_ascii() {
    assert_eq!(
      decode_text_string(b"A101 - SITE PLAN").as_deref(),
      Some("A101 - SITE PLAN")
    );
  }

  #[test]
  fn decodes_utf16be_with_bom() {
    let bytes = [0xFE, 0xFF, 0x00, 0x48, 0x00, 0x69];
    assert_eq!(decode_text_string(&bytes).as_deref(), Some("Hi"));
  }

  #[test]
  fn decodes_utf16le_with_bom() {
    let bytes = [0xFF, 0xFE, 0x48, 0x00, 0x69, 0x00];
    assert_eq!(decode_text_string(&bytes).as_deref(), Some("Hi"));
  }

  #[test]
  fn decodes_utf8_with_bom() {
    let bytes = [0xEF, 0xBB, 0xBF, b'H', b'i'];
    assert_eq!(decode_text_string(&bytes).as_deref(), Some("Hi"));
  }

  #[test]
  fn decodes_latin1_high_bytes() {
    // 0xE9 is e-acute in both PDFDocEncoding and Latin-1.
    assert_eq!(
      decode_text_string(&[b'c', b'a', b'f', 0xE9]).as_deref(),
      Some("café")
    );
  }

  #[test]
  fn decodes_pdfdoc_dashes_rather_than_latin1_controls() {
    // 0x84 is an em dash in PDFDocEncoding and an unused C1 control in Latin-1.
    // Titles like `A101 — SITE PLAN` are mostly this byte.
    assert_eq!(decode_text_string(&[0x84]).as_deref(), Some("\u{2014}"));
  }

  #[test]
  fn empty_string_is_none() {
    assert_eq!(decode_text_string(b""), None);
  }

  #[test]
  fn a_blank_string_carries_no_content() {
    assert_eq!(decode_non_empty(b"   "), None);
    assert_eq!(decode_non_empty(b""), None);
    assert_eq!(decode_non_empty(b"  Report  ").as_deref(), Some("Report"));
  }
}
