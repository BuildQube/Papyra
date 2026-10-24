//! The pixmap is allocated after interpretation, not before.
//!
//! hayro draws every soft mask into a context-sized pixmap of its own while it
//! interprets, so a pixmap held from the start of a render stacks on top of each one:
//! 9 bytes a pixel at peak under one mask, where `hayro::render` itself needs 5.
//! Its own binary, because the counting allocator is global to the process.
use papyra_core::{Document as _, Engine, RenderOptions};
use papyra_hayro::HayroEngine;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;
static NOW: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
  unsafe fn alloc(&self, l: Layout) -> *mut u8 {
    let n = NOW.fetch_add(l.size(), Relaxed) + l.size();
    PEAK.fetch_max(n, Relaxed);
    unsafe { System.alloc(l) }
  }
  unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
    let n = NOW.fetch_add(l.size(), Relaxed) + l.size();
    PEAK.fetch_max(n, Relaxed);
    unsafe { System.alloc_zeroed(l) }
  }
  unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
    NOW.fetch_sub(l.size(), Relaxed);
    unsafe { System.dealloc(p, l) }
  }
}
#[global_allocator]
static A: Counting = Counting;

fn pdf() -> Vec<u8> {
  let objs = [
    "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /ExtGState << /G1 << /SMask << /S /Luminosity /G 5 0 R >> >> >> >> >>".to_string(),
    { let c = "/G1 gs 0 0 1 rg 0 0 612 792 re f"; format!("<< /Length {} >>\nstream\n{c}\nendstream", c.len()) },
    { let c = "0.5 g 0 0 612 792 re f"; format!("<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Group << /S /Transparency /CS /DeviceGray >> /Length {} >>\nstream\n{c}\nendstream", c.len()) },
  ];
  let mut out = b"%PDF-1.7\n".to_vec();
  let mut offs = vec![];
  for (i, o) in objs.iter().enumerate() {
    offs.push(out.len());
    out.extend(format!("{} 0 obj\n{o}\nendobj\n", i + 1).bytes());
  }
  let x = out.len();
  out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objs.len() + 1).bytes());
  for o in offs {
    out.extend(format!("{o:010} 00000 n \n").bytes());
  }
  out.extend(
    format!(
      "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n",
      objs.len() + 1
    )
    .bytes(),
  );
  out
}

#[test]
fn a_soft_masked_render_peaks_where_hayro_render_does() {
  let doc = HayroEngine::load(pdf()).unwrap();
  let opts = RenderOptions {
    scale: 4.0,
    ..Default::default()
  };
  let base = NOW.load(Relaxed);
  PEAK.store(base, Relaxed);
  let bitmap = doc.render_page(0, &opts).unwrap();
  let per_pixel = (PEAK.load(Relaxed) - base) as f64 / f64::from(bitmap.width * bitmap.height);
  // The mask is drawn: a half-luminance mask over blue, on white.
  assert_eq!(&bitmap.data[..4], [127, 127, 255, 255]);
  assert!(per_pixel < 6.0, "{per_pixel:.2} bytes a pixel at peak");
}
