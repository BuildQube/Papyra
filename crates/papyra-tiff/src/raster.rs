//! Everything that is not fax-coded: grey, RGB, CMYK and YCbCr, at 1–16 bits,
//! uncompressed or LZW, Deflate, PackBits or JPEG, in strips or tiles.
//!
//! The `tiff` crate decompresses one chunk at a time and undoes the predictor and
//! `WhiteIsZero`; this turns each chunk's rows into grey or RGBA and hands them to the
//! sampler. Tiles are gathered a band at a time — one row of tiles, the full width —
//! because the sampler wants whole source rows in order.

use crate::resample::{Downsampler, Mode};
use crate::{Result, TiffError};
use std::io::{Read, Seek};
use tiff::ColorType;
use tiff::decoder::{Decoder, DecodingResult};

/// The largest band held at once. A strip is a band, so this is also the largest
/// strip: libtiff writes ~8 KB strips and scanners rarely exceed a few MB, but a
/// single-strip 600-dpi colour sheet would be gigabytes and has to be refused rather
/// than allocated.
const MAX_BAND_BYTES: usize = 256 << 20;

/// How decoded samples become pixels.
pub(crate) struct Raster {
  pub color: ColorType,
}

impl Raster {
  pub(crate) fn mode(&self) -> Mode {
    match self.color {
      ColorType::Gray(_) => Mode::Gray,
      _ => Mode::Rgba,
    }
  }
}

pub(crate) fn decode<R: Read + Seek>(
  dec: &mut Decoder<R>,
  raster: &Raster,
  out: &mut Downsampler,
) -> Result<()> {
  let (width, height) = dec.dimensions()?;
  let (chunk_w, chunk_h) = dec.chunk_dimensions();
  if chunk_w == 0 || chunk_h == 0 {
    return Err(TiffError::Unsupported("zero-sized strips or tiles".into()));
  }
  let across = width.div_ceil(chunk_w);
  let down = height.div_ceil(chunk_h);
  let channels = match raster.mode() {
    Mode::Gray => 1,
    _ => 4,
  };
  let band_bytes = width as usize * chunk_h as usize * channels;
  if band_bytes > MAX_BAND_BYTES {
    return Err(TiffError::TooLarge(format!(
      "{width}x{chunk_h} strip; it would decode to {} MB at once",
      band_bytes >> 20
    )));
  }
  let row_bytes = width as usize * channels;
  let mut band = vec![0u8; band_bytes];
  let mut decoded_any = false;

  'bands: for r in 0..down {
    let rows = chunk_h.min(height - r * chunk_h) as usize;
    for c in 0..across {
      let index = r * across + c;
      let chunk = match dec.read_chunk(index) {
        Ok(chunk) => chunk,
        // As on the fax path: a damaged chunk after good ones leaves the rest of the
        // page blank instead of losing what was already decoded.
        Err(_) if decoded_any => break 'bands,
        Err(e) => return Err(e.into()),
      };
      let (data_w, data_h) = dec.chunk_data_dimensions(index);
      let x0 = (c * chunk_w) as usize;
      let samples = Samples::of(&chunk, raster.color)?;
      let stride = samples.len() / data_h.max(1) as usize;
      for y in 0..(data_h as usize).min(rows) {
        let src = samples.slice(y * stride, stride);
        let dst = &mut band[y * row_bytes + x0 * channels..][..data_w as usize * channels];
        convert(raster, src, dst, data_w as usize)?;
      }
    }
    decoded_any = true;
    for y in 0..rows {
      out.push_row(&band[y * row_bytes..][..row_bytes]);
    }
  }
  Ok(())
}

/// One chunk's decoded samples. Only the two widths a scan uses; float and signed
/// TIFFs are scientific data, not documents.
#[derive(Clone, Copy)]
enum Samples<'a> {
  U8(&'a [u8]),
  U16(&'a [u16]),
}

impl<'a> Samples<'a> {
  fn of(result: &'a DecodingResult, color: ColorType) -> Result<Self> {
    match result {
      DecodingResult::U8(v) => Ok(Samples::U8(v)),
      DecodingResult::U16(v) => Ok(Samples::U16(v)),
      _ => Err(TiffError::Unsupported(format!(
        "{color:?} with non-integer or wider than 16-bit samples"
      ))),
    }
  }

  fn len(self) -> usize {
    match self {
      Samples::U8(v) => v.len(),
      Samples::U16(v) => v.len(),
    }
  }

  fn slice(self, start: usize, len: usize) -> Self {
    match self {
      Samples::U8(v) => Samples::U8(&v[start..start + len]),
      Samples::U16(v) => Samples::U16(&v[start..start + len]),
    }
  }

  /// Sample `i` of a row, at its stored depth.
  #[inline]
  fn get(self, i: usize, bits: u8) -> u32 {
    match self {
      Samples::U16(v) => u32::from(v[i]),
      Samples::U8(v) if bits == 8 => u32::from(v[i]),
      Samples::U8(v) => {
        // 1, 2 and 4 bits, packed high bit first; rows start on a byte.
        let bit = i * usize::from(bits);
        let shift = 8 - usize::from(bits) - bit % 8;
        (u32::from(v[bit / 8]) >> shift) & ((1 << bits) - 1)
      }
    }
  }
}

#[inline]
fn to8(v: u32, bits: u8) -> u8 {
  match bits {
    8 => v as u8,
    16 => (v >> 8) as u8,
    b => (v * 255 / ((1 << b) - 1)) as u8,
  }
}

fn convert(raster: &Raster, src: Samples<'_>, dst: &mut [u8], width: usize) -> Result<()> {
  let s = |i: usize, bits: u8| to8(src.get(i, bits), bits);
  match raster.color {
    ColorType::Gray(b) => {
      for (x, d) in dst.iter_mut().enumerate().take(width) {
        *d = s(x, b);
      }
    }
    ColorType::GrayA(b) => each(dst, width, |x| {
      let g = s(2 * x, b);
      [g, g, g, s(2 * x + 1, b)]
    }),
    ColorType::RGB(b) => each(dst, width, |x| {
      [s(3 * x, b), s(3 * x + 1, b), s(3 * x + 2, b), 255]
    }),
    ColorType::RGBA(b) => each(dst, width, |x| {
      [
        s(4 * x, b),
        s(4 * x + 1, b),
        s(4 * x + 2, b),
        s(4 * x + 3, b),
      ]
    }),
    ColorType::CMYK(b) => each(dst, width, |x| cmyk(|c| s(4 * x + c, b), 255)),
    ColorType::CMYKA(b) => each(dst, width, |x| cmyk(|c| s(5 * x + c, b), s(5 * x + 4, b))),
    // JPEG's included: the `tiff` crate asks zune-jpeg for the stored colour space,
    // so a JPEG-in-TIFF scan arrives as YCbCr, upsampled but not converted.
    ColorType::YCbCr(8) => each(dst, width, |x| {
      ycbcr(s(3 * x, 8), s(3 * x + 1, 8), s(3 * x + 2, 8))
    }),
    other => {
      return Err(TiffError::Unsupported(format!("colour type {other:?}")));
    }
  }
  Ok(())
}

#[inline]
fn each(dst: &mut [u8], width: usize, mut px: impl FnMut(usize) -> [u8; 4]) {
  for (x, d) in dst
    .as_chunks_mut::<4>()
    .0
    .iter_mut()
    .enumerate()
    .take(width)
  {
    *d = px(x);
  }
}

/// Naive CMYK: no ICC profile is applied, so a print-ready scan shows a little more
/// saturated than it prints. Fine for a preview, and the only option without a CMM.
#[inline]
fn cmyk(s: impl Fn(usize) -> u8, alpha: u8) -> [u8; 4] {
  let k = 255 - u32::from(s(3));
  let ch = |c: usize| ((255 - u32::from(s(c))) * k / 255) as u8;
  [ch(0), ch(1), ch(2), alpha]
}

/// Full-range BT.601, which is what TIFF's default `YCbCrCoefficients` and
/// `ReferenceBlackWhite` describe.
#[inline]
fn ycbcr(y: u8, cb: u8, cr: u8) -> [u8; 4] {
  let (y, cb, cr) = (f32::from(y), f32::from(cb) - 128.0, f32::from(cr) - 128.0);
  let c = |v: f32| v.round().clamp(0.0, 255.0) as u8;
  [
    c(y + 1.402 * cr),
    c(y - 0.344_136 * cb - 0.714_136 * cr),
    c(y + 1.772 * cb),
    255,
  ]
}
