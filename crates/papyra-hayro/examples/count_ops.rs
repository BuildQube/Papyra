//! What is in a page, and where does the per-page floor come from?
//!
//! usage: cargo run --release -p papyra-hayro --example count_ops -- <file.pdf> [page]

use hayro_interpret::font::Glyph;
use hayro_interpret::hayro_syntax::Pdf;
use hayro_interpret::util::TransformExt;
use hayro_interpret::{
  BlendMode, ClipPath, Context, Device, GlyphDrawMode, Image, InterpreterCache,
  InterpreterSettings, Paint, PathDrawMode, SoftMask, interpret_page,
};
use kurbo::{Affine, BezPath, Rect};

#[derive(Default)]
struct Counter {
  paths: u64,
  path_segments: u64,
  glyphs: u64,
  images: u64,
  clips: u64,
  groups: u64,
  /// Groups with opacity 1.0, Normal blend and no soft mask — i.e. groups that make no
  /// difference to the output and could in principle be elided.
  trivial_groups: u64,
}

impl<'a> Device<'a> for Counter {
  fn set_soft_mask(&mut self, _: Option<SoftMask<'a>>) {}
  fn set_blend_mode(&mut self, _: BlendMode) {}
  fn draw_path(&mut self, path: &BezPath, _: Affine, _: &Paint<'a>, _: &PathDrawMode) {
    self.paths += 1;
    self.path_segments += path.elements().len() as u64;
  }
  fn push_clip_path(&mut self, _: &ClipPath) {
    self.clips += 1;
  }
  fn push_transparency_group(
    &mut self,
    opacity: f32,
    mask: Option<SoftMask<'a>>,
    blend: BlendMode,
  ) {
    self.groups += 1;
    if opacity >= 1.0 && mask.is_none() && matches!(blend, BlendMode::Normal) {
      self.trivial_groups += 1;
    }
  }
  fn draw_glyph(&mut self, _: &Glyph<'a>, _: Affine, _: Affine, _: &Paint<'a>, _: &GlyphDrawMode) {
    self.glyphs += 1;
  }
  fn draw_image(&mut self, _: Image<'a, '_>, _: Affine) {
    self.images += 1;
  }
  fn pop_clip_path(&mut self) {}
  fn pop_transparency_group(&mut self) {}
}

fn main() {
  let path = std::env::args().nth(1).expect("usage: … <file.pdf> [page]");
  let index: usize = std::env::args()
    .nth(2)
    .and_then(|s| s.parse().ok())
    .unwrap_or(0);
  let pdf = Pdf::new(std::fs::read(&path).expect("read")).expect("parse");
  let pages = pdf.pages();
  let page = pages.get(index).expect("page in range");
  let (w, h) = page.render_dimensions();

  let cache = InterpreterCache::new();
  let mut ctx = Context::new(
    page.initial_transform(true).to_kurbo(),
    Rect::new(0.0, 0.0, w as f64, h as f64),
    &cache,
    page.xref(),
    InterpreterSettings::default(),
  );
  let mut counter = Counter::default();
  interpret_page(page, &mut ctx, &mut counter);

  println!("page {index}: {:.1}x{:.1}in", w / 72.0, h / 72.0);
  println!("  paths          {:>9}", counter.paths);
  println!("  path segments  {:>9}", counter.path_segments);
  println!("  glyphs         {:>9}", counter.glyphs);
  println!("  images         {:>9}", counter.images);
  println!("  clip pushes    {:>9}", counter.clips);
  println!(
    "  groups         {:>9}  ({} trivial: opacity 1, Normal, no mask)",
    counter.groups, counter.trivial_groups
  );
  let ops = counter.paths + counter.glyphs + counter.images;
  println!(
    "\n  {ops} draw calls — at a ~93ms floor that is {:.1}us each",
    93_000.0 / ops as f64
  );
}
