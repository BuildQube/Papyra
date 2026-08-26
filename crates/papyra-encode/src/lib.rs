//! Pure-Rust image encoders for papyra bitmaps.
//!
//! This crate knows nothing about hayro or any other backend — it takes a
//! [`papyra_core::Bitmap`] and produces encoded bytes. Every codec here is pure Rust,
//! which is what keeps the `wasm32-wasip1-threads` target buildable without a C
//! toolchain.
//!
//! Raw RGBA is still the right output for a canvas: `putImageData` needs no decode, so
//! encoding only buys you something when the pixels are leaving the process — an
//! `<img src>`, a network response, a file on disk.

use std::borrow::Cow;
use std::io::Cursor;

use base64::Engine as _;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::codecs::webp::WebPEncoder;
use image::{ExtendedColorType, ImageEncoder};
use papyra_core::{Bitmap, PapyraError, PixelFormat, Result};

/// Output container for an encoded page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
  /// Lossless VP8L, and the default. Measured across the test corpus it is ~3x smaller
  /// than PNG for roughly the same encode time. There is no lossy WebP here: the only
  /// lossy encoder that is pure Rust is JPEG.
  WebP,
  /// Lossless. The universal fallback — everything opens a PNG.
  Png,
  /// The only lossy option, and the only one with a quality knob. No alpha channel.
  Jpeg,
}

impl ImageFormat {
  pub fn mime(self) -> &'static str {
    match self {
      Self::WebP => "image/webp",
      Self::Png => "image/png",
      Self::Jpeg => "image/jpeg",
    }
  }

  /// File extension, without the dot.
  pub fn extension(self) -> &'static str {
    match self {
      Self::WebP => "webp",
      Self::Png => "png",
      Self::Jpeg => "jpg",
    }
  }

  /// Whether the format preserves an alpha channel. False for JPEG, which is why
  /// [`encode`] flattens onto white for it.
  pub fn supports_alpha(self) -> bool {
    !matches!(self, Self::Jpeg)
  }
}

#[derive(Debug, Clone, Copy)]
pub struct EncodeOptions {
  pub format: ImageFormat,
  /// JPEG only, clamped to `1..=100`. PNG and WebP are lossless here, so it is ignored
  /// for both.
  pub quality: u8,
}

impl Default for EncodeOptions {
  fn default() -> Self {
    Self {
      format: ImageFormat::WebP,
      quality: 80,
    }
  }
}

impl EncodeOptions {
  pub fn new(format: ImageFormat) -> Self {
    Self {
      format,
      ..Default::default()
    }
  }

  pub fn with_quality(mut self, quality: u8) -> Self {
    self.quality = quality;
    self
  }
}

/// Encode a bitmap.
///
/// Rows are expected tightly packed (`stride == width * 4`), which is what the hayro
/// backend produces; anything else is repacked first.
pub fn encode(bitmap: &Bitmap, opts: &EncodeOptions) -> Result<Vec<u8>> {
  let (width, height) = (bitmap.width, bitmap.height);
  if width == 0 || height == 0 {
    return Err(PapyraError::Encode(format!(
      "cannot encode a {width}x{height} bitmap"
    )));
  }

  let rgba = normalize(bitmap)?;
  // Encoded output is smaller than the source often enough that guessing low beats
  // growing from zero. WebP and PNG on page content land well under an eighth.
  let mut out = Vec::with_capacity(rgba.len() / 8);

  match opts.format {
    ImageFormat::WebP => WebPEncoder::new_lossless(&mut out)
      .write_image(&rgba, width, height, ExtendedColorType::Rgba8)
      .map_err(encode_err)?,

    ImageFormat::Png => {
      // `Fast` is the png crate's own default. A render pipeline wants the encoder to
      // keep up with the rasteriser, not to squeeze out a last few percent.
      PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(&rgba, width, height, ExtendedColorType::Rgba8)
        .map_err(encode_err)?
    }

    ImageFormat::Jpeg => {
      let rgb = flatten_onto_white(&rgba);
      let quality = opts.quality.clamp(1, 100);
      JpegEncoder::new_with_quality(&mut Cursor::new(&mut out), quality)
        .write_image(&rgb, width, height, ExtendedColorType::Rgb8)
        .map_err(encode_err)?
    }
  }

  Ok(out)
}

/// Encode, then wrap the bytes in a `data:` URL.
///
/// Base64 inflates by a third and the result is a single string on the JS heap, so for
/// an `<img src>` in a browser a blob URL is the better tool. Reach for this when the
/// bytes have to be embedded: CSS, serialised output, server-rendered HTML.
pub fn encode_to_data_url(bitmap: &Bitmap, opts: &EncodeOptions) -> Result<String> {
  let bytes = encode(bitmap, opts)?;
  Ok(data_url(&bytes, opts.format.mime()))
}

pub fn data_url(bytes: &[u8], mime: &str) -> String {
  let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
  let mut url = String::with_capacity(mime.len() + encoded.len() + 13);
  url.push_str("data:");
  url.push_str(mime);
  url.push_str(";base64,");
  url.push_str(&encoded);
  url
}

/// Borrow the pixels as packed RGBA8, copying only when the layout forces it.
///
/// The hayro backend already hands us packed, straight-alpha RGBA (it calls
/// `take_unpremultiplied()`), so the common path borrows and no copy happens.
fn normalize(bitmap: &Bitmap) -> Result<Cow<'_, [u8]>> {
  let width = bitmap.width as usize;
  let height = bitmap.height as usize;
  let stride = bitmap.stride as usize;
  let packed = width * 4;

  if stride < packed {
    return Err(PapyraError::Encode(format!(
      "stride {stride} is too small for a {width}px row"
    )));
  }
  let needed = stride * (height - 1) + packed;
  if bitmap.data.len() < needed {
    return Err(PapyraError::Encode(format!(
      "bitmap has {} bytes, needs {needed} for {width}x{height} at stride {stride}",
      bitmap.data.len()
    )));
  }

  let rows: Cow<'_, [u8]> = if stride == packed {
    Cow::Borrowed(&bitmap.data[..packed * height])
  } else {
    let mut out = Vec::with_capacity(packed * height);
    for y in 0..height {
      out.extend_from_slice(&bitmap.data[y * stride..y * stride + packed]);
    }
    Cow::Owned(out)
  };

  match bitmap.format {
    PixelFormat::Rgba8 => Ok(rows),
    // Nothing produces Bgra8 today, but the variant is part of the public type, so
    // handle it rather than pretending it cannot arrive.
    PixelFormat::Bgra8 => {
      let mut out = rows.into_owned();
      for px in out.chunks_exact_mut(4) {
        px.swap(0, 2);
      }
      Ok(Cow::Owned(out))
    }
  }
}

/// RGBA8 -> RGB8, compositing onto white.
///
/// JPEG has no alpha channel. Dropping the channel outright would render any
/// transparent region as whatever garbage sat in the colour bytes — usually black.
/// White matches `RenderOptions::white_background`, which is the render default.
fn flatten_onto_white(rgba: &[u8]) -> Vec<u8> {
  let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
  for px in rgba.chunks_exact(4) {
    let a = px[3] as u32;
    if a == 255 {
      rgb.extend_from_slice(&px[..3]);
    } else {
      let inv = 255 - a;
      for &c in &px[..3] {
        rgb.push(((c as u32 * a + 255 * inv + 127) / 255) as u8);
      }
    }
  }
  rgb
}

fn encode_err(e: image::ImageError) -> PapyraError {
  PapyraError::Encode(e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;
  use image::GenericImageView;

  /// A gradient, so a lossless round trip proves more than a flat fill would.
  fn bitmap(width: u32, height: u32, alpha: u8) -> Bitmap {
    let mut data = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
      for x in 0..width {
        data.extend_from_slice(&[(x * 7) as u8, (y * 11) as u8, (x ^ y) as u8, alpha]);
      }
    }
    Bitmap {
      width,
      height,
      stride: width * 4,
      format: PixelFormat::Rgba8,
      data,
    }
  }

  #[test]
  fn webp_round_trips_losslessly() {
    let src = bitmap(64, 48, 255);
    let bytes = encode(&src, &EncodeOptions::new(ImageFormat::WebP)).unwrap();

    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WEBP");

    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!(decoded.dimensions(), (64, 48));
    assert_eq!(decoded.to_rgba8().into_raw(), src.data);
  }

  #[test]
  fn png_round_trips_losslessly() {
    let src = bitmap(64, 48, 255);
    let bytes = encode(&src, &EncodeOptions::new(ImageFormat::Png)).unwrap();

    assert_eq!(&bytes[0..4], &[0x89, b'P', b'N', b'G']);

    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!(decoded.dimensions(), (64, 48));
    assert_eq!(decoded.to_rgba8().into_raw(), src.data);
  }

  #[test]
  fn jpeg_is_jfif_and_opaque() {
    let src = bitmap(64, 48, 255);
    let bytes = encode(
      &src,
      &EncodeOptions::new(ImageFormat::Jpeg).with_quality(90),
    )
    .unwrap();

    assert_eq!(&bytes[0..2], &[0xFF, 0xD8]); // SOI

    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!(decoded.dimensions(), (64, 48));
    assert!(decoded.to_rgba8().pixels().all(|p| p.0[3] == 255));
  }

  #[test]
  fn jpeg_flattens_transparent_pixels_onto_white_not_black() {
    // Fully transparent everywhere: the colour bytes are non-zero garbage that a naive
    // channel drop would emit verbatim.
    let src = bitmap(16, 16, 0);
    let bytes = encode(
      &src,
      &EncodeOptions::new(ImageFormat::Jpeg).with_quality(100),
    )
    .unwrap();

    let decoded = image::load_from_memory(&bytes).unwrap().to_rgb8();
    for px in decoded.pixels() {
      // JPEG is lossy even at 100, so allow a little drift off pure white.
      assert!(
        px.0.iter().all(|&c| c > 245),
        "expected white, got {:?}",
        px.0
      );
    }
  }

  #[test]
  fn padded_stride_is_repacked() {
    let mut src = bitmap(8, 4, 255);
    let packed = src.data.clone();

    // Rebuild with 16 bytes of junk padding per row.
    let stride = 8 * 4 + 16;
    let mut padded = Vec::new();
    for y in 0..4usize {
      padded.extend_from_slice(&packed[y * 32..(y + 1) * 32]);
      padded.extend_from_slice(&[0xAB; 16]);
    }
    src.stride = stride as u32;
    src.data = padded;

    let bytes = encode(&src, &EncodeOptions::new(ImageFormat::Png)).unwrap();
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!(decoded.to_rgba8().into_raw(), packed);
  }

  #[test]
  fn bgra_is_swizzled() {
    let mut src = bitmap(8, 8, 255);
    src.format = PixelFormat::Bgra8;
    let expected: Vec<u8> = src
      .data
      .chunks_exact(4)
      .flat_map(|p| [p[2], p[1], p[0], p[3]])
      .collect();

    let bytes = encode(&src, &EncodeOptions::new(ImageFormat::Png)).unwrap();
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!(decoded.to_rgba8().into_raw(), expected);
  }

  #[test]
  fn data_url_carries_the_right_mime() {
    let src = bitmap(4, 4, 255);
    let url = encode_to_data_url(&src, &EncodeOptions::new(ImageFormat::WebP)).unwrap();
    assert!(url.starts_with("data:image/webp;base64,"));
  }

  #[test]
  fn empty_bitmaps_are_rejected() {
    let mut src = bitmap(4, 4, 255);
    src.width = 0;
    assert!(encode(&src, &EncodeOptions::default()).is_err());
  }

  #[test]
  fn truncated_data_is_rejected_rather_than_panicking() {
    let mut src = bitmap(16, 16, 255);
    src.data.truncate(10);
    assert!(encode(&src, &EncodeOptions::default()).is_err());
  }
}
