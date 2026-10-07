//! Box-filter reduction, one source row at a time.
//!
//! The reason this crate can open a scan at all: a 300-dpi E-size sheet is 135 MP,
//! half a gigabyte as RGBA, and the source is never held whole. Rows arrive in order
//! from either decoder, are summed into one output row's worth of accumulators, and
//! that row is written out when the next source row belongs to the one after it. The
//! peak is the output bitmap plus one row of accumulators.
//!
//! An exact box average: every source pixel lands in exactly one output cell, so a
//! one-pixel hairline on a drawing survives as a grey line rather than vanishing the
//! way it would under point sampling.

use papyra_core::{Bitmap, PixelFormat};

/// What the accumulators hold, which decides how a finished row is written.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
  /// One count per cell of black source pixels. The CCITT path, where white is the
  /// common case and costs nothing to skip.
  Ink,
  /// One sum per cell of 8-bit grey.
  Gray,
  /// Four sums per cell of 8-bit straight RGBA.
  Rgba,
}

impl Mode {
  fn channels(self) -> usize {
    match self {
      Mode::Ink | Mode::Gray => 1,
      Mode::Rgba => 4,
    }
  }
}

pub(crate) struct Downsampler {
  mode: Mode,
  src_width: u32,
  src_height: u32,
  out_width: u32,
  out_height: u32,
  /// Output column for each source column.
  col: Vec<u32>,
  /// Source columns per output column.
  col_count: Vec<u32>,
  acc: Vec<u64>,
  /// Source rows summed into `acc` so far.
  acc_rows: u32,
  /// Source rows consumed.
  y: u32,
  /// Output rows written.
  out_y: u32,
  out: Vec<u8>,
}

impl Downsampler {
  pub(crate) fn new(mode: Mode, src: (u32, u32), out: (u32, u32)) -> Self {
    let (src_width, src_height) = src;
    let (out_width, out_height) = out;
    debug_assert!(out_width >= 1 && out_width <= src_width);
    debug_assert!(out_height >= 1 && out_height <= src_height);
    let col: Vec<u32> = (0..src_width)
      .map(|x| (u64::from(x) * u64::from(out_width) / u64::from(src_width)) as u32)
      .collect();
    let mut col_count = vec![0u32; out_width as usize];
    for &o in &col {
      col_count[o as usize] += 1;
    }
    Downsampler {
      mode,
      src_width,
      src_height,
      out_width,
      out_height,
      col,
      col_count,
      acc: vec![0; out_width as usize * mode.channels()],
      acc_rows: 0,
      y: 0,
      out_y: 0,
      // White, so rows a damaged file never delivers read as blank paper.
      out: vec![255; out_width as usize * out_height as usize * 4],
    }
  }

  /// Source rows still expected.
  pub(crate) fn remaining(&self) -> u32 {
    self.src_height - self.y
  }

  /// Count one black source pixel. [`Mode::Ink`] only.
  #[inline]
  pub(crate) fn ink(&mut self, x: u32) {
    if let Some(&o) = self.col.get(x as usize) {
      self.acc[o as usize] += 1;
    }
  }

  /// Sum one source row of `src_width * channels` bytes. [`Mode::Gray`] or
  /// [`Mode::Rgba`].
  pub(crate) fn push_row(&mut self, row: &[u8]) {
    if self.y >= self.src_height {
      return;
    }
    let ch = self.mode.channels();
    for (x, px) in row
      .chunks_exact(ch)
      .take(self.src_width as usize)
      .enumerate()
    {
      let o = self.col[x] as usize * ch;
      for (a, &v) in self.acc[o..o + ch].iter_mut().zip(px) {
        *a += u64::from(v);
      }
    }
    self.end_row();
  }

  /// Close the current source row, writing an output row when it was the last one
  /// mapping to it.
  pub(crate) fn end_row(&mut self) {
    if self.y >= self.src_height {
      return;
    }
    self.acc_rows += 1;
    self.y += 1;
    let next = u64::from(self.y) * u64::from(self.out_height) / u64::from(self.src_height);
    if next as u32 != self.out_y || self.y == self.src_height {
      self.flush();
    }
  }

  fn flush(&mut self) {
    let rows = self.acc_rows.max(1);
    let start = self.out_y as usize * self.out_width as usize * 4;
    let line = &mut self.out[start..start + self.out_width as usize * 4];
    for (o, px) in line.as_chunks_mut::<4>().0.iter_mut().enumerate() {
      let area = u64::from(self.col_count[o]) * u64::from(rows);
      let mean = |sum: u64| ((sum + area / 2) / area).min(255) as u8;
      match self.mode {
        Mode::Ink => {
          let v = 255 - mean(self.acc[o] * 255);
          *px = [v, v, v, 255];
        }
        Mode::Gray => {
          let v = mean(self.acc[o]);
          *px = [v, v, v, 255];
        }
        Mode::Rgba => {
          for (c, p) in px.iter_mut().enumerate() {
            *p = mean(self.acc[o * 4 + c]);
          }
        }
      }
    }
    self.acc.fill(0);
    self.acc_rows = 0;
    self.out_y += 1;
  }

  pub(crate) fn finish(self) -> Bitmap {
    Bitmap {
      width: self.out_width,
      height: self.out_height,
      stride: self.out_width * 4,
      format: PixelFormat::Rgba8,
      data: self.out,
    }
  }
}

/// The largest size within `max_pixels` and `max_width` that keeps the aspect ratio,
/// never larger than the source.
pub(crate) fn fit(width: u32, height: u32, max_pixels: u64, max_width: Option<u32>) -> (u32, u32) {
  let area = u64::from(width) * u64::from(height);
  let mut scale = if area > max_pixels {
    (max_pixels as f64 / area as f64).sqrt()
  } else {
    1.0
  };
  if let Some(w) = max_width {
    scale = scale.min(f64::from(w.max(1)) / f64::from(width));
  }
  let side = |n: u32| ((f64::from(n) * scale).floor() as u32).clamp(1, n);
  let (w, h) = (side(width), side(height));
  // A side clamped up to one pixel gives the area back to the other: a 100000x1 strip
  // under a 10-pixel cap is 10x1, not 1000x1.
  let w = w.min(
    u32::try_from(max_pixels / u64::from(h))
      .unwrap_or(u32::MAX)
      .max(1),
  );
  let h = h.min(
    u32::try_from(max_pixels / u64::from(w))
      .unwrap_or(u32::MAX)
      .max(1),
  );
  (w, h)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fit_keeps_small_images_whole() {
    assert_eq!(fit(70, 50, 16_000_000, None), (70, 50));
  }

  #[test]
  fn fit_caps_area_and_width() {
    let (w, h) = fit(13200, 10200, 16_000_000, None);
    assert!(u64::from(w) * u64::from(h) <= 16_000_000);
    assert_eq!((w, h), (4550, 3516));
    assert_eq!(fit(13200, 10200, 16_000_000, Some(660)), (660, 510));
  }

  #[test]
  fn fit_never_reaches_zero() {
    assert_eq!(fit(100_000, 1, 10, None), (10, 1));
  }

  #[test]
  fn averages_exactly() {
    // 4x2 grey to 2x1: each output pixel is the mean of a 2x2 block.
    let mut d = Downsampler::new(Mode::Gray, (4, 2), (2, 1));
    d.push_row(&[0, 100, 200, 200]);
    d.push_row(&[0, 100, 0, 0]);
    let b = d.finish();
    assert_eq!(&b.data[..], &[50, 50, 50, 255, 100, 100, 100, 255]);
  }

  #[test]
  fn ink_is_coverage() {
    // A quarter of a 2x2 cell black reads as 75% white.
    let mut d = Downsampler::new(Mode::Ink, (2, 2), (1, 1));
    d.ink(0);
    d.end_row();
    d.end_row();
    assert_eq!(d.finish().data[0], 191);
  }

  #[test]
  fn rows_never_delivered_stay_white() {
    let mut d = Downsampler::new(Mode::Gray, (1, 2), (1, 2));
    d.push_row(&[0]);
    assert_eq!(d.remaining(), 1);
    assert_eq!(&d.finish().data[..], &[0, 0, 0, 255, 255, 255, 255, 255]);
  }
}
