//! Every fixture from `tests/fixtures/generate.py` is the same 70x50 picture: a dark
//! square over x 16..48, y 12..36 on a light ground, plus a green 8x8 marker at the
//! top-left of the colour ones.

use papyra_tiff::{Bitmap, Compression, RenderOptions, Tiff, TiffError, is_tiff};

fn open(name: &str) -> Tiff {
  let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
  Tiff::load(std::fs::read(&path).unwrap()).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn render(name: &str) -> Bitmap {
  open(name)
    .render(0, &RenderOptions::default())
    .unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn px(b: &Bitmap, x: u32, y: u32) -> [u8; 4] {
  let i = (y * b.stride + x * 4) as usize;
  b.data[i..i + 4].try_into().unwrap()
}

fn luma(p: [u8; 4]) -> u32 {
  (u32::from(p[0]) + u32::from(p[1]) + u32::from(p[2])) / 3
}

fn near(a: [u8; 4], b: [u8; 4]) -> bool {
  a.iter()
    .zip(b)
    .map(|(&x, y)| x.abs_diff(y) as u32)
    .sum::<u32>()
    < 60
}

/// The square differs from the ground, and its edges are where they should be.
fn assert_square(name: &str, b: &Bitmap) {
  assert_eq!((b.width, b.height), (70, 50), "{name}");
  let (square, ground) = (px(b, 32, 24), px(b, 64, 44));
  assert!(!near(square, ground), "{name}: no square");
  // Exact edges on the lossless ones: the square is x 16..=47, y 12..=35.
  if name != "jpeg.tif" && name != "jpeg-ycbcr.tif" {
    for (x, y) in [(16, 12), (47, 35)] {
      assert_eq!(px(b, x, y), square, "{name} ({x}, {y})");
    }
    for (x, y) in [(15, 24), (48, 24), (32, 11), (32, 36)] {
      assert_eq!(px(b, x, y), ground, "{name} ({x}, {y})");
    }
  }
}

#[test]
fn every_fax_flavour_reads_the_same_picture() {
  for name in [
    "g4.tif",
    "g4-strips.tif",
    "g4-lsb.tif",
    "g3-1d.tif",
    "g3-2d.tif",
    "g3-fill.tif",
    "mh.tif",
    "bigtiff.tif",
  ] {
    let b = render(name);
    assert_square(name, &b);
    // Bilevel at full size is exactly black and white.
    assert_eq!(px(&b, 32, 24), [0, 0, 0, 255], "{name}");
    assert_eq!(px(&b, 0, 0), [255, 255, 255, 255], "{name}");
  }
}

#[test]
fn white_is_zero_flips_the_page() {
  let b = render("g4-inverted.tif");
  assert_eq!(px(&b, 32, 24), [255, 255, 255, 255]);
  assert_eq!(px(&b, 0, 0), [0, 0, 0, 255]);
}

#[test]
fn every_raster_flavour_reads_the_same_picture() {
  for name in [
    "rgb-lzw.tif",
    "rgb-predictor.tif",
    "tiled.tif",
    "jpeg.tif",
    "jpeg-ycbcr.tif",
    "gray-deflate.tif",
    "gray16.tif",
    "cmyk.tif",
  ] {
    assert_square(name, &render(name));
  }
}

#[test]
fn palette_colour_is_refused_by_name() {
  let err = open("palette.tif")
    .render(0, &RenderOptions::default())
    .unwrap_err();
  assert!(matches!(err, TiffError::Unsupported(_)), "{err}");
}

#[test]
fn colours_come_through() {
  for name in ["rgb-lzw.tif", "tiled.tif"] {
    let b = render(name);
    assert_eq!(px(&b, 32, 24), [220, 20, 20, 255], "{name}");
    assert_eq!(px(&b, 64, 44), [30, 60, 200, 255], "{name}");
    assert_eq!(px(&b, 2, 2), [0, 200, 0, 255], "{name}");
  }
  // Lossy: within a few levels.
  let b = render("jpeg-ycbcr.tif");
  let [r, g, bl, _] = px(&b, 32, 24);
  assert!(r > 190 && g < 60 && bl < 60, "{:?}", (r, g, bl));
  // Grey at 8 and 16 bits; CMYK cyan ground and red square.
  assert_eq!(px(&render("gray-deflate.tif"), 32, 24), [50, 50, 50, 255]);
  assert_eq!(px(&render("gray16.tif"), 64, 44), [200, 200, 200, 255]);
  let cmyk = render("cmyk.tif");
  assert_eq!(px(&cmyk, 64, 44), [0, 255, 255, 255]);
  assert_eq!(px(&cmyk, 32, 24), [255, 0, 0, 255]);
}

#[test]
fn alpha_is_kept() {
  let b = render("rgba.tif");
  assert_eq!(px(&b, 64, 44)[3], 0);
  assert_eq!(px(&b, 32, 24), [220, 20, 20, 255]);
}

#[test]
fn orientation_turns_the_page() {
  let tiff = open("orient6.tif");
  let page = &tiff.pages()[0];
  assert_eq!((page.width, page.height, page.orientation), (50, 70, 6));
  let b = tiff.render(0, &RenderOptions::default()).unwrap();
  assert_eq!((b.width, b.height), (50, 70));
  // Stored top-left is shown top-right after a quarter turn clockwise.
  assert_eq!(px(&b, 47, 2), [0, 200, 0, 255]);
  assert_eq!(px(&b, 2, 2), [30, 60, 200, 255]);
  // Stored (32, 24) — inside the square — lands at (50 - 1 - 24, 32).
  assert_eq!(px(&b, 25, 32), [220, 20, 20, 255]);
}

#[test]
fn pages_skip_reduced_resolution_directories() {
  let tiff = open("multipage.tif");
  assert_eq!(tiff.pages().len(), 3);
  for (n, _) in tiff.pages().iter().enumerate() {
    let b = tiff.render(n, &RenderOptions::default()).unwrap();
    assert_eq!((b.width, b.height), (70, 50));
    // The nth page's bar runs to x = 8 + 12(n + 1).
    let end = 8 + 12 * (n as u32 + 1);
    assert_eq!(px(&b, end, 14), [0, 0, 0, 255], "page {n}");
    assert_eq!(px(&b, end + 1, 14), [255, 255, 255, 255], "page {n}");
  }
  assert!(matches!(
    tiff.render(3, &RenderOptions::default()),
    Err(TiffError::NoPage(3))
  ));
}

#[test]
fn page_metadata() {
  let g4 = open("g4.tif").pages()[0].clone();
  assert_eq!(g4.compression, Compression::CcittGroup4);
  assert_eq!((g4.bits_per_sample, g4.samples_per_pixel), (1, 1));
  assert_eq!(g4.dpi, Some((300.0, 300.0)));
  let (x, y) = open("g4-cm.tif").pages()[0].dpi.unwrap();
  assert!((x - 300.0).abs() < 0.01 && (y - 300.0).abs() < 0.01);
  assert_eq!(
    open("g3-2d.tif").pages()[0].compression,
    Compression::CcittGroup3
  );
  assert_eq!(open("mh.tif").pages()[0].compression, Compression::CcittRle);
  let rgb = open("rgb-lzw.tif").pages()[0].clone();
  assert_eq!(rgb.compression, Compression::Lzw);
  assert_eq!((rgb.bits_per_sample, rgb.samples_per_pixel), (8, 3));
}

#[test]
fn reduces_to_the_cap() {
  for name in ["g4.tif", "rgb-lzw.tif", "tiled.tif"] {
    let tiff = open(name);
    let half = RenderOptions {
      max_pixels: 35 * 25,
      max_width: None,
    };
    let b = tiff.render(0, &half).unwrap();
    assert_eq!((b.width, b.height), (35, 25), "{name}");
    assert!(luma(px(&b, 16, 12)) < 100, "{name}");
    let narrow = RenderOptions {
      max_pixels: u64::MAX,
      max_width: Some(14),
    };
    assert_eq!(tiff.render(0, &narrow).unwrap().width, 14, "{name}");
  }
  // A bilevel page reduced is grey where the square's edge splits a cell.
  let b = open("g4.tif")
    .render(
      0,
      &RenderOptions {
        max_pixels: 7 * 5,
        max_width: None,
      },
    )
    .unwrap();
  assert_eq!((b.width, b.height), (7, 5));
  assert!(
    b.data
      .as_chunks::<4>()
      .0
      .iter()
      .any(|p| p[0] > 0 && p[0] < 255)
  );
}

#[test]
fn sniffs_all_four_signatures() {
  assert!(is_tiff(b"II*\0"));
  assert!(is_tiff(b"MM\0*"));
  assert!(is_tiff(b"II+\0"));
  assert!(is_tiff(b"MM\0+"));
  assert!(!is_tiff(b"II*"));
  assert!(!is_tiff(b"%PDF-1.7"));
  assert!(matches!(
    Tiff::load(b"%PDF-1.7".to_vec()),
    Err(TiffError::NotTiff)
  ));
}

#[test]
fn a_truncated_fax_keeps_its_first_rows() {
  let path = format!(
    "{}/tests/fixtures/g4-strips.tif",
    env!("CARGO_MANIFEST_DIR")
  );
  let mut bytes = std::fs::read(path).unwrap();
  // Corrupt everything past the first 40 bytes of image data: the directory sits at
  // the end in libtiff's output, so this hits strips, not tags.
  let dir = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
  for b in &mut bytes[8 + 40..dir] {
    *b = 0xff;
  }
  let b = Tiff::load(bytes)
    .unwrap()
    .render(0, &RenderOptions::default())
    .unwrap();
  assert_eq!((b.width, b.height), (70, 50));
}
