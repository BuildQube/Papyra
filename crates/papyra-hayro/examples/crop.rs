//! Does restricting the viewport actually cost less?
//!
//! Rasterisation dominates and is nearly flat in output size, which suggests per-draw-call
//! overhead rather than per-pixel work. If hayro/vello_cpu cull work outside the viewport,
//! rendering a window of a page should cost proportionally less and tiling is worth
//! building. If it does not, the cost is unavoidable per page.
//!
//! usage: cargo run --release -p papyra-hayro --example crop -- <file.pdf>

use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::vello_cpu::{Pixmap, RasterizerSettings, RenderContext, Resources, TargetInit};
use hayro::{RenderCache, RenderSettings};
use hayro_interpret::InterpreterSettings;
use hayro_interpret::hayro_syntax::Pdf;
use hayro_interpret::util::TransformExt;
use kurbo::Affine;
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
  let pdf = Pdf::new(std::fs::read(&path).expect("read")).expect("parse");
  let pages = pdf.pages();
  let page = pages.first().expect("a page");
  let (w, h) = page.render_dimensions();
  println!("{:.0}x{:.0}pt ({:.1}x{:.1}in)\n", w, h, w / 72.0, h / 72.0);

  // Fix the scale so every row rasterises at the same zoom, and vary only how much of
  // the page the viewport covers.
  let scale = 1600.0 / w;
  let full_w = (w * scale) as u16;
  let full_h = (h * scale) as u16;

  println!(
    "{:<24}{:>10}{:>12}{:>12}",
    "viewport", "pixels", "ms", "ms/Mpx"
  );
  println!("{}", "-".repeat(58));

  for frac in [1.0f32, 0.5, 0.25, 0.1] {
    let vw = ((full_w as f32) * frac) as u16;
    let vh = ((full_h as f32) * frac) as u16;
    let ms = best(3, || {
      // What `hayro::render` does, into a context sized to the viewport.
      let cache = RenderCache::new();
      let mut ctx = RenderContext::new(vw, vh);
      hayro::render_into(
        page,
        &cache,
        &InterpreterSettings::default(),
        &RenderSettings::default(),
        &mut ctx,
        Affine::scale(scale as f64) * page.initial_transform(true).to_kurbo(),
      );
      ctx.flush();
      let mut pixmap = Pixmap::new(vw, vh);
      let settings = RasterizerSettings {
        target_init: TargetInit::Clear(WHITE),
        ..Default::default()
      };
      ctx.render_with(&mut pixmap, &mut Resources::default(), settings);
    });
    let mpx = (vw as f64 * vh as f64) / 1e6;
    println!(
      "{:<24}{:>10}{:>10.1}ms{:>10.1}",
      format!("{}x{} ({:.0}%)", vw, vh, frac * 100.0),
      format!("{:.2}MP", mpx),
      ms,
      ms / mpx
    );
  }
}
