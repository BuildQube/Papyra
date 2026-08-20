//! How much of a render is interpretation, and how much is rasterisation?
//!
//! This is the ceiling on what a recording/replay device could ever save: replay skips
//! interpretation and pays rasterisation. If interpretation dominates, recording is
//! worth building; if it does not, it is not.
//!
//! usage: cargo run --release -p papyra-hayro --example interpret_vs_raster -- <file.pdf>

use hayro_interpret::hayro_syntax::Pdf;
use hayro_interpret::util::TransformExt;
use hayro_interpret::{
  Context, DummyDevice, InterpreterCache, InterpreterSettings, interpret_page,
};
use kurbo::{Affine, Rect};
use papyra_core::{Document as _, Engine, RenderOptions};
use papyra_hayro::HayroEngine;
use std::time::Instant;

fn best<F: FnMut()>(rounds: usize, mut f: F) -> f64 {
  let mut best = f64::MAX;
  for _ in 0..rounds {
    let t = Instant::now();
    f();
    best = best.min(t.elapsed().as_secs_f64() * 1000.0);
  }
  best
}

fn main() {
  let path = std::env::args().nth(1).expect("usage: … <file.pdf>");
  let data = std::fs::read(&path).expect("read pdf");

  let doc = HayroEngine::load(data.clone()).expect("load");
  let pdf = Pdf::new(data).expect("parse");
  let pages = pdf.pages();
  let page = pages.first().expect("a page");
  let (w, h) = page.render_dimensions();
  println!(
    "{} — {:.0}x{:.0}pt ({:.1}x{:.1}in), {} pages\n",
    path,
    w,
    h,
    w / 72.0,
    h / 72.0,
    doc.page_count()
  );

  println!(
    "{:<10}{:>12}{:>12}{:>12}{:>10}",
    "fitWidth", "interpret", "full", "raster", "interp%"
  );
  println!("{}", "-".repeat(56));

  for target in [200u32, 800, 1600, 3200] {
    let scale = target as f32 / w;

    // Interpretation only: same work, every draw call discarded.
    let interpret = best(3, || {
      let cache = InterpreterCache::new();
      let initial = Affine::scale(scale as f64) * page.initial_transform(true).to_kurbo();
      let mut ctx = Context::new(
        initial,
        Rect::new(0.0, 0.0, (w * scale) as f64, (h * scale) as f64),
        &cache,
        page.xref(),
        InterpreterSettings::default(),
      );
      interpret_page(page, &mut ctx, &mut DummyDevice);
    });

    // Interpretation + rasterisation.
    let opts = RenderOptions {
      scale,
      white_background: true,
    };
    let full = best(3, || {
      doc.render_page(0, &opts).expect("render");
    });

    println!(
      "{:<10}{:>10.1}ms{:>10.1}ms{:>10.1}ms{:>9.0}%",
      target,
      interpret,
      full,
      full - interpret,
      100.0 * interpret / full
    );
  }
}
