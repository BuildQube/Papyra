//! Text extraction.
//!
//! hayro's interpreter reports every glyph it draws to a [`Device`], with the matrix
//! that places it and the Unicode it stands for. That is a better starting point than
//! walking the content stream by hand: encodings, `ToUnicode` cmaps, CID fonts, Type3
//! glyphs and the full graphics-state transform are all already resolved.
//!
//! What is left is the part hayro cannot do for us — deciding which glyphs form a
//! line, and where the spaces go. A PDF has no notion of either. Both are recovered
//! from geometry, below.

use hayro_interpret::font::Glyph;
use hayro_interpret::util::TransformExt;
use hayro_interpret::{
  BlendMode, ClipPath, Context, Device, GlyphDrawMode, Image, InterpreterCache,
  InterpreterSettings, Paint, PathDrawMode, SoftMask, interpret_page,
};
use hayro_syntax::page::Page;
use kurbo::{Affine, BezPath, Rect};
use papyra_core::{PageText, TextLine};

/// Glyphs whose baselines differ by more than this fraction of the em size start a new
/// line. Generous enough for subscripts, tight enough to separate 1.15-spaced body text.
const BASELINE_TOLERANCE: f32 = 0.35;

/// A gap wider than this fraction of the em size is a space.
///
/// PDF encodes spaces as position changes at least as often as it encodes them as
/// space glyphs — kerned and justified text has no space glyph at all — so a search
/// for two words only works if this is reconstructed.
///
/// The measurement this is compared against already has the glyph's own advance
/// subtracted, which makes the signal sharply bimodal: on `tracemonkey.pdf` every
/// within-word gap is 0.000 and every between-word gap is 0.196, with kerning
/// reaching -0.025. A nominal space is 0.25-0.33em, so the threshold sits low enough
/// to survive the compression justified text applies, and far enough above kerning to
/// never split a word.
const SPACE_GAP: f32 = 0.12;

/// A gap wider than this ends the line instead: two columns, or a table's cells.
///
/// Keeping them on one line would make "total cost" match a row that reads
/// "total | cost", which is a false positive a user cannot explain.
const LINE_BREAK_GAP: f32 = 2.5;

/// Baselines rotated relative to each other by more than ~5° are different lines.
const DIRECTION_TOLERANCE: f32 = 0.996;

/// Nominal share of the em box above the baseline; the rest sits below.
///
/// Real ascent and descent are per-font and would mean loading metrics for every font
/// on the page to move a highlight by a pixel or two.
const ASCENT_FRACTION: f32 = 0.75;

/// Extract the text of a page, in the space described on [`PageText`].
pub fn extract(page: &Page<'_>) -> PageText {
  let (width, height) = page.render_dimensions();
  let cache = InterpreterCache::new();
  // `initial_transform(true)` is what the renderer uses, so text lands in the same
  // space as the pixels — page rotation and a non-zero crop box included. Getting
  // this from anywhere else is how text ends up 90° out on a rotated drawing.
  let mut ctx = Context::new(
    page.initial_transform(true).to_kurbo(),
    Rect::new(0.0, 0.0, width as f64, height as f64),
    &cache,
    page.xref(),
    InterpreterSettings::default(),
  );

  let mut collector = TextCollector::default();
  interpret_page(page, &mut ctx, &mut collector);
  collector.finish()
}

/// One glyph, placed.
struct Placed {
  text: String,
  origin: (f32, f32),
  /// Unit vector along the baseline.
  dir: (f32, f32),
  /// Height of the em box in page space — the glyph's effective font size.
  size: f32,
  /// The font's own advance for this glyph, used only for the last glyph of a line
  /// where there is no following origin to measure against.
  nominal_advance: f32,
  /// Innermost enclosing marked-content id, or `None` outside any tagged sequence.
  mcid: Option<i32>,
}

#[derive(Default)]
struct TextCollector {
  glyphs: Vec<Placed>,
  /// Glyphs drawn that no encoding could map to Unicode. Counted rather than ignored:
  /// a page of them is unsearchable text, which is a different answer to a user than
  /// a page with no text.
  undecoded: u32,
  /// Open marked-content sequences, innermost last.
  ///
  /// A stack rather than a single value because `BDC` nests, and the entries are
  /// `Option` because a nested sequence need not carry an `/MCID` of its own — an
  /// `/Artifact` or a bare `BMC` opens a level that must still be popped by its `EMC`.
  /// Keeping the whole frame is what makes the pop unambiguous.
  marked_content: Vec<Option<i32>>,
}

impl<'a> Device<'a> for TextCollector {
  fn draw_glyph(
    &mut self,
    glyph: &Glyph<'a>,
    transform: Affine,
    glyph_transform: Affine,
    _paint: &Paint<'a>,
    _draw_mode: &GlyphDrawMode,
  ) {
    // `GlyphDrawMode::Invisible` is deliberately not filtered: an OCR layer over a
    // scanned page is invisible text, and it is the only text such a page has.
    let Some(text) = unicode_of(glyph).filter(|t| !t.is_empty()) else {
      self.undecoded += 1;
      return;
    };

    // The renderer draws a glyph as `transform * glyph_transform * outline`, and
    // outlines are in a 1000-unit em, so this matrix maps font units to page space.
    let m = (transform * glyph_transform).as_coeffs();
    let origin = (m[4] as f32, m[5] as f32);
    // Images of the font-space axes. The x axis runs along the baseline; the length
    // of the y axis over one em is the font size on the page.
    let (ax, ay) = (m[0] as f32, m[1] as f32);
    let (bx, by) = (m[2] as f32, m[3] as f32);

    let along = (ax * ax + ay * ay).sqrt();
    let size = (bx * bx + by * by).sqrt() * UNITS_PER_EM;
    // A degenerate matrix — a zero-size or fully collapsed glyph — has no position to
    // report and no extent to highlight.
    if along == 0.0 || !size.is_finite() || size <= 0.0 {
      return;
    }

    self.glyphs.push(Placed {
      text,
      origin,
      dir: (ax / along, ay / along),
      size,
      nominal_advance: nominal_advance(glyph) * along * UNITS_PER_EM,
      // Innermost first: a `/Span` inside a `/P` tags its glyphs with the span, which
      // is the more specific and therefore more useful element of the two.
      mcid: self.marked_content.iter().rev().find_map(|frame| *frame),
    });
  }

  fn begin_marked_content(&mut self, _tag: &[u8], mcid: Option<i32>) {
    // Bounded so a stream of unmatched `BDC`s cannot grow this without limit; the
    // depth is far past anything a real document nests.
    if self.marked_content.len() < MAX_MARKED_CONTENT_DEPTH {
      self.marked_content.push(mcid);
    }
  }

  fn end_marked_content(&mut self) {
    self.marked_content.pop();
  }

  // Text extraction ignores everything else the page draws.
  fn set_soft_mask(&mut self, _: Option<SoftMask<'a>>) {}
  fn set_blend_mode(&mut self, _: BlendMode) {}
  fn draw_path(&mut self, _: &BezPath, _: Affine, _: &Paint<'a>, _: &PathDrawMode) {}
  fn push_clip_path(&mut self, _: &ClipPath) {}
  fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
  fn draw_image(&mut self, _: Image<'a, '_>, _: Affine) {}
  fn pop_clip_path(&mut self) {}
  fn pop_transparency_group(&mut self) {}
}

/// Glyph outlines use a 1000-unit em, matching PDF's text-space units.
const UNITS_PER_EM: f32 = 1000.0;

/// Ceiling on nested marked-content sequences. A content stream is untrusted input and
/// its `BDC`/`EMC` need not balance, so the stack needs a bound that is not the file's.
const MAX_MARKED_CONTENT_DEPTH: usize = 256;

fn unicode_of(glyph: &Glyph<'_>) -> Option<String> {
  use hayro_interpret::hayro_cmap::BfString;
  match glyph.as_unicode()? {
    BfString::Char(c) => Some(c.to_string()),
    // A ligature glyph decodes to several characters, which is exactly what a search
    // for "fi" needs.
    BfString::String(s) => Some(s),
  }
}

fn nominal_advance(glyph: &Glyph<'_>) -> f32 {
  match glyph {
    Glyph::Outline(o) => o.advance_width().unwrap_or(0.0) / UNITS_PER_EM,
    // Type3 advances live in the glyph's own font matrix; approximating with half an
    // em only affects the width of a highlight on the last glyph of a line.
    Glyph::Type3(_) => 0.5,
  }
}

impl TextCollector {
  /// Group glyphs into lines.
  ///
  /// Emission order does the heavy lifting: the interpreter advances the text matrix
  /// between glyphs, so consecutive calls already arrive in reading order within a
  /// show-string, and the distance between two origins *is* the advance — kerning,
  /// `Tc`, `Tw` and all. Geometry is only consulted to decide where one line ends.
  fn finish(self) -> PageText {
    let mut lines: Vec<TextLine> = Vec::new();
    let mut current: Option<Builder> = None;

    for glyph in self.glyphs.into_iter() {
      match current.as_mut() {
        Some(builder) if builder.accepts(&glyph) => builder.push(glyph),
        Some(_) => {
          if let Some(done) = current.take().and_then(Builder::finish) {
            lines.push(done);
          }
          current = Some(Builder::new(glyph));
        }
        None => current = Some(Builder::new(glyph)),
      }
    }
    if let Some(done) = current.and_then(Builder::finish) {
      lines.push(done);
    }

    PageText {
      lines,
      undecoded_glyphs: self.undecoded,
    }
  }
}

struct Builder {
  text: String,
  offsets: Vec<f32>,
  origin: (f32, f32),
  dir: (f32, f32),
  size: f32,
  /// Distance along the baseline to the pen, i.e. where the next glyph would start.
  pen: f32,
  /// The glyph waiting to be committed. Held back because its width is the distance
  /// to the *next* glyph's origin, which has not arrived yet.
  pending: Placed,
  /// Marked-content id of the line's first glyph. See [`TextLine::mcid`] for why the
  /// first rather than all of them.
  mcid: Option<i32>,
}

impl Builder {
  fn new(glyph: Placed) -> Self {
    Self {
      text: String::new(),
      offsets: Vec::new(),
      origin: glyph.origin,
      dir: glyph.dir,
      size: glyph.size,
      pen: 0.0,
      mcid: glyph.mcid,
      pending: glyph,
    }
  }

  /// Where a point sits relative to the line: distance along the baseline, and
  /// distance perpendicular to it.
  fn project(&self, point: (f32, f32)) -> (f32, f32) {
    let (ox, oy) = self.origin;
    let (vx, vy) = (point.0 - ox, point.1 - oy);
    (
      vx * self.dir.0 + vy * self.dir.1,
      vx * self.dir.1 - vy * self.dir.0,
    )
  }

  fn accepts(&self, glyph: &Placed) -> bool {
    // Rotated relative to the line: a drawing's vertical dimension label next to its
    // horizontal one.
    if self.dir.0 * glyph.dir.0 + self.dir.1 * glyph.dir.1 < DIRECTION_TOLERANCE {
      return false;
    }

    let scale = self.size.max(glyph.size);
    let (along, across) = self.project(glyph.origin);
    if across.abs() > BASELINE_TOLERANCE * scale {
      return false;
    }

    let gap = along - self.pen;
    // Backwards far enough to be a new line rather than kerning or an accent drawn
    // over the character before it.
    gap > -0.5 * scale && gap < LINE_BREAK_GAP * scale
  }

  fn push(&mut self, glyph: Placed) {
    let (along, _) = self.project(glyph.origin);
    // The gap is measured from where the held-back glyph *ends*, not where it starts:
    // the distance between two origins is one glyph's own width plus whatever the
    // document added, and only the second part is a space.
    let (end, gap) = self.pending_extent(along);
    self.commit(end);

    // A gap is a space the document never wrote down. Justified and kerned text
    // routinely positions words rather than emitting a space glyph, so a search for
    // two words only works if this is put back.
    if gap > SPACE_GAP * self.size.max(glyph.size)
      && !self.text.ends_with(' ')
      && !glyph.text.starts_with(' ')
    {
      self.text.push(' ');
      self.offsets.push(end);
    }

    self.size = self.size.max(glyph.size);
    self.pen = along;
    self.pending = glyph;
  }

  /// Where the held-back glyph ends, and how much empty space follows it.
  ///
  /// A font that declares no width for the glyph leaves nothing to subtract, so the
  /// whole advance would read as a gap and every character would be followed by a
  /// space. Measuring instead — no width, no gap — costs word breaks in a document
  /// that is already missing its metrics, rather than breaking every document.
  fn pending_extent(&self, next: f32) -> (f32, f32) {
    let nominal = self.pending.nominal_advance;
    if nominal <= 0.0 {
      return (next, 0.0);
    }
    let end = (self.pen + nominal).min(next);
    (end, next - end)
  }

  /// Write the held-back glyph out, now that its width is known.
  fn commit(&mut self, end: f32) {
    let start = self.pen;
    let count = self.pending.text.chars().count();
    if count == 0 {
      return;
    }
    // A ligature is one advance shared by several characters; splitting it evenly is
    // enough to put a highlight in the right place.
    let step = (end - start) / count as f32;
    for (i, c) in self.pending.text.chars().enumerate() {
      self.text.push(c);
      self.offsets.push(start + step * i as f32);
    }
  }

  fn finish(mut self) -> Option<TextLine> {
    // Nothing follows the last glyph, so its own font metrics have to supply the
    // width. A glyph with no declared width gets a nominal half em.
    let width = match self.pending.nominal_advance {
      w if w > 0.0 => w,
      _ => self.size * 0.5,
    };
    let end = self.pen + width;
    self.commit(end);
    self.offsets.push(end);

    if self.text.trim().is_empty() {
      return None;
    }

    Some(TextLine {
      text: self.text,
      offsets: self.offsets,
      x: self.origin.0,
      y: self.origin.1,
      dx: self.dir.0,
      dy: self.dir.1,
      ascent: self.size * ASCENT_FRACTION,
      descent: self.size * (1.0 - ASCENT_FRACTION),
      mcid: self.mcid,
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::fixtures::page_with_content;

  fn extract_content(content: &str) -> PageText {
    let pdf = page_with_content(content);
    let pages = pdf.pages();
    extract(pages.first().expect("a page"))
  }

  /// `(text, mcid)` for each line — the shape the tagging tests care about.
  fn tagged(content: &str) -> Vec<(String, Option<i32>)> {
    extract_content(content)
      .lines
      .into_iter()
      .map(|line| (line.text, line.mcid))
      .collect()
  }

  // ---- marked content ----

  #[test]
  fn untagged_text_has_no_mcid() {
    assert_eq!(
      tagged("BT /F1 12 Tf 72 720 Td (Hello) Tj ET"),
      [("Hello".to_string(), None)]
    );
  }

  #[test]
  fn text_carries_the_enclosing_mcid() {
    assert_eq!(
      tagged(
        "/P << /MCID 0 >> BDC BT /F1 12 Tf 72 720 Td (First) Tj ET EMC \
         /P << /MCID 1 >> BDC BT /F1 12 Tf 72 700 Td (Second) Tj ET EMC"
      ),
      [
        ("First".to_string(), Some(0)),
        ("Second".to_string(), Some(1)),
      ]
    );
  }

  #[test]
  fn the_innermost_mcid_wins() {
    // A `/Span` inside a `/P` is the more specific element, and the more useful one.
    assert_eq!(
      tagged(
        "/P << /MCID 0 >> BDC /Span << /MCID 1 >> BDC \
         BT /F1 12 Tf 72 720 Td (Nested) Tj ET EMC EMC"
      ),
      [("Nested".to_string(), Some(1))]
    );
  }

  #[test]
  fn a_sequence_without_an_mcid_does_not_hide_the_one_outside_it() {
    // `BMC` opens a level carrying no id of its own. The `/P` around it still applies,
    // which is what makes the stack `Option`-valued rather than skipped.
    assert_eq!(
      tagged(
        "/P << /MCID 7 >> BDC /Artifact BMC \
         BT /F1 12 Tf 72 720 Td (Inside) Tj ET EMC EMC"
      ),
      [("Inside".to_string(), Some(7))]
    );
  }

  #[test]
  fn text_after_a_closed_sequence_is_untagged_again() {
    assert_eq!(
      tagged(
        "/P << /MCID 0 >> BDC BT /F1 12 Tf 72 720 Td (Tagged) Tj ET EMC \
         BT /F1 12 Tf 72 700 Td (Loose) Tj ET"
      ),
      [("Tagged".to_string(), Some(0)), ("Loose".to_string(), None),]
    );
  }

  #[test]
  fn unbalanced_end_marked_content_does_not_underflow() {
    // `EMC` with nothing open is malformed and does occur. Popping an empty stack must
    // not panic, and the text after it is simply untagged.
    assert_eq!(
      tagged("EMC EMC BT /F1 12 Tf 72 720 Td (After) Tj ET"),
      [("After".to_string(), None)]
    );
  }

  fn texts(content: &str) -> Vec<String> {
    extract_content(content)
      .lines
      .into_iter()
      .map(|l| l.text)
      .collect()
  }

  // ---- what comes out ----

  #[test]
  fn reads_a_show_string() {
    assert_eq!(
      texts("BT /F1 12 Tf 100 700 Td (Hello World) Tj ET"),
      vec!["Hello World"]
    );
  }

  #[test]
  fn separates_lines_set_at_different_baselines() {
    assert_eq!(
      texts("BT /F1 12 Tf 100 700 Td (first) Tj 0 -20 Td (second) Tj ET"),
      vec!["first", "second"]
    );
  }

  #[test]
  fn keeps_a_line_together_across_show_strings() {
    // One line split into several `Tj` is how kerned text is written; splitting it
    // here would stop "Hello World" from ever matching.
    assert_eq!(
      texts("BT /F1 12 Tf 100 700 Td (Hello ) Tj (World) Tj ET"),
      vec!["Hello World"]
    );
  }

  #[test]
  fn recovers_a_space_written_as_a_position_change() {
    // Justified text positions words rather than emitting a space glyph. -280/1000 of
    // an em at 12pt is a 3.4pt gap, comfortably a word space.
    assert_eq!(
      texts("BT /F1 12 Tf 100 700 Td [(Hello) -280 (World)] TJ ET"),
      vec!["Hello World"]
    );
  }

  #[test]
  fn does_not_read_kerning_as_a_space() {
    // -40/1000 em is a tight pair, not a word break.
    assert_eq!(
      texts("BT /F1 12 Tf 100 700 Td [(A) -40 (V)] TJ ET"),
      vec!["AV"]
    );
  }

  #[test]
  fn a_wide_gap_starts_a_new_line_rather_than_one_long_one() {
    // Two columns, or a table's cells. Joining them would make "left right" match a
    // row that reads "left | right", which is a hit the user cannot explain.
    assert_eq!(
      texts("BT /F1 12 Tf 60 700 Td (left) Tj 400 0 Td (right) Tj ET"),
      vec!["left", "right"]
    );
  }

  #[test]
  fn ignores_a_line_that_is_only_whitespace() {
    assert_eq!(
      texts("BT /F1 12 Tf 100 700 Td (   ) Tj ET"),
      Vec::<String>::new()
    );
  }

  #[test]
  fn a_page_that_draws_no_text_yields_nothing() {
    let text = extract_content("0 0 1 rg 10 10 100 100 re f");
    assert!(text.lines.is_empty());
    assert_eq!(text.undecoded_glyphs, 0, "no glyphs were drawn at all");
  }

  // ---- where it comes out ----

  #[test]
  fn coordinates_are_the_page_as_rendered_with_y_down() {
    // `Td 100 700` is 700pt up from the bottom of a 792pt page, so 92pt down from the
    // top. Getting this wrong puts every highlight in the wrong half of the page.
    let line = extract_content("BT /F1 12 Tf 100 700 Td (Hello) Tj ET")
      .lines
      .remove(0);
    assert!((line.x - 100.0).abs() < 0.01, "x was {}", line.x);
    assert!((line.y - 92.0).abs() < 0.01, "y was {}", line.y);
  }

  #[test]
  fn horizontal_text_runs_along_positive_x() {
    let line = extract_content("BT /F1 12 Tf 100 700 Td (Hello) Tj ET")
      .lines
      .remove(0);
    assert!((line.dx - 1.0).abs() < 0.001);
    assert!(line.dy.abs() < 0.001);
  }

  #[test]
  fn the_em_box_matches_the_font_size() {
    let line = extract_content("BT /F1 12 Tf 100 700 Td (Hello) Tj ET")
      .lines
      .remove(0);
    assert!(
      ((line.ascent + line.descent) - 12.0).abs() < 0.01,
      "got {}",
      line.ascent + line.descent
    );
  }

  #[test]
  fn offsets_bound_every_character_and_only_move_forward() {
    let line = extract_content("BT /F1 12 Tf 100 700 Td (Hello World) Tj ET")
      .lines
      .remove(0);
    assert_eq!(
      line.offsets.len(),
      line.text.chars().count() + 1,
      "one offset per character, plus the end of the last"
    );
    assert_eq!(
      line.offsets[0], 0.0,
      "the first character starts at the origin"
    );
    for pair in line.offsets.windows(2) {
      assert!(pair[1] >= pair[0], "offsets went backwards: {pair:?}");
    }
    // 11 characters of 12pt Helvetica is on the order of 60pt.
    let width = line.offsets[line.offsets.len() - 1];
    assert!((30.0..120.0).contains(&width), "line was {width}pt wide");
  }

  #[test]
  fn rotated_text_reports_its_own_direction() {
    // `Tm` here is a 90° rotation. A drawing's vertical dimension labels are set this
    // way, and a highlight drawn as if they were horizontal lands nowhere near them.
    let line = extract_content("BT /F1 12 Tf 0 1 -1 0 300 400 Tm (Up) Tj ET")
      .lines
      .remove(0);
    assert_eq!(line.text, "Up");
    assert!(line.dx.abs() < 0.001, "dx was {}", line.dx);
    assert!((line.dy + 1.0).abs() < 0.001, "dy was {}", line.dy);
  }

  #[test]
  fn text_at_a_different_angle_is_a_different_line() {
    assert_eq!(
      texts(
        "BT /F1 12 Tf 100 700 Td (across) Tj ET \
         BT /F1 12 Tf 0 1 -1 0 300 400 Tm (down) Tj ET"
      ),
      vec!["across", "down"]
    );
  }

  #[test]
  fn a_rotated_page_puts_text_where_it_is_drawn() {
    // `/Rotate 90` swaps the rendered dimensions, and the initial transform has to
    // move the text with the pixels or the two disagree by a quarter turn.
    use crate::fixtures::build_pdf;
    use hayro_syntax::Pdf;
    use std::sync::Arc;

    let content = "BT /F1 12 Tf 100 700 Td (Hello) Tj ET";
    let bytes = build_pdf(&[
      (1, "<< /Type /Catalog /Pages 2 0 R >>".to_string()),
      (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string()),
      (
        3,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Contents 4 0 R \
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
    let pdf = Pdf::new(Arc::new(bytes)).expect("fixture should parse");
    let pages = pdf.pages();
    let page = pages.first().expect("a page");
    let (width, height) = page.render_dimensions();
    assert_eq!((width, height), (792.0, 612.0), "rotation swaps the page");

    let line = extract(page).lines.remove(0);
    assert_eq!(line.text, "Hello");
    assert!(
      (0.0..=width).contains(&line.x) && (0.0..=height).contains(&line.y),
      "text landed outside the rotated page at {},{}",
      line.x,
      line.y
    );
    // Rotating the page turns horizontal text into vertical text on screen.
    assert!(line.dx.abs() < 0.001 && (line.dy - 1.0).abs() < 0.001);
  }
}
