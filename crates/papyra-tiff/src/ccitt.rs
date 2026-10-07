//! Fax-coded bilevel pages: TIFF compressions 2, 3 and 4, through `hayro-ccitt`.
//!
//! The common case for a scanned drawing, and the reason this path exists separately
//! from `raster.rs`: hayro-ccitt pushes pixels one run at a time, so black is counted
//! straight into the output cell it falls in and white — most of a drawing — costs
//! nothing. Measured on a 13200x10200 G4 sheet, 75ms native to a 16 MP preview,
//! against 2.2s for utif2 to decode it whole in JavaScript.

use crate::resample::Downsampler;
use crate::{Result, TiffError};
use hayro_ccitt::{DecodeSettings, DecoderContext, EncodingMode};

/// What `tags.rs` read about one fax-coded page.
pub(crate) struct Fax {
  pub width: u32,
  pub height: u32,
  pub compression: u16,
  /// TIFF `T4Options`. Only bit 0, 2D coding, matters here; see `decode` for bit 2.
  pub t4_options: u32,
  /// `PhotometricInterpretation` 0: a 0 bit is white, which is what the codes say.
  pub white_is_zero: bool,
  /// `FillOrder` 2: the bits of every byte are stored lowest first.
  pub lsb_first: bool,
  pub rows_per_strip: u32,
  pub strips: Vec<(u64, u64)>,
}

struct Sink<'a> {
  out: &'a mut Downsampler,
  x: u32,
  /// A code's "white" is ink when `PhotometricInterpretation` says 0 is black.
  ink_is_white: bool,
  rows: u32,
}

impl hayro_ccitt::Decoder for Sink<'_> {
  #[inline]
  fn push_pixel(&mut self, white: bool) {
    if white == self.ink_is_white {
      self.out.ink(self.x);
    }
    self.x += 1;
  }

  fn push_pixel_chunk(&mut self, white: bool, chunk_count: u32) {
    let n = chunk_count * 8;
    if white == self.ink_is_white {
      for x in self.x..self.x + n {
        self.out.ink(x);
      }
    }
    self.x += n;
  }

  fn next_line(&mut self) {
    // A malformed strip can carry more rows than it claims; those would shift every
    // later strip down the page.
    if self.out.remaining() > 0 {
      self.out.end_row();
    }
    self.x = 0;
    self.rows += 1;
  }
}

/// Decode every strip into `out`, which must be a [`Mode::Ink`](crate::resample::Mode) sampler.
pub(crate) fn decode(bytes: &[u8], fax: &Fax, out: &mut Downsampler) -> Result<()> {
  let encoding = match fax.compression {
    4 => EncodingMode::Group4,
    3 if fax.t4_options & 1 != 0 => EncodingMode::Group3_2D { k: 0 },
    _ => EncodingMode::Group3_1D,
  };
  let mut decoded_any = false;
  let mut first_error = None;
  let mut flipped = Vec::new();
  for (i, &(offset, len)) in fax.strips.iter().enumerate() {
    let expected = fax
      .rows_per_strip
      .min(fax.height.saturating_sub(i as u32 * fax.rows_per_strip));
    if expected == 0 || out.remaining() == 0 {
      break;
    }
    // Clamped rather than refused: a strip running past the end of a truncated file
    // still holds whatever rows it has.
    let start = (offset as usize).min(bytes.len());
    let end = start.saturating_add(len as usize).min(bytes.len());
    let mut data = &bytes[start..end];
    if fax.lsb_first {
      flipped.clear();
      flipped.extend(data.iter().map(|b| b.reverse_bits()));
      data = &flipped;
    }
    let settings = DecodeSettings {
      columns: fax.width,
      rows: expected,
      end_of_block: true,
      end_of_line: fax.compression == 3,
      // Compression 2 starts every row on a byte. T4's fill bits (`T4Options` bit 2)
      // are not the same thing — they pad *before* an EOL, which hayro-ccitt's EOL
      // reader already skips as leading zeros. Passing them as row alignment
      // misreads every row; `g3-fill.tif` is the case.
      rows_are_byte_aligned: fax.compression == 2,
      encoding,
      invert_black: false,
    };
    let mut ctx = DecoderContext::new(settings);
    let mut sink = Sink {
      out,
      x: 0,
      ink_is_white: !fax.white_is_zero,
      rows: 0,
    };
    // hayro-ccitt keeps the rows it decoded before an error, and so does this: a
    // scan with one damaged strip is still worth showing.
    if let Err(e) = hayro_ccitt::decode(data, &mut sink, &mut ctx) {
      first_error.get_or_insert(e);
    }
    let rows = sink.rows;
    decoded_any |= rows > 0;
    // Short strips are padded with blank rows, so the next one starts where it should.
    for _ in rows..expected {
      if out.remaining() == 0 {
        break;
      }
      out.end_row();
    }
  }
  match first_error {
    Some(e) if !decoded_any => Err(TiffError::Ccitt(e)),
    _ => Ok(()),
  }
}
