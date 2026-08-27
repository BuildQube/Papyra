//! Minimal hand-assembled PDFs, for tests that need a real document.
//!
//! `Pdf` owns the xref and hands out the catalog, so neither the outline walk nor text
//! extraction can be driven from a mocked object layer — they need a file. Building
//! one by hand is both smaller than a checked-in fixture and easier to read: the thing
//! under test is right there in the test.

use hayro_syntax::Pdf;
use std::sync::Arc;

/// Assemble a well-formed PDF from numbered objects.
///
/// Objects must start at 1 and arrive in order.
pub fn build_pdf(objects: &[(u32, String)]) -> Vec<u8> {
  let mut out: Vec<u8> = b"%PDF-1.7\n".to_vec();
  let mut offsets = vec![0usize; objects.len() + 1];

  for (number, body) in objects {
    offsets[*number as usize] = out.len();
    out.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
  }

  let xref_offset = out.len();
  let size = objects.len() + 1;
  out.extend_from_slice(format!("xref\n0 {size}\n").as_bytes());
  out.extend_from_slice(b"0000000000 65535 f \n");
  for offset in offsets.iter().skip(1) {
    out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
  }
  out.extend_from_slice(
    format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n")
      .as_bytes(),
  );
  out
}

/// A single US-Letter page drawing `content`, with Helvetica available as `/F1`.
///
/// Helvetica is one of the 14 standard fonts, which hayro substitutes for via its
/// `embed-fonts` feature — see the note in this crate's `Cargo.toml`.
pub fn page_with_content(content: &str) -> Pdf {
  let bytes = build_pdf(&[
    (1, "<< /Type /Catalog /Pages 2 0 R >>".to_string()),
    (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string()),
    (
      3,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R \
       /Resources << /Font << /F1 5 0 R >> >> >>"
        .to_string(),
    ),
    (
      4,
      format!(
        "<< /Length {} >>\nstream\n{content}\nendstream",
        content.len() + 1
      ),
    ),
    (
      5,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ),
  ]);
  Pdf::new(Arc::new(bytes)).expect("fixture should parse")
}
