//! What does a tiled page cost against one bitmap of it?
//!
//! A tile is `render_into` a context of the tile's size, with the page transform
//! translated so the tile's corner lands at the origin. Without culling every tile pays
//! the whole page's interpretation and draw calls, so N tiles should cost ~N renders.
//! `record+cut` is the ceiling of "interpret once, rasterise many": one context the size
//! of the page records every draw, then only a tile-sized pixmap is rasterised from it.
//! vello_cpu's `RasterizerSettings::offset` is unsigned, so only the top-left tile can be
//! cut out today; the row is there to price the upstream change, not to ship.
//!
//! usage: cargo run --release -p papyra-hayro --example tiles -- <file.pdf> [page]
//!   or   … -- <file.pdf> <page> full|tiles|tile|record|hash <scale> [n|px]   (one shot, for
//!        `/usr/bin/time -l` to read peak memory from)

use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::vello_cpu::{Pixmap, RasterizerSettings, RenderContext, Resources, TargetInit};
use hayro::{RenderCache, RenderSettings};
use hayro_interpret::hayro_syntax::Pdf;
use hayro_interpret::hayro_syntax::page::Page;
use hayro_interpret::util::TransformExt;
use hayro_interpret::{
  Context, DummyDevice, InterpreterCache, InterpreterSettings, interpret_page,
};
use kurbo::{Affine, Rect};
use rayon::prelude::*;
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

/// Render the `w`x`h` window at (`x`, `y`) of the page at `scale`.
fn tile<'a>(
  page: &'a Page<'a>,
  cache: &RenderCache<'a>,
  scale: f64,
  (x, y, w, h): (f64, f64, u16, u16),
) -> Pixmap {
  let mut ctx = RenderContext::new(w, h);
  let transform =
    Affine::translate((-x, -y)) * Affine::scale(scale) * page.initial_transform(true).to_kurbo();
  hayro::render_into(
    page,
    cache,
    &InterpreterSettings::default(),
    &RenderSettings::default(),
    &mut ctx,
    transform,
  );
  ctx.flush();
  let mut pixmap = Pixmap::new(w, h);
  ctx.render_with(&mut pixmap, &mut Resources::default(), white());
  pixmap
}

fn white() -> RasterizerSettings {
  RasterizerSettings {
    target_init: TargetInit::Clear(WHITE),
    ..Default::default()
  }
}

fn size(page: &Page, scale: f64) -> (u16, u16) {
  let (w, h) = page.render_dimensions();
  ((w as f64 * scale) as u16, (h as f64 * scale) as u16)
}

/// The n x n grid of tiles covering the page, rendered in sequence.
fn grid<'a>(page: &'a Page<'a>, cache: &RenderCache<'a>, scale: f64, n: u16) -> f64 {
  let (w, h) = size(page, scale);
  let (tw, th) = (w.div_ceil(n), h.div_ceil(n));
  let mut slowest = 0f64;
  for row in 0..n {
    for col in 0..n {
      let t = Instant::now();
      let (x, y) = (col * tw, row * th);
      tile(
        page,
        cache,
        scale,
        (x as f64, y as f64, tw.min(w - x), th.min(h - y)),
      );
      slowest = slowest.max(t.elapsed().as_secs_f64() * 1000.0);
    }
  }
  slowest
}

/// The 1024px tiles a 1920x1080 viewport at the page centre touches.
fn viewport_tiles(page: &Page, scale: f64) -> Vec<(f64, f64)> {
  let (w, h) = size(page, scale);
  let (vx, vy) = (w as f64 / 2.0 - 960.0, h as f64 / 2.0 - 540.0);
  let snap = |v: f64| (v / 1024.0).floor() * 1024.0;
  let mut tiles = Vec::new();
  let mut y = snap(vy);
  while y < vy + 1080.0 {
    let mut x = snap(vx);
    while x < vx + 1920.0 {
      tiles.push((x, y));
      x += 1024.0;
    }
    y += 1024.0;
  }
  tiles
}

fn interpret(page: &Page, scale: f64, (w, h): (u16, u16)) {
  let cache = InterpreterCache::new();
  let mut ctx = Context::new(
    Affine::scale(scale) * page.initial_transform(true).to_kurbo(),
    Rect::new(0.0, 0.0, w as f64, h as f64),
    &cache,
    page.xref(),
    InterpreterSettings::default(),
  );
  interpret_page(page, &mut ctx, &mut DummyDevice);
}

/// Record the whole page once, then rasterise only a `px`-square top-left cut-out.
fn record_and_cut(page: &Page, scale: f64, px: u16) -> (f64, f64) {
  let (w, h) = size(page, scale);
  let cache = RenderCache::new();
  let t = Instant::now();
  let mut ctx = RenderContext::new(w, h);
  hayro::render_into(
    page,
    &cache,
    &InterpreterSettings::default(),
    &RenderSettings::default(),
    &mut ctx,
    Affine::scale(scale) * page.initial_transform(true).to_kurbo(),
  );
  ctx.flush();
  let record = t.elapsed().as_secs_f64() * 1000.0;
  let raster = best(3, || {
    let mut pixmap = Pixmap::new(px, px);
    ctx.render_with(&mut pixmap, &mut Resources::default(), white());
  });
  (record, raster)
}

fn main() {
  let args: Vec<String> = std::env::args().collect();
  let path = args.get(1).expect("usage: … <file.pdf> [page]");
  let index: usize = args.get(2).map_or(0, |s| s.parse().expect("page"));
  let pdf = Pdf::new(std::fs::read(path).expect("read")).expect("parse");
  let pages = pdf.pages();
  let page = pages.get(index).expect("no such page");
  let (pw, ph) = page.render_dimensions();
  let cache = RenderCache::new();

  if let Some(mode) = args.get(3) {
    let scale: f64 = args[4].parse().expect("scale");
    let (w, h) = size(page, scale);
    let arg: u16 = args.get(5).map_or(1, |s| s.parse().expect("n|px"));
    let ms = best(1, || match mode.as_str() {
      "full" => drop(tile(page, &cache, scale, (0.0, 0.0, w, h))),
      "tiles" => drop(grid(page, &cache, scale, arg)),
      "tile" => drop(tile(
        page,
        &cache,
        scale,
        (w as f64 / 2.0, h as f64 / 2.0, arg, arg),
      )),
      "record" => drop(record_and_cut(page, scale, arg)),
      // Every tile of an n x n grid, hashed — for checking a patched hayro draws the
      // same pixels as the stock one.
      "hash" => {
        let (tw, th) = (w.div_ceil(arg), h.div_ceil(arg));
        let mut hasher = std::hash::DefaultHasher::new();
        for i in 0..arg * arg {
          let (x, y) = ((i % arg) * tw, (i / arg) * th);
          let window = (x as f64, y as f64, tw.min(w - x), th.min(h - y));
          std::hash::Hash::hash(
            &tile(page, &cache, scale, window).data_as_u8_slice(),
            &mut hasher,
          );
        }
        println!("{:016x}", std::hash::Hasher::finish(&hasher));
      }
      _ => panic!("mode is full|tiles|tile|record|hash"),
    });
    println!("{mode} scale {scale} ({w}x{h}) arg {arg}: {ms:.1}ms");
    return;
  }

  println!("page {index}: {:.1}x{:.1}in\n", pw / 72.0, ph / 72.0);
  // fitWidth 1600 is Addendum 10's scale; 4.0 is 400%, 288 DPI, which on ARCH-E is
  // 12096x8640 = 104.5 MP — just past papyra's 100 MP cap.
  for (label, scale) in [("fitWidth 1600", 1600.0 / pw as f64), ("400%", 4.0)] {
    let (w, h) = size(page, scale);
    println!("{label}: {w}x{h} ({:.1} MP)", w as f64 * h as f64 / 1e6);
    let interp = best(3, || interpret(page, scale, (w, h)));
    println!("  interpret only           {interp:>8.1}ms");
    let full = best(3, || drop(tile(page, &cache, scale, (0.0, 0.0, w, h))));
    println!("  full                     {full:>8.1}ms");
    for n in [1u16, 2, 4] {
      let mut slowest = 0.0;
      let total = best(3, || slowest = grid(page, &cache, scale, n));
      println!(
        "  {:>2} tiles                {total:>8.1}ms  ({:.2}x full, slowest tile {slowest:.1}ms)",
        n * n,
        total / full
      );
    }
    for px in [256u16, 512, 1024] {
      let one = best(3, || {
        drop(tile(
          page,
          &cache,
          scale,
          (w as f64 / 2.0, h as f64 / 2.0, px, px),
        ))
      });
      println!("  one {px}px tile (centre)  {one:>8.1}ms");
    }
    let viewport = viewport_tiles(page, scale);
    for threads in [1, 4] {
      let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build()
        .expect("pool");
      let ms = best(3, || {
        pool.install(|| {
          viewport
            .par_iter()
            .for_each_init(RenderCache::new, |cache, &(x, y)| {
              drop(tile(page, cache, scale, (x, y, 1024, 1024)))
            })
        })
      });
      println!(
        "  viewport, {} tiles, {threads} thread(s) {ms:>8.1}ms",
        viewport.len()
      );
    }
    let (record, raster) = record_and_cut(page, scale, 512);
    println!("  record+cut 512px         {record:>8.1}ms record, {raster:.1}ms per cut\n");
  }
}
