#![deny(clippy::all)]

//! Node-API bindings for papyra.
//!
//! This layer stays deliberately primitive: raw pixels, explicit indices, no
//! ergonomics. `@build-qube/papyra` (TypeScript) owns `File`/`Blob` input, streaming
//! thumbnails, and picking the right concurrency strategy per runtime.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use papyra_core::{Document as _, Engine, RenderOptions};
use papyra_encode::EncodeOptions;
use papyra_hayro::{HayroDocument, HayroEngine};
use std::sync::Arc;

/// Default wasm heap pre-reservation in MiB — roughly 30 letter pages at 150 DPI.
#[cfg(target_family = "wasm")]
const DEFAULT_RESERVE_MB: u32 = 256;

#[cfg(target_family = "wasm")]
static HEAP_RESERVED: std::sync::Once = std::sync::Once::new();

#[napi(object)]
pub struct RenderedPage {
  pub width: u32,
  pub height: u32,
  pub stride: u32,
  /// Always `"rgba8"` for the hayro backend.
  pub format: String,
  pub data: Uint8Array,
}

#[napi(object)]
pub struct PageDimensions {
  /// Width in PDF points (1/72 inch).
  pub width: f64,
  /// Height in PDF points (1/72 inch).
  pub height: f64,
}

/// Container for encoded output. Every encoder here is pure Rust, which is what keeps
/// the wasm target buildable — so there is no lossy WebP and no AVIF.
#[napi(string_enum = "lowercase")]
pub enum ImageFormat {
  /// Lossless VP8L. ~3x smaller than PNG on page content, for about the same cost.
  WebP,
  /// Lossless, universally supported.
  Png,
  /// The only lossy option, and the only one with a quality knob. No alpha.
  Jpeg,
}

impl From<ImageFormat> for papyra_encode::ImageFormat {
  fn from(f: ImageFormat) -> Self {
    match f {
      ImageFormat::WebP => Self::WebP,
      ImageFormat::Png => Self::Png,
      ImageFormat::Jpeg => Self::Jpeg,
    }
  }
}

fn encode_opts(format: ImageFormat, quality: Option<u8>) -> EncodeOptions {
  EncodeOptions {
    format: format.into(),
    quality: quality.unwrap_or(80),
  }
}

fn to_rendered(bmp: papyra_core::Bitmap) -> RenderedPage {
  RenderedPage {
    width: bmp.width,
    height: bmp.height,
    stride: bmp.stride,
    format: "rgba8".to_string(),
    data: Uint8Array::new(bmp.data),
  }
}

fn map_err(e: papyra_core::PapyraError) -> Error {
  Error::new(Status::GenericFailure, e.to_string())
}

// ---------------------------------------------------------------- async tasks

/// One page, rendered off the JS thread.
pub struct RenderTask {
  doc: Arc<HayroDocument>,
  index: usize,
  dpi: f64,
}

impl Task for RenderTask {
  type Output = papyra_core::Bitmap;
  type JsValue = RenderedPage;

  fn compute(&mut self) -> Result<Self::Output> {
    self
      .doc
      .render_page(self.index, &RenderOptions::at_dpi(self.dpi as f32))
      .map_err(map_err)
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(to_rendered(out))
  }
}

/// A batch rendered with rayon, driven from one async-work slot.
///
/// Native only in practice: on wasm rayon's workers are Web Workers that the JS event
/// loop must create, so the TypeScript wrapper uses per-page tasks there instead.
pub struct RenderBatchTask {
  doc: Arc<HayroDocument>,
  indices: Vec<usize>,
  dpi: f64,
}

impl Task for RenderBatchTask {
  type Output = Vec<papyra_core::Bitmap>;
  type JsValue = Vec<RenderedPage>;

  fn compute(&mut self) -> Result<Self::Output> {
    self
      .doc
      .render_pages_parallel(&self.indices, &RenderOptions::at_dpi(self.dpi as f32))
      .map_err(map_err)
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(out.into_iter().map(to_rendered).collect())
  }
}

// ------------------------------------------------------------------- document

/// A rendered page kept in Rust, encoded on demand.
///
/// The pixels deliberately never cross into JS. A 42x30in drawing at 150 DPI is 6.5 MB
/// raw and a fraction of that encoded, so for export the raw buffer is pure overhead.
/// There is no accessor for it: use `renderPageAsync` when you want the pixels, this
/// when you want a file.
#[napi]
pub struct PageImage {
  bitmap: Arc<papyra_core::Bitmap>,
}

#[napi]
impl PageImage {
  #[napi(getter)]
  pub fn width(&self) -> u32 {
    self.bitmap.width
  }

  #[napi(getter)]
  pub fn height(&self) -> u32 {
    self.bitmap.height
  }

  /// Size of the *raw* bitmap held in Rust. Encoded output is much smaller.
  #[napi(getter)]
  pub fn byte_length(&self) -> u32 {
    self.bitmap.data.len() as u32
  }

  /// Encode off the JS thread.
  #[napi(ts_return_type = "Promise<Uint8Array>")]
  pub fn encode(
    &self,
    format: ImageFormat,
    quality: Option<u8>,
    signal: Option<AbortSignal>,
  ) -> AsyncTask<EncodeTask> {
    AsyncTask::with_optional_signal(
      EncodeTask {
        bitmap: self.bitmap.clone(),
        opts: encode_opts(format, quality),
      },
      signal,
    )
  }

  /// Blocks the calling thread. Routed through the same `Task` as the async path so
  /// the two cannot drift.
  #[napi]
  pub fn encode_sync(&self, env: Env, format: ImageFormat, quality: Option<u8>) -> Result<Uint8Array> {
    let mut task = EncodeTask {
      bitmap: self.bitmap.clone(),
      opts: encode_opts(format, quality),
    };
    let out = task.compute()?;
    task.resolve(env, out)
  }

  /// Encode straight to a `data:` URL, so neither the pixels nor the encoded bytes
  /// cross the boundary — only the finished string does.
  #[napi(ts_return_type = "Promise<string>")]
  pub fn to_data_url(
    &self,
    format: ImageFormat,
    quality: Option<u8>,
    signal: Option<AbortSignal>,
  ) -> AsyncTask<DataUrlTask> {
    AsyncTask::with_optional_signal(
      DataUrlTask {
        bitmap: self.bitmap.clone(),
        opts: encode_opts(format, quality),
      },
      signal,
    )
  }
}

pub struct EncodeTask {
  bitmap: Arc<papyra_core::Bitmap>,
  opts: EncodeOptions,
}

impl Task for EncodeTask {
  type Output = Vec<u8>;
  // Uint8Array, not Buffer: `Buffer` goes through `napi_create_external_buffer`, which
  // under emnapi requires `globalThis.Buffer` and therefore throws in a browser. A
  // typed array is an external arraybuffer, which works on every target — the same
  // reason `RenderedPage.data` is one.
  type JsValue = Uint8Array;

  fn compute(&mut self) -> Result<Self::Output> {
    papyra_encode::encode(&self.bitmap, &self.opts).map_err(map_err)
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(Uint8Array::new(out))
  }
}

pub struct DataUrlTask {
  bitmap: Arc<papyra_core::Bitmap>,
  opts: EncodeOptions,
}

impl Task for DataUrlTask {
  type Output = String;
  type JsValue = String;

  fn compute(&mut self) -> Result<Self::Output> {
    papyra_encode::encode_to_data_url(&self.bitmap, &self.opts).map_err(map_err)
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(out)
  }
}

/// Render, then hand back a [`PageImage`] rather than the pixels.
pub struct RenderImageTask {
  doc: Arc<HayroDocument>,
  index: usize,
  dpi: f64,
}

impl Task for RenderImageTask {
  type Output = papyra_core::Bitmap;
  type JsValue = PageImage;

  fn compute(&mut self) -> Result<Self::Output> {
    self
      .doc
      .render_page(self.index, &RenderOptions::at_dpi(self.dpi as f32))
      .map_err(map_err)
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(PageImage {
      bitmap: Arc::new(out),
    })
  }
}

/// Encode pixels that are already in JS.
///
/// Costs one copy on the way in: a `Uint8Array` points at the JS heap and cannot be
/// held across the libuv threadpool boundary, so the task has to own its bytes. Prefer
/// `renderPageImageAsync` when you do not also need the raw pixels.
pub struct EncodeBufferTask {
  bitmap: papyra_core::Bitmap,
  opts: EncodeOptions,
}

impl Task for EncodeBufferTask {
  type Output = Vec<u8>;
  /// See [`EncodeTask`] — `Buffer` is unavailable in a browser.
  type JsValue = Uint8Array;

  fn compute(&mut self) -> Result<Self::Output> {
    papyra_encode::encode(&self.bitmap, &self.opts).map_err(map_err)
  }

  fn resolve(&mut self, _env: Env, out: Self::Output) -> Result<Self::JsValue> {
    Ok(Uint8Array::new(out))
  }
}

fn buffer_task(
  data: &Uint8Array,
  width: u32,
  height: u32,
  stride: u32,
  format: ImageFormat,
  quality: Option<u8>,
) -> EncodeBufferTask {
  EncodeBufferTask {
    bitmap: papyra_core::Bitmap {
      width,
      height,
      stride,
      format: papyra_core::PixelFormat::Rgba8,
      data: data.to_vec(),
    },
    opts: encode_opts(format, quality),
  }
}

/// Encode a raw RGBA8 buffer off the JS thread.
#[napi(ts_return_type = "Promise<Uint8Array>")]
pub fn encode_bitmap(
  data: Uint8Array,
  width: u32,
  height: u32,
  stride: u32,
  format: ImageFormat,
  quality: Option<u8>,
  signal: Option<AbortSignal>,
) -> AsyncTask<EncodeBufferTask> {
  AsyncTask::with_optional_signal(
    buffer_task(&data, width, height, stride, format, quality),
    signal,
  )
}

/// Blocks the calling thread. Same `Task` as [`encode_bitmap`].
#[napi]
pub fn encode_bitmap_sync(
  env: Env,
  data: Uint8Array,
  width: u32,
  height: u32,
  stride: u32,
  format: ImageFormat,
  quality: Option<u8>,
) -> Result<Uint8Array> {
  let mut task = buffer_task(&data, width, height, stride, format, quality);
  let out = task.compute()?;
  task.resolve(env, out)
}

#[napi]
pub struct PdfDocument {
  inner: Arc<HayroDocument>,
}

#[napi]
impl PdfDocument {
  /// Load a PDF from raw bytes.
  #[napi(factory)]
  pub fn load(data: Uint8Array) -> Result<Self> {
    ensure_heap_reserved();
    let inner = HayroEngine::load(data.to_vec()).map_err(map_err)?;
    Ok(Self {
      inner: Arc::new(inner),
    })
  }

  /// Load an encrypted PDF.
  #[napi(factory)]
  pub fn load_with_password(data: Uint8Array, password: String) -> Result<Self> {
    ensure_heap_reserved();
    let inner = HayroDocument::load_with_password(data.to_vec(), &password).map_err(map_err)?;
    Ok(Self {
      inner: Arc::new(inner),
    })
  }

  #[napi(getter)]
  pub fn page_count(&self) -> u32 {
    self.inner.page_count() as u32
  }

  #[napi]
  pub fn page_size(&self, index: u32) -> Result<PageDimensions> {
    let s = self.inner.page_size(index as usize).map_err(map_err)?;
    Ok(PageDimensions {
      width: s.width as f64,
      height: s.height as f64,
    })
  }

  /// Render one page on the calling thread. Blocks; prefer `renderPageAsync`.
  #[napi]
  pub fn render_page(&self, index: u32, dpi: Option<f64>) -> Result<RenderedPage> {
    let opts = RenderOptions::at_dpi(dpi.unwrap_or(72.0) as f32);
    self
      .inner
      .render_page(index as usize, &opts)
      .map(to_rendered)
      .map_err(map_err)
  }

  /// Render one page off the JS thread. Several of these run concurrently.
  #[napi(ts_return_type = "Promise<RenderedPage>")]
  pub fn render_page_async(&self, index: u32, dpi: Option<f64>) -> AsyncTask<RenderTask> {
    AsyncTask::new(RenderTask {
      doc: self.inner.clone(),
      index: index as usize,
      dpi: dpi.unwrap_or(72.0),
    })
  }

  /// Render one page and keep it in Rust, for encoding. The pixels never reach JS.
  #[napi(ts_return_type = "Promise<PageImage>")]
  pub fn render_page_image_async(
    &self,
    index: u32,
    dpi: Option<f64>,
    signal: Option<AbortSignal>,
  ) -> AsyncTask<RenderImageTask> {
    AsyncTask::with_optional_signal(
      RenderImageTask {
        doc: self.inner.clone(),
        index: index as usize,
        dpi: dpi.unwrap_or(72.0),
      },
      signal,
    )
  }

  /// Render `[start, end)` in one async task, parallelised internally with rayon.
  #[napi(ts_return_type = "Promise<Array<RenderedPage>>")]
  pub fn render_pages_async(
    &self,
    start: u32,
    end: u32,
    dpi: Option<f64>,
  ) -> AsyncTask<RenderBatchTask> {
    AsyncTask::new(RenderBatchTask {
      doc: self.inner.clone(),
      indices: (start as usize..end as usize).collect(),
      dpi: dpi.unwrap_or(72.0),
    })
  }
}

// -------------------------------------------------------------------- runtime

/// `"native"` or `"wasm"`. The wrapper uses this to pick a concurrency strategy.
#[napi]
pub fn runtime() -> &'static str {
  if cfg!(target_family = "wasm") {
    "wasm"
  } else {
    "native"
  }
}

/// Name of the rendering backend, currently always `"hayro"`.
#[napi]
pub fn backend_name() -> &'static str {
  HayroEngine::name()
}

/// Size the rayon pool used by `renderPagesAsync`.
///
/// Required on wasm: `available_parallelism()` is unsupported there, so rayon otherwise
/// pins itself to a single thread. Must be called before any other rayon use — the
/// global pool can only be built once.
#[napi]
pub fn configure_thread_pool(threads: u32, stack_size_mb: Option<u32>) -> Result<u32> {
  let mut b = rayon::ThreadPoolBuilder::new().num_threads(threads as usize);
  if let Some(mb) = stack_size_mb {
    b = b.stack_size(mb as usize * 1024 * 1024);
  }
  b.build_global()
    .map_err(|e| Error::new(Status::GenericFailure, format!("thread pool: {e}")))?;
  Ok(rayon::current_num_threads() as u32)
}

/// Grow the wasm heap up front, from the calling (single) thread.
///
/// Linear memory grows via `memory.grow`; several render workers hitting that on a cold
/// heap traps intermittently with "memory access out of bounds" (~14% of cold runs at 23
/// pages / 150 DPI / 8-way). Growing once, single-threaded, makes later allocations come
/// from the free list. Called automatically on first load; call it explicitly only to
/// raise the reservation before rendering something unusually large. No-op on native.
#[napi]
pub fn reserve_memory(megabytes: u32) -> u32 {
  #[cfg(target_family = "wasm")]
  {
    reserve_heap(megabytes);
    HEAP_RESERVED.call_once(|| {});
    megabytes
  }
  #[cfg(not(target_family = "wasm"))]
  {
    let _ = megabytes;
    0
  }
}

#[cfg(target_family = "wasm")]
fn reserve_heap(megabytes: u32) {
  let bytes = megabytes as usize * 1024 * 1024;
  let mut v: Vec<u8> = vec![0u8; bytes];
  // Touch one byte per 64 KiB wasm page so the pages are genuinely committed.
  let mut i = 0;
  while i < bytes {
    v[i] = 1;
    i += 65536;
  }
  std::hint::black_box(&v);
  drop(v);
}

#[cfg(target_family = "wasm")]
fn ensure_heap_reserved() {
  HEAP_RESERVED.call_once(|| reserve_heap(DEFAULT_RESERVE_MB));
}

#[cfg(not(target_family = "wasm"))]
fn ensure_heap_reserved() {}
