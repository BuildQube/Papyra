//! Node-API surface for `papyra-office`: Word and PowerPoint pages.
//!
//! A separate addon from `papyra-bindings` on purpose. WordCraft and DeckCraft add
//! more wasm than the whole PDF stack, and a consumer who only renders PDFs should
//! download none of it. The cost of the split is that this addon has its own wasm
//! memory and its own worker pool, so `RenderedPage` and the heap reservation are
//! repeated here rather than shared.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::Arc;

/// Same shape as `papyra-bindings`' `RenderedPage`, so the wrapper's `paintToCanvas`
/// and `encode` take an office page unchanged.
#[napi(object)]
pub struct RenderedPage {
  pub width: u32,
  pub height: u32,
  pub stride: u32,
  /// Always `"rgba8"`.
  pub format: String,
  pub data: Uint8Array,
}

#[napi(object)]
pub struct PageDimensions {
  /// Width in points (1/72 inch).
  pub width: f64,
  /// Height in points (1/72 inch).
  pub height: f64,
}

fn map_err(e: papyra_office::OfficeError) -> Error {
  Error::new(Status::GenericFailure, e.to_string())
}

pub struct AddFontTask {
  bytes: Option<Vec<u8>>,
}

impl Task for AddFontTask {
  type Output = u32;
  type JsValue = u32;

  fn compute(&mut self) -> Result<Self::Output> {
    Ok(papyra_office::add_font(self.bytes.take().unwrap_or_default()) as u32)
  }

  fn resolve(&mut self, _env: Env, added: Self::Output) -> Result<Self::JsValue> {
    Ok(added)
  }
}

/// Register a TrueType or OpenType font with both engines, for documents opened
/// after this call. Resolves to the number of faces added: 0 when the bytes are not
/// a usable font, or every face in them was already registered.
///
/// A task, not a synchronous call, though it is quick: it takes each engine's global
/// font lock, which a worker laying out or rendering a page may hold. On
/// wasm32-wasip1-threads a contended lock is `memory.atomic.wait32`, which a browser
/// refuses on the main thread — the instance aborts. On a worker it just waits.
#[napi(ts_return_type = "Promise<number>")]
pub fn add_font(data: Uint8Array) -> AsyncTask<AddFontTask> {
  ensure_heap_reserved();
  AsyncTask::new(AddFontTask {
    bytes: Some(data.to_vec()),
  })
}

pub struct LoadOfficeTask {
  bytes: Option<Vec<u8>>,
}

impl Task for LoadOfficeTask {
  type Output = papyra_office::OfficeDocument;
  type JsValue = OfficeDocument;

  fn compute(&mut self) -> Result<Self::Output> {
    let bytes = self.bytes.take().unwrap_or_default();
    papyra_office::OfficeDocument::load(&bytes).map_err(map_err)
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(OfficeDocument {
      inner: Some(Arc::new(out)),
    })
  }
}

/// Read a `.docx` or `.pptx` and lay it out into pages, off the JS thread.
#[napi(ts_return_type = "Promise<OfficeDocument>")]
pub fn load_office(data: Uint8Array) -> AsyncTask<LoadOfficeTask> {
  ensure_heap_reserved();
  AsyncTask::new(LoadOfficeTask {
    bytes: Some(data.to_vec()),
  })
}

#[napi]
pub struct OfficeDocument {
  /// `None` once closed. Renders already running hold their own `Arc`, so the model
  /// is freed when the last of them finishes.
  inner: Option<Arc<papyra_office::OfficeDocument>>,
}

#[napi]
impl OfficeDocument {
  fn doc(&self) -> Result<&Arc<papyra_office::OfficeDocument>> {
    self
      .inner
      .as_ref()
      .ok_or_else(|| Error::new(Status::GenericFailure, "document is closed"))
  }

  /// `"word"` or `"slides"`.
  #[napi(getter)]
  pub fn kind(&self) -> Result<&'static str> {
    Ok(self.doc()?.kind().as_str())
  }

  #[napi(getter)]
  pub fn page_count(&self) -> Result<u32> {
    Ok(self.doc()?.page_count() as u32)
  }

  #[napi]
  pub fn page_size(&self, index: u32) -> Result<PageDimensions> {
    let s = self.doc()?.page_size(index as usize).map_err(map_err)?;
    Ok(PageDimensions {
      width: f64::from(s.width),
      height: f64::from(s.height),
    })
  }

  /// Draw one page at `scale` pixels per point, off the JS thread.
  #[napi(ts_return_type = "Promise<RenderedPage>")]
  pub fn render_page(&self, index: u32, scale: f64) -> Result<AsyncTask<RenderOfficeTask>> {
    Ok(AsyncTask::new(RenderOfficeTask {
      doc: self.doc()?.clone(),
      index: index as usize,
      scale: scale as f32,
    }))
  }

  /// Drop the laid-out document now rather than whenever the JS wrapper is collected.
  /// A deck's model and a Word document's pages live in the wasm heap, and growing a
  /// shared heap while workers run is what `ensure_heap_reserved` exists to avoid.
  /// Idempotent; every other method throws afterwards.
  #[napi]
  pub fn close(&mut self) {
    self.inner = None;
  }
}

pub struct RenderOfficeTask {
  doc: Arc<papyra_office::OfficeDocument>,
  index: usize,
  scale: f32,
}

impl Task for RenderOfficeTask {
  type Output = papyra_core::Bitmap;
  type JsValue = RenderedPage;

  fn compute(&mut self) -> Result<Self::Output> {
    self.doc.render(self.index, self.scale).map_err(map_err)
  }

  fn resolve(&mut self, _env: Env, bmp: Self::Output) -> Result<Self::JsValue> {
    Ok(RenderedPage {
      width: bmp.width,
      height: bmp.height,
      stride: bmp.stride,
      format: "rgba8".to_string(),
      data: Uint8Array::new(bmp.data),
    })
  }
}

/// The same pre-grow `papyra-bindings` does, for the same reason: concurrent workers
/// hitting `memory.grow` on a cold shared heap trap intermittently. This addon has
/// its own memory, so it needs its own reservation. 128 MiB rather than 256: a Word
/// page at 2x is ~8 MB of RGBA and nothing here holds a page at full PDF scale.
#[cfg(target_family = "wasm")]
fn ensure_heap_reserved() {
  static RESERVED: std::sync::Once = std::sync::Once::new();
  RESERVED.call_once(|| {
    let bytes = 128 * 1024 * 1024;
    let mut v: Vec<u8> = vec![0u8; bytes];
    let mut i = 0;
    while i < bytes {
      v[i] = 1;
      i += 65536;
    }
    std::hint::black_box(&v);
  });
}

#[cfg(not(target_family = "wasm"))]
fn ensure_heap_reserved() {}
