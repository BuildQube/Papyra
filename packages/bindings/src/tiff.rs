//! TIFF pages, over `papyra-tiff`.
//!
//! Loading only walks the directory chain, which is microseconds even for a long fax,
//! but it is still a task: the bytes are copied in and the caller should not have to
//! know which half is cheap. A page decode is the real work — 80ms native for a
//! 300-dpi E-size sheet — and runs off the JS thread like a PDF render.

use crate::{RenderedPage, ensure_heap_reserved, to_rendered};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::Arc;

fn map_err(e: papyra_tiff::TiffError) -> Error {
  Error::new(Status::GenericFailure, e.to_string())
}

/// One page of a TIFF, as shown: `Orientation` already applied.
#[napi(object)]
pub struct TiffPageInfo {
  pub width: u32,
  pub height: u32,
  /// Horizontal resolution in dots per inch, when the file states one.
  pub x_dpi: Option<f64>,
  /// Vertical resolution in dots per inch, when the file states one.
  pub y_dpi: Option<f64>,
  /// `"none"`, `"ccitt-rle"`, `"ccitt-g3"`, `"ccitt-g4"`, `"lzw"`, `"old-jpeg"`,
  /// `"jpeg"`, `"deflate"`, `"packbits"` or `"other"`.
  pub compression: String,
  pub bits_per_sample: u32,
  pub samples_per_pixel: u32,
  /// TIFF `Orientation`, 1–8.
  pub orientation: u32,
}

/// Output limits for a page decode. Both optional; the page is never enlarged.
#[napi(object)]
pub struct TiffRenderOptions {
  /// Defaults to 4096 x 4096. A float on the JS side, so read as one.
  pub max_pixels: Option<f64>,
  pub max_width: Option<u32>,
}

pub struct LoadTiffTask {
  bytes: Option<Vec<u8>>,
}

impl Task for LoadTiffTask {
  type Output = papyra_tiff::Tiff;
  type JsValue = TiffImage;

  fn compute(&mut self) -> Result<Self::Output> {
    papyra_tiff::Tiff::load(self.bytes.take().unwrap_or_default()).map_err(map_err)
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(TiffImage {
      inner: Arc::new(out),
    })
  }
}

/// Open a TIFF and list its pages, off the JS thread.
#[napi(ts_return_type = "Promise<TiffImage>")]
pub fn load_tiff(data: Uint8Array) -> AsyncTask<LoadTiffTask> {
  ensure_heap_reserved();
  AsyncTask::new(LoadTiffTask {
    bytes: Some(data.to_vec()),
  })
}

#[napi]
pub struct TiffImage {
  inner: Arc<papyra_tiff::Tiff>,
}

#[napi]
impl TiffImage {
  /// Every page in directory order, reduced-resolution copies left out.
  #[napi(getter)]
  pub fn pages(&self) -> Vec<TiffPageInfo> {
    self
      .inner
      .pages()
      .iter()
      .map(|p| TiffPageInfo {
        width: p.width,
        height: p.height,
        x_dpi: p.dpi.map(|(x, _)| f64::from(x)),
        y_dpi: p.dpi.map(|(_, y)| f64::from(y)),
        compression: p.compression.as_str().to_string(),
        bits_per_sample: u32::from(p.bits_per_sample),
        samples_per_pixel: u32::from(p.samples_per_pixel),
        orientation: u32::from(p.orientation),
      })
      .collect()
  }

  /// Decode one page to RGBA at no more than the given size, off the JS thread.
  #[napi(ts_return_type = "Promise<RenderedPage>")]
  pub fn render_page(
    &self,
    index: u32,
    options: Option<TiffRenderOptions>,
  ) -> AsyncTask<RenderTiffTask> {
    let mut opts = papyra_tiff::RenderOptions::default();
    if let Some(o) = options {
      if let Some(n) = o.max_pixels.filter(|n| n.is_finite() && *n >= 1.0) {
        opts.max_pixels = n as u64;
      }
      opts.max_width = o.max_width;
    }
    AsyncTask::new(RenderTiffTask {
      tiff: self.inner.clone(),
      index: index as usize,
      opts,
    })
  }
}

pub struct RenderTiffTask {
  tiff: Arc<papyra_tiff::Tiff>,
  index: usize,
  opts: papyra_tiff::RenderOptions,
}

impl Task for RenderTiffTask {
  type Output = papyra_core::Bitmap;
  type JsValue = RenderedPage;

  fn compute(&mut self) -> Result<Self::Output> {
    self.tiff.render(self.index, &self.opts).map_err(map_err)
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(to_rendered(out))
  }
}
