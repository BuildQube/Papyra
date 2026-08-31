//! Correlate per-page render cost with what the page actually contains.
//!
//! usage: cargo run --release -p papyra-hayro --example per_page -- <file.pdf> [n]

use hayro_interpret::font::Glyph;
use hayro_interpret::hayro_syntax::Pdf;
use hayro_interpret::util::TransformExt;
use hayro_interpret::{
  BlendMode, ClipPath, Context, Device, GlyphDrawMode, Image, InterpreterCache,
  InterpreterSettings, Paint, PathDrawMode, SoftMask, interpret_page,
};
use kurbo::{Affine, BezPath, Rect};
use papyra_core::{Document as _, Engine, RenderOptions};
use papyra_hayro::HayroEngine;
use std::time::Instant;

#[derive(Default)]
struct Counter {
  draws: u64,
  images: u64,
  groups: u64,
}

impl<'a> Device<'a> for Counter {
  fn set_soft_mask(&mut self, _: Option<SoftMask<'a>>) {}
  fn set_blend_mode(&mut self, _: BlendMode) {}
  fn draw_path(&mut self, _: &BezPath, _: Affine, _: &Paint<'a>, _: &PathDrawMode) {
    self.draws += 1;
  }
  fn push_clip_path(&mut self, _: &ClipPath) {}
  fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {
    self.groups += 1;
  }
  fn draw_glyph(&mut self, _: &Glyph<'a>, _: Affine, _: Affine, _: &Paint<'a>, _: &GlyphDrawMode) {
    self.draws += 1;
  }
  fn draw_image(&mut self, _: Image<'a, '_>, _: Affine) {
    self.images += 1;
    self.draws += 1;
  }
  fn pop_clip_path(&mut self) {}
  fn pop_transparency_group(&mut self) {}
}

fn main() {
  let path = std::env::args().nth(1).expect("usage: … <file.pdf> [n]");
  let n: usize = std::env::args()
    .nth(2)
    .and_then(|s| s.parse().ok())
    .unwrap_or(6);
  let data = std::fs::read(&path).expect("read");
  let doc = HayroEngine::load(data.clone()).expect("load");
  let pdf = Pdf::new(data).expect("parse");
  let pages = pdf.pages();
  let opts = RenderOptions {
    scale: 0.2,
    white_background: true,
    ..Default::default()
  };

  println!(
    "{:<6}{:>10}{:>10}{:>12}{:>12}",
    "page", "images", "groups", "ms @0.2x", "us/group"
  );
  println!("{}", "-".repeat(52));

  for i in 0..n.min(pages.len()) {
    let page = &pages[i];
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

    let mut best = f64::MAX;
    for _ in 0..3 {
      let t = Instant::now();
      let _ = doc.render_page(i, &opts).expect("render");
      best = best.min(t.elapsed().as_secs_f64() * 1000.0);
    }

    println!(
      "{:<6}{:>10}{:>10}{:>10.1}ms{:>11.2}",
      i,
      counter.images,
      counter.groups,
      best,
      if counter.groups > 0 {
        best * 1000.0 / counter.groups as f64
      } else {
        0.0
      }
    );
  }
}
