//! Engine-agnostic types and traits for papyra.
//!
//! This crate deliberately has no knowledge of any specific PDF backend. Backends
//! (`papyra-hayro`, and potentially a native-only pdfium backend later) implement
//! [`Engine`] so the binding layers can stay backend-agnostic.

use std::fmt::Debug;

#[derive(Debug, thiserror::Error)]
pub enum PapyraError {
  #[error("failed to parse PDF: {0}")]
  Parse(String),
  #[error("page {0} out of range")]
  PageOutOfRange(usize),
  #[error("unsupported: {0}")]
  Unsupported(String),
}

pub type Result<T> = std::result::Result<T, PapyraError>;

/// Pixel layout of a rendered bitmap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
  Rgba8,
  Bgra8,
}

/// A rendered page bitmap. `data` is `height * stride` bytes.
#[derive(Debug, Clone)]
pub struct Bitmap {
  pub width: u32,
  pub height: u32,
  pub stride: u32,
  pub format: PixelFormat,
  pub data: Vec<u8>,
}

/// Page dimensions in PDF points (1/72 inch).
#[derive(Debug, Clone, Copy)]
pub struct PageSize {
  pub width: f32,
  pub height: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct RenderOptions {
  /// Uniform scale factor applied to the page's natural point size.
  /// `1.0` == 72 DPI. For 150 DPI pass `150.0 / 72.0`.
  pub scale: f32,
  /// Render onto opaque white rather than transparent.
  pub white_background: bool,
}

impl Default for RenderOptions {
  fn default() -> Self {
    Self {
      scale: 1.0,
      white_background: true,
    }
  }
}

impl RenderOptions {
  pub fn at_dpi(dpi: f32) -> Self {
    Self {
      scale: dpi / 72.0,
      ..Default::default()
    }
  }
}

/// A loaded PDF document.
pub trait Document: Debug {
  fn page_count(&self) -> usize;
  fn page_size(&self, index: usize) -> Result<PageSize>;
  fn render_page(&self, index: usize, opts: &RenderOptions) -> Result<Bitmap>;
}

/// A PDF backend.
pub trait Engine {
  type Doc: Document;

  /// Human-readable backend name, e.g. `"hayro"`.
  fn name() -> &'static str;

  /// Load a document from an owned byte buffer.
  fn load(data: Vec<u8>) -> Result<Self::Doc>;
}
