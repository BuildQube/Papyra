//! Print the extracted text of a page, one line per line.
//!
//! Usage: cargo run -p papyra-hayro --example dump_text -- <file.pdf> [page]

use hayro_interpret::hayro_syntax::Pdf;
use papyra_hayro::extract_text;

fn main() {
  let path = std::env::args().nth(1).expect("usage: … <file.pdf> [page]");
  let index: usize = std::env::args()
    .nth(2)
    .and_then(|s| s.parse().ok())
    .unwrap_or(0);

  let pdf = Pdf::new(std::fs::read(&path).expect("read pdf")).expect("parse");
  let pages = pdf.pages();
  let page = pages.get(index).expect("page in range");
  let (w, h) = page.render_dimensions();

  let text = extract_text(page);
  println!(
    "{path} page {index} — {w:.0}x{h:.0}pt, {} lines, {} undecoded glyphs\n",
    text.lines.len(),
    text.undecoded_glyphs
  );

  for line in &text.lines {
    let rotated = if line.dx < 0.999 { " [rotated]" } else { "" };
    println!(
      "{:7.1},{:7.1}  {:5.1}pt{}  {}",
      line.x,
      line.y,
      line.ascent + line.descent,
      rotated,
      line.text
    );
  }
}
