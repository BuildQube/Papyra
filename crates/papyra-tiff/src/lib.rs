//! TIFF pages for papyra, decoded straight to a capped size.
//!
//! TIFF is what scanned drawings and fax-era documents arrive as, and what browsers
//! will not show in an `<img>`. The format is a container — directories of tags
//! pointing at strips or tiles — so the container and most codecs are the `tiff`
//! crate's, and fax coding (`ccitt.rs`) is `hayro-ccitt`'s, which hayro already
//! compiles in for PDF.
//!
//! The one decision that shapes the rest: **a page is never held at full size.** A
//! 300-dpi E-size sheet is 135 MP; at 600 dpi in colour it is 1.6 GB of RGB, which a
//! browser tab cannot allocate. Both decoders hand rows to `resample.rs` as they are
//! produced, and only the reduced bitmap exists at the end. The cap defaults to
//! [`DEFAULT_MAX_PIXELS`].
//!
//! Like `papyra-tables`, this sits beside the PDF stack rather than inside it: a TIFF
//! has no fonts, text or links, and the `Engine`/`Document` traits would be mostly
//! defaults. It shares `Bitmap` with it, so the encoders work on a page unchanged.

mod ccitt;
mod raster;
mod resample;

use std::io::Cursor;

pub use papyra_core::Bitmap;
use resample::{Downsampler, Mode};
use tiff::decoder::Decoder;
use tiff::tags::Tag;

/// The default output cap: 4096 x 4096.
///
/// iOS Safari refuses a canvas larger than 16,777,216 pixels, and this is that
/// number; it is also 64 MB of RGBA, which every target can hold. A 300-dpi E-size
/// sheet comes out at about 100 dpi — readable, though a hairline is grey.
pub const DEFAULT_MAX_PIXELS: u64 = 4096 * 4096;

/// The largest page decoded at all, before reduction. A 44x34in sheet at 1000 dpi
/// is 1.5 GP and fits; past this the time to read every source pixel is the problem,
/// whatever the output size, and a small file declaring such a page is far more
/// likely hostile than a scan.
const MAX_SOURCE_PIXELS: u64 = 1 << 31;

/// Directories read before the rest are ignored. The `tiff` crate already refuses a
/// cycle; this bounds a long chain that is not one.
const MAX_PAGES: usize = 10_000;

#[derive(Debug, thiserror::Error)]
pub enum TiffError {
  #[error("not a TIFF file")]
  NotTiff,
  #[error("no page {0}")]
  NoPage(usize),
  #[error("unsupported TIFF: {0}")]
  Unsupported(String),
  #[error("TIFF page too large to preview: {0}")]
  TooLarge(String),
  #[error("malformed fax data: {0}")]
  Ccitt(hayro_ccitt::DecodeError),
  #[error("malformed TIFF: {0}")]
  Decode(#[from] tiff::TiffError),
}

pub type Result<T> = std::result::Result<T, TiffError>;

/// How a page's pixels are stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compression {
  None,
  /// Compression 2: Modified Huffman, one-dimensional, rows byte-aligned.
  CcittRle,
  /// Compression 3: T.4, one- or two-dimensional.
  CcittGroup3,
  /// Compression 4: T.6. The common case for a scanned drawing.
  CcittGroup4,
  Lzw,
  /// Compression 6, the pre-1995 JPEG-in-TIFF. Listed, and refused when rendered.
  OldJpeg,
  Jpeg,
  Deflate,
  PackBits,
  Other(u16),
}

impl Compression {
  fn from_tag(value: u16) -> Self {
    match value {
      1 => Compression::None,
      2 => Compression::CcittRle,
      3 => Compression::CcittGroup3,
      4 => Compression::CcittGroup4,
      5 => Compression::Lzw,
      6 => Compression::OldJpeg,
      7 => Compression::Jpeg,
      8 | 32946 => Compression::Deflate,
      32773 => Compression::PackBits,
      n => Compression::Other(n),
    }
  }

  pub fn as_str(self) -> &'static str {
    match self {
      Compression::None => "none",
      Compression::CcittRle => "ccitt-rle",
      Compression::CcittGroup3 => "ccitt-g3",
      Compression::CcittGroup4 => "ccitt-g4",
      Compression::Lzw => "lzw",
      Compression::OldJpeg => "old-jpeg",
      Compression::Jpeg => "jpeg",
      Compression::Deflate => "deflate",
      Compression::PackBits => "packbits",
      Compression::Other(_) => "other",
    }
  }

  fn is_fax(self) -> bool {
    matches!(
      self,
      Compression::CcittRle | Compression::CcittGroup3 | Compression::CcittGroup4
    )
  }
}

/// One page, as shown: `Orientation` is already applied to the size and resolution.
#[derive(Debug, Clone)]
pub struct Page {
  pub width: u32,
  pub height: u32,
  /// Horizontal and vertical resolution in dots per inch, when the file states one in
  /// inches or centimetres. Fax pages are usually 204x196, not square.
  pub dpi: Option<(f32, f32)>,
  pub compression: Compression,
  pub bits_per_sample: u16,
  pub samples_per_pixel: u16,
  /// TIFF `Orientation`, 1–8; 1 is upright.
  pub orientation: u16,
  /// The directory this page is, which differs from its index once a reduced-size
  /// directory has been skipped.
  ifd: usize,
}

impl Page {
  /// Orientations 5–8 store the page on its side.
  fn transposed(&self) -> bool {
    (5..=8).contains(&self.orientation)
  }
}

/// Size limits for [`Tiff::render`]. The output keeps the page's aspect ratio and is
/// never larger than the page.
#[derive(Debug, Clone, Copy)]
pub struct RenderOptions {
  pub max_pixels: u64,
  pub max_width: Option<u32>,
}

impl Default for RenderOptions {
  fn default() -> Self {
    RenderOptions {
      max_pixels: DEFAULT_MAX_PIXELS,
      max_width: None,
    }
  }
}

/// `II*\0` or `MM\0*`, or the BigTIFF forms `II+\0` and `MM\0+`.
pub fn is_tiff(head: &[u8]) -> bool {
  matches!(
    head,
    [b'I', b'I', 42 | 43, 0, ..] | [b'M', b'M', 0, 42 | 43, ..]
  )
}

/// An opened TIFF: its pages listed, nothing decoded.
pub struct Tiff {
  bytes: Vec<u8>,
  pages: Vec<Page>,
}

impl Tiff {
  /// Walk the directory chain and list the pages.
  ///
  /// A directory flagged as a reduced-resolution copy (`NewSubfileType` bit 0) is a
  /// thumbnail or a pyramid level of the page before it, not a page, and is skipped —
  /// unless every directory is one, in which case there is nothing else to show.
  pub fn load(bytes: Vec<u8>) -> Result<Self> {
    if !is_tiff(&bytes) {
      return Err(TiffError::NotTiff);
    }
    let mut dec = Decoder::new(Cursor::new(&bytes[..]))?;
    let mut pages = Vec::new();
    let mut reduced = Vec::new();
    for ifd in 0.. {
      let (page, is_reduced) = read_page(&mut dec, ifd)?;
      if is_reduced {
        reduced.push(page);
      } else {
        pages.push(page);
      }
      // A directory that will not parse ends the list rather than the file: the pages
      // before it are fine, and a fax with a damaged last page is still a fax.
      if !dec.more_images() || ifd + 1 >= MAX_PAGES || dec.next_image().is_err() {
        break;
      }
    }
    if pages.is_empty() {
      pages = reduced;
    }
    Ok(Tiff { bytes, pages })
  }

  pub fn pages(&self) -> &[Page] {
    &self.pages
  }

  /// Decode one page into RGBA, reduced to fit `options`, upright.
  pub fn render(&self, index: usize, options: &RenderOptions) -> Result<Bitmap> {
    let page = self.pages.get(index).ok_or(TiffError::NoPage(index))?;
    let mut dec = Decoder::new(Cursor::new(&self.bytes[..]))?;
    dec.seek_to_image(page.ifd)?;
    let (width, height) = dec.dimensions()?;
    if u64::from(width) * u64::from(height) > MAX_SOURCE_PIXELS {
      return Err(TiffError::TooLarge(format!("{width}x{height}")));
    }
    let (shown_w, shown_h) = (page.width, page.height);
    let (out_w, out_h) = resample::fit(shown_w, shown_h, options.max_pixels, options.max_width);
    // Reduced in storage order, then turned: the sampler wants rows as they are stored.
    let out = if page.transposed() {
      (out_h, out_w)
    } else {
      (out_w, out_h)
    };

    let bitmap = if page.compression.is_fax() {
      if page.bits_per_sample != 1 || page.samples_per_pixel != 1 {
        return Err(TiffError::Unsupported(
          "fax coding on a non-bilevel image".into(),
        ));
      }
      if dec.find_tag(Tag::TileOffsets)?.is_some() {
        return Err(TiffError::Unsupported("tiled fax-coded image".into()));
      }
      let fax = ccitt::Fax {
        width,
        height,
        compression: match page.compression {
          Compression::CcittRle => 2,
          Compression::CcittGroup3 => 3,
          _ => 4,
        },
        t4_options: first_u32(&mut dec, Tag::Unknown(292)).unwrap_or(0),
        white_is_zero: first_u32(&mut dec, Tag::PhotometricInterpretation) == Some(0),
        lsb_first: first_u32(&mut dec, Tag::FillOrder) == Some(2),
        rows_per_strip: first_u32(&mut dec, Tag::RowsPerStrip)
          .unwrap_or(height)
          .clamp(1, height.max(1)),
        strips: dec
          .get_tag_u64_vec(Tag::StripOffsets)?
          .into_iter()
          .zip(dec.get_tag_u64_vec(Tag::StripByteCounts)?)
          .collect(),
      };
      let mut sampler = Downsampler::new(Mode::Ink, (width, height), out);
      ccitt::decode(&self.bytes, &fax, &mut sampler)?;
      sampler.finish()
    } else {
      if page.compression == Compression::OldJpeg {
        return Err(TiffError::Unsupported(
          "old-style (compression 6) JPEG".into(),
        ));
      }
      if first_u32(&mut dec, Tag::PlanarConfiguration) == Some(2) && page.samples_per_pixel > 1 {
        return Err(TiffError::Unsupported("separate colour planes".into()));
      }
      if first_u32(&mut dec, Tag::PhotometricInterpretation) == Some(3) {
        // The `tiff` crate has no readout for palette images at all, through 0.11.
        return Err(TiffError::Unsupported("palette colour".into()));
      }
      let raster = raster::Raster {
        color: dec.colortype()?,
      };
      let mut sampler = Downsampler::new(raster.mode(), (width, height), out);
      raster::decode(&mut dec, &raster, &mut sampler)?;
      sampler.finish()
    };
    Ok(orient(bitmap, page.orientation))
  }
}

/// Read the current directory's page description.
fn read_page(dec: &mut Decoder<Cursor<&[u8]>>, ifd: usize) -> Result<(Page, bool)> {
  let (width, height) = dec.dimensions()?;
  let orientation = first_u32(dec, Tag::Orientation)
    .and_then(|o| u16::try_from(o).ok())
    .filter(|o| (1..=8).contains(o))
    .unwrap_or(1);
  let dpi = resolution(dec);
  let mut page = Page {
    width,
    height,
    dpi,
    compression: Compression::from_tag(first_u32(dec, Tag::Compression).map_or(1, |c| c as u16)),
    bits_per_sample: first_u32(dec, Tag::BitsPerSample).map_or(1, |b| b as u16),
    samples_per_pixel: first_u32(dec, Tag::SamplesPerPixel).map_or(1, |s| s as u16),
    orientation,
    ifd,
  };
  if page.transposed() {
    (page.width, page.height) = (height, width);
    page.dpi = dpi.map(|(x, y)| (y, x));
  }
  let reduced = first_u32(dec, Tag::NewSubfileType).is_some_and(|t| t & 1 != 0);
  Ok((page, reduced))
}

/// The first value of a tag that may be a scalar or, like `BitsPerSample`, one per
/// sample. Absent, or of a type that is not an unsigned integer, is `None`.
fn first_u32(dec: &mut Decoder<Cursor<&[u8]>>, tag: Tag) -> Option<u32> {
  let value = dec.find_tag(tag).ok()??;
  value.into_u32_vec().ok()?.first().copied()
}

fn resolution(dec: &mut Decoder<Cursor<&[u8]>>) -> Option<(f32, f32)> {
  let per_inch = match first_u32(dec, Tag::ResolutionUnit).unwrap_or(2) {
    2 => 1.0,
    3 => 2.54,
    // 1 is "no absolute unit": an aspect ratio, not a resolution.
    _ => return None,
  };
  let mut read = |tag| {
    let v = match dec.find_tag(tag).ok()?? {
      tiff::decoder::ifd::Value::Rational(n, d) => f64::from(n) / f64::from(d),
      other => other.into_f64().ok()?,
    };
    (v.is_finite() && v > 0.0).then_some((v * per_inch) as f32)
  };
  let x = read(Tag::XResolution)?;
  Some((x, read(Tag::YResolution).unwrap_or(x)))
}

/// Apply TIFF `Orientation` to a bitmap decoded in storage order.
fn orient(src: Bitmap, orientation: u16) -> Bitmap {
  if orientation <= 1 || orientation > 8 {
    return src;
  }
  let (sw, sh) = (src.width as usize, src.height as usize);
  let (dw, dh) = if orientation >= 5 { (sh, sw) } else { (sw, sh) };
  let mut data = vec![0u8; dw * dh * 4];
  for dy in 0..dh {
    for dx in 0..dw {
      // Which stored pixel lands at (dx, dy). Orientation names where the stored
      // row 0 and column 0 end up: 6 is "row 0 on the right, column 0 at the top".
      let (sx, sy) = match orientation {
        2 => (sw - 1 - dx, dy),
        3 => (sw - 1 - dx, sh - 1 - dy),
        4 => (dx, sh - 1 - dy),
        5 => (dy, dx),
        6 => (dy, sh - 1 - dx),
        7 => (sw - 1 - dy, sh - 1 - dx),
        _ => (sw - 1 - dy, dx),
      };
      let s = (sy * sw + sx) * 4;
      let d = (dy * dw + dx) * 4;
      data[d..d + 4].copy_from_slice(&src.data[s..s + 4]);
    }
  }
  Bitmap {
    width: dw as u32,
    height: dh as u32,
    stride: dw as u32 * 4,
    format: src.format,
    data,
  }
}
