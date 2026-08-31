//! Renders one page in a loop so an external sampler can attribute the cost.
//!
//! usage: cargo run --release -p papyra-hayro --example hot_loop -- <file.pdf> [page] [secs]
//! then, in another shell: sample <pid> <secs> -file /tmp/papyra.sample

use papyra_core::{Document as _, Engine, RenderOptions};
use papyra_hayro::HayroEngine;
use std::time::{Duration, Instant};

fn main() {
  let path = std::env::args()
    .nth(1)
    .expect("usage: … <file.pdf> [page] [secs]");
  let page: usize = std::env::args()
    .nth(2)
    .and_then(|s| s.parse().ok())
    .unwrap_or(0);
  let secs: u64 = std::env::args()
    .nth(3)
    .and_then(|s| s.parse().ok())
    .unwrap_or(20);

  let doc = HayroEngine::load(std::fs::read(&path).expect("read")).expect("load");
  // Small output on purpose: rasterisation is flat in output size, so this isolates
  // the per-draw-call floor rather than per-pixel work.
  let opts = RenderOptions {
    scale: 0.2,
    white_background: true,
    ..Default::default()
  };

  println!(
    "pid {} — rendering page {page} for {secs}s",
    std::process::id()
  );
  let deadline = Instant::now() + Duration::from_secs(secs);
  let mut n = 0u64;
  while Instant::now() < deadline {
    let _ = doc.render_page(page, &opts).expect("render");
    n += 1;
  }
  println!("{n} renders");
}
