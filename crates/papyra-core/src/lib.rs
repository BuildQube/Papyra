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
  /// The document is encrypted and no password was supplied.
  ///
  /// Separate from [`Self::IncorrectPassword`] because a viewer's response differs:
  /// this one asks, that one says the answer was wrong. The underlying engine need
  /// not tell them apart — knowing whether *we* passed a password is enough.
  #[error("this PDF is password-protected")]
  PasswordRequired,
  /// A password was supplied and it did not open the document.
  #[error("the supplied password is incorrect")]
  IncorrectPassword,
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
  /// Draw annotation appearance streams — links, highlights, stamps, filled form
  /// fields — on top of the page content.
  ///
  /// On by default, matching what a PDF viewer is expected to show. Turn it off when
  /// something else is drawing them: a viewer that paints its own highlight layer over
  /// the bitmap otherwise draws every annotation twice.
  ///
  /// This is a single switch rather than a mode, because that is all the engine layer
  /// can promise — an engine either draws annotations or it does not. Distinctions
  /// like "forms but not their stored values" belong to a PDF writer.
  pub annotations: bool,
}

impl Default for RenderOptions {
  fn default() -> Self {
    Self {
      scale: 1.0,
      white_background: true,
      annotations: true,
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

  /// Convert one page to a standalone SVG document.
  ///
  /// Defaulted for the same reason as [`Self::outline`]. [`RenderOptions::scale`] has
  /// no meaning here — an SVG carries the page's own dimensions and rasterises at
  /// whatever size it is drawn — so only `white_background` and
  /// [`RenderOptions::annotations`] are read.
  fn page_svg(&self, index: usize, opts: &RenderOptions) -> Result<String> {
    let _ = (index, opts);
    Err(PapyraError::Unsupported("SVG conversion".to_string()))
  }

  /// The document information dictionary. Every field is independently optional.
  ///
  /// Defaulted for the same reason as [`Self::outline`].
  fn metadata(&self) -> Metadata {
    Metadata::default()
  }

  /// The PDF specification version the file declares, e.g. `"1.7"`.
  ///
  /// Not part of [`Self::metadata`]: the information dictionary is what the producer
  /// chose to say about the document, while this is a structural property of the file
  /// read from its header and catalog.
  fn pdf_version(&self) -> Option<String> {
    None
  }

  /// The links on one page, in the order the document lists them.
  ///
  /// Empty is the common and correct answer for most pages, so this is defaulted
  /// rather than an `Unsupported` error: a backend without link support behaves like
  /// a document without links, which every caller already handles.
  fn page_links(&self, index: usize) -> Result<Vec<Link>> {
    let _ = index;
    Ok(Vec::new())
  }

  /// The document's page labels — the numbering printed on the page, which is not
  /// the index.
  ///
  /// One entry per page when the document defines `/PageLabels`, and **empty** when
  /// it does not. Empty rather than `["1", "2", ...]` so a caller can tell a document
  /// that asked for plain numbering from one that said nothing, and fall back to the
  /// index only in the second case.
  fn page_labels(&self) -> Vec<String> {
    Vec::new()
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

/// An axis-aligned rectangle in the page-as-rendered space described on [`PageText`].
///
/// Pixels from the top-left at 72 DPI, y increasing downwards, with page rotation and
/// the crop box already applied — the same space as [`PageSize`] and [`TextLine`], so
/// a hit region and a text highlight scale by the same single multiply.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
  pub x0: f32,
  pub y0: f32,
  pub x1: f32,
  pub y1: f32,
}

/// Where a link goes.
#[derive(Debug, Clone, PartialEq)]
pub enum LinkTarget {
  /// Somewhere in this document.
  Internal(Destination),
  /// A URI. Not validated, and not necessarily `http` — `mailto:` and `file:` are
  /// both common, and a viewer should decide for itself what it is willing to follow.
  Uri(String),
}

/// One link annotation: a rectangle on the page, and what activating it does.
///
/// Only links that resolve to something actionable are reported. A `/Link` whose
/// destination points at a page this document does not contain is dropped rather than
/// surfaced as a target that goes nowhere.
#[derive(Debug, Clone, PartialEq)]
pub struct Link {
  /// The clickable region.
  pub rect: Rect,
  pub target: LinkTarget,
  /// The annotation's `/Contents`, which for a link is its tooltip. Usually absent.
  pub alt: Option<String>,
}

/// The document information dictionary, decoded.
///
/// Every field is independently optional, and an empty string is reported as `None` —
/// producers write `/Author ()` often enough that the distinction is noise.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Metadata {
  pub title: Option<String>,
  pub author: Option<String>,
  pub subject: Option<String>,
  pub keywords: Option<String>,
  /// The application that authored the original document, e.g. `AutoCAD`.
  pub creator: Option<String>,
  /// The application that wrote the PDF itself, e.g. `Ghostscript`.
  pub producer: Option<String>,
  /// ISO 8601, converted from the PDF's own `D:YYYYMMDDHHmmSSOHH'mm` form.
  pub created: Option<String>,
  pub modified: Option<String>,
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
