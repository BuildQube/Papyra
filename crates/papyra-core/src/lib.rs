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
  #[error("failed to encode image: {0}")]
  Encode(String),
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

  /// The document outline (bookmarks), in pre-order. Empty when there is none, which
  /// is the common case.
  ///
  /// Defaulted because an outline is optional for an engine in a way that rendering is
  /// not: a backend that cannot read one should not be prevented from existing.
  fn outline(&self) -> Vec<OutlineItem> {
    Vec::new()
  }

  /// Extract the text of one page.
  ///
  /// Defaulted for the same reason as [`Self::outline`]: an engine that cannot read
  /// text should still be able to render.
  fn page_text(&self, index: usize) -> Result<PageText> {
    let _ = index;
    Err(PapyraError::Unsupported("text extraction".to_string()))
  }
}

/// A PDF backend.
pub trait Engine {
  type Doc: Document;

  /// Human-readable backend name, e.g. `"hayro"`.
  fn name() -> &'static str;

  /// Load a document from an owned byte buffer.
  fn load(data: Vec<u8>) -> Result<Self::Doc>;
}

/// Where an outline entry points, once resolved against this document.
///
/// The view is kept because a bookmark is frequently a position on a page rather than
/// the page itself — a section heading two thirds of the way down. A viewer that only
/// honours `page_index` scrolls to the wrong place on exactly the documents where an
/// outline is most useful.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Destination {
  /// 0-based page index.
  pub page_index: usize,
  pub view: DestinationView,
}

/// The `/XYZ`, `/Fit`, … part of a destination array (PDF 32000-1, 12.3.2.2).
///
/// Coordinates are in PDF points from the bottom-left of the page. `None` means "leave
/// this axis as it is", which the spec encodes as a null in the destination array.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DestinationView {
  /// Top-left corner plus zoom. A zoom of `Some(0.0)` also means "unchanged".
  XyZ {
    left: Option<f32>,
    top: Option<f32>,
    zoom: Option<f32>,
  },
  /// Fit the whole page.
  Fit,
  /// Fit the width, positioning `top` at the top of the window.
  FitH { top: Option<f32> },
  /// Fit the height, positioning `left` at the left of the window.
  FitV { left: Option<f32> },
  /// Fit the given rectangle.
  FitR {
    left: f32,
    bottom: f32,
    right: f32,
    top: f32,
  },
  /// Fit the bounding box of the page's contents.
  FitB,
  /// Fit the bounding box's width.
  FitBH { top: Option<f32> },
  /// Fit the bounding box's height.
  FitBV { left: Option<f32> },
}

/// One entry in the document outline, in pre-order.
///
/// Flat rather than nested: `level` carries the tree, and callers that want a tree can
/// rebuild it in one pass. A flat list crosses an FFI boundary without recursive type
/// generation, and pre-order is the order a table of contents is read in anyway.
#[derive(Debug, Clone, PartialEq)]
pub struct OutlineItem {
  pub title: String,
  /// Nesting depth. Top-level bookmarks are 0.
  pub level: usize,
  /// `None` for a pure container — a folder with children but no destination of its
  /// own — and for destinations that leave this document (`GoToR`, `URI`).
  pub dest: Option<Destination>,
  /// `/F` bit 2 — the viewer should render the title bold.
  pub bold: bool,
  /// `/F` bit 1 — italic.
  pub italic: bool,
  /// `/Count` was positive, meaning the entry should start expanded.
  pub open: bool,
}

/// A run of glyphs sharing one baseline.
///
/// Geometry is stored along the baseline rather than as per-character rectangles: a
/// page of text is thousands of glyphs, and four floats each is an order of magnitude
/// more data than a search needs. One origin, one direction and a list of distances
/// reconstructs any substring's quadrilateral exactly, rotated text included.
#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
  pub text: String,
  /// Distance along the baseline from [`Self::x`], [`Self::y`] to the start of each
  /// `char`, plus the end of the last. `text.chars().count() + 1` entries.
  pub offsets: Vec<f32>,
  /// Start of the baseline.
  pub x: f32,
  pub y: f32,
  /// Unit vector along the baseline. `(1, 0)` for ordinary horizontal text.
  pub dx: f32,
  pub dy: f32,
  /// Extent above the baseline, perpendicular to it.
  pub ascent: f32,
  /// Extent below the baseline.
  pub descent: f32,
}

/// Every line of text on one page.
///
/// Coordinates are the page as rendered at 72 DPI: pixels from the top-left corner
/// with y increasing downwards, page rotation and crop box already applied. They are
/// therefore the same space as [`PageSize`], and scaling to any other render is a
/// single multiply — `dpi / 72.0`, or `fit_width / page_width`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PageText {
  pub lines: Vec<TextLine>,
  /// Glyphs the page drew that no encoding could map back to Unicode.
  ///
  /// This separates cases a caller otherwise cannot tell apart, all of which look
  /// like "no results":
  ///
  /// - lines, zero here — fully searchable.
  /// - lines *and* a non-zero count — partly readable. A paper whose headings use a
  ///   standard font and whose body uses an embedded subset with no `ToUnicode` cmap
  ///   lands here, and it is the case worth warning about: the page looks searchable
  ///   and mostly is not.
  /// - no lines, non-zero here — the page draws text nothing can map. Visible,
  ///   unsearchable, and retrying will not change that.
  /// - neither — the page has no text at all. It may be a scan, and OCR would help.
  ///
  /// Compare it against the characters actually extracted rather than reading it on
  /// its own; a handful of undecodable ornaments is not the same as a lost paragraph.
  pub undecoded_glyphs: u32,
}
