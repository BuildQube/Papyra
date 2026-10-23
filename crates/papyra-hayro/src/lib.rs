//! hayro-backed implementation of the papyra engine traits.

mod attachments;
mod dest;
#[cfg(test)]
mod fixtures;
mod info;
mod links;
mod outline;
mod strings;
mod struct_tree;
mod text;

pub use info::{read_metadata, read_page_labels};
pub use links::read_links;
pub use outline::read_outline;
pub use text::extract as extract_text;

use hayro::vello_cpu::color::palette::css::{TRANSPARENT, WHITE};
use hayro::vello_cpu::color::{AlphaColor, Srgb};
use hayro::vello_cpu::peniko::ImageAlphaType;
use hayro::vello_cpu::{Pixmap, RasterizerSettings, RenderContext, Resources, TargetInit};
use hayro::{RenderCache, RenderSettings};
use hayro_interpret::InterpreterSettings;
use hayro_interpret::util::TransformExt;
use hayro_syntax::page::Page;
use hayro_syntax::{DecryptionError, LoadPdfError, Pdf};
use kurbo::Affine;
use papyra_core::{
  Attachment, Bitmap, Document, Engine, Link, Metadata, OutlineItem, PageSize, PageText,
  PapyraError, PixelFormat, RenderOptions, Result, StructNode,
};
use rayon::prelude::*;

pub struct HayroEngine;

pub struct HayroDocument {
  pdf: Pdf,
}

impl std::fmt::Debug for HayroDocument {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("HayroDocument")
      .field("pages", &self.page_count())
      .finish()
  }
}

impl Engine for HayroEngine {
  type Doc = HayroDocument;

  fn name() -> &'static str {
    "hayro"
  }

  fn load(data: Vec<u8>) -> Result<Self::Doc> {
    let pdf = Pdf::new(data).map_err(|e| load_error(e, false))?;
    Ok(HayroDocument { pdf })
  }
}

/// Turn hayro's load failure into ours.
///
/// hayro reports `PasswordProtected` both when no password was supplied and when the
/// supplied one was wrong — from inside the decryptor those are the same event. We
/// know which it was, because we know whether we passed one, and the two need
/// different responses from a viewer: one asks for a password, the other says the
/// answer was wrong.
fn load_error(error: LoadPdfError, had_password: bool) -> PapyraError {
  match error {
    LoadPdfError::Decryption(DecryptionError::PasswordProtected) if had_password => {
      PapyraError::IncorrectPassword
    }
    LoadPdfError::Decryption(DecryptionError::PasswordProtected) => PapyraError::PasswordRequired,
    other => PapyraError::Parse(format!("{other:?}")),
  }
}

impl HayroDocument {
  pub fn load_with_password(data: Vec<u8>, password: &str) -> Result<Self> {
    // An empty password is what `Pdf::new` passes anyway, so it cannot be the reason
    // a document opened — report it as no password rather than a wrong one.
    let pdf =
      Pdf::new_with_password(data, password).map_err(|e| load_error(e, !password.is_empty()))?;
    Ok(Self { pdf })
  }

  /// Render several pages sharing a single [`RenderCache`].
  ///
  /// hayro's cache is lifetime-bound to the borrowed document, so it cannot be
  /// stored inside `HayroDocument` without a self-referential wrapper. Batching
  /// is the cheap way to get the cache reuse hayro's docs recommend.
  pub fn render_pages(&self, indices: &[usize], opts: &RenderOptions) -> Result<Vec<Bitmap>> {
    let pages = self.pdf.pages();
    let cache = RenderCache::new();
    let interp = interpreter_settings(opts);

    indices
      .iter()
      .map(|&i| {
        let page = pages.get(i).ok_or(PapyraError::PageOutOfRange(i))?;
        Ok(render(page, &cache, &interp, opts, full_page(page, opts)))
      })
      .collect()
  }
}

impl HayroDocument {
  /// Render pages across a rayon thread pool.
  ///
  /// hayro's `RenderCache` is `Rc`-based and therefore not `Send`, so each worker
  /// thread builds its own via `map_init` and reuses it for every page it handles.
  pub fn render_pages_parallel(
    &self,
    indices: &[usize],
    opts: &RenderOptions,
  ) -> Result<Vec<Bitmap>> {
    let pages = self.pdf.pages();
    let interp = interpreter_settings(opts);

    indices
      .par_iter()
      .map_init(RenderCache::new, |cache, &i| {
        let page = pages.get(i).ok_or(PapyraError::PageOutOfRange(i))?;
        Ok(render(page, cache, &interp, opts, full_page(page, opts)))
      })
      .collect()
  }
}

impl HayroDocument {
  /// Extract the text of several pages across a rayon thread pool.
  ///
  /// Text extraction is interpretation without rasterisation, so it is the same order
  /// of cost as a render and deserves the same treatment: one async task on the JS
  /// side, the fan-out in Rust. Going through the JS thread pool instead would cap a
  /// whole-document index at libuv's four threads, which an addon cannot resize.
  pub fn page_texts_parallel(&self, indices: &[usize]) -> Result<Vec<PageText>> {
    let pages = self.pdf.pages();
    indices
      .par_iter()
      .map(|&i| {
        let page = pages.get(i).ok_or(PapyraError::PageOutOfRange(i))?;
        Ok(text::extract(page))
      })
      .collect()
  }
}

/// Interpreter settings for a render.
///
/// `InterpreterSettings::default()` is not cheap enough to be free — it allocates the
/// embedded font and cmap resolvers into `Arc`s — so batch paths build one and share
/// it across the batch rather than one per page.
fn interpreter_settings(opts: &RenderOptions) -> InterpreterSettings {
  InterpreterSettings {
    render_annotations: opts.annotations,
    ..InterpreterSettings::default()
  }
}

fn background(opts: &RenderOptions) -> AlphaColor<Srgb> {
  if opts.white_background {
    WHITE
  } else {
    TRANSPARENT
  }
}

/// hayro-svg takes a straight RGBA quadruple rather than a colour type. The background
/// is the only knob it carries from [`RenderOptions`] — an SVG has no resolution to
/// scale, and annotations are an interpreter setting rather than a render one.
fn svg_settings(opts: &RenderOptions) -> hayro_svg::SvgRenderSettings {
  hayro_svg::SvgRenderSettings {
    bg_color: if opts.white_background {
      [255, 255, 255, 255]
    } else {
      [0, 0, 0, 0]
    },
  }
}

/// A window of a page at `opts.scale`, in output pixels: the corner and the size.
pub type Tile = (f64, f64, u16, u16);

/// The whole page as a [`Tile`]. Floored the way `hayro::render` floors it.
fn full_page(page: &Page, opts: &RenderOptions) -> Tile {
  let (w, h) = page.render_dimensions();
  (0.0, 0.0, (w * opts.scale) as u16, (h * opts.scale) as u16)
}

/// What `hayro::render` does, into a context the size of `tile` with the page
/// transform shifted so the tile's corner is the origin. hayro culls nothing outside
/// the context, so a tile costs about what the page does — see Addendum 13.
fn render<'a>(
  page: &'a Page<'a>,
  cache: &RenderCache<'a>,
  interp: &InterpreterSettings,
  opts: &RenderOptions,
  (x, y, width, height): Tile,
) -> Bitmap {
  let scale = opts.scale as f64;
  let mut ctx = RenderContext::new(width, height);
  hayro::render_into(
    page,
    cache,
    interp,
    &RenderSettings::default(),
    &mut ctx,
    Affine::translate((-x, -y)) * Affine::scale(scale) * page.initial_transform(true).to_kurbo(),
  );
  ctx.flush();
  let mut pixmap = Pixmap::new(width, height);
  ctx.render_with(
    &mut pixmap,
    &mut Resources::default(),
    RasterizerSettings {
      target_init: TargetInit::Clear(background(opts)),
      ..Default::default()
    },
  );
  Bitmap {
    width: width as u32,
    height: height as u32,
    stride: width as u32 * 4,
    format: PixelFormat::Rgba8,
    data: pixmap.take_rgba8(ImageAlphaType::Alpha),
  }
}

impl HayroDocument {
  /// Render one window of a page. A tile may sit anywhere on a page whose full size
  /// is past both the 100 MP cap and hayro's `u16` side, which is what it is for.
  pub fn render_tile(&self, index: usize, opts: &RenderOptions, tile: Tile) -> Result<Bitmap> {
    let pages = self.pdf.pages();
    let page = pages.get(index).ok_or(PapyraError::PageOutOfRange(index))?;
    Ok(render(
      page,
      &RenderCache::new(),
      &interpreter_settings(opts),
      opts,
      tile,
    ))
  }
}

impl Document for HayroDocument {
  fn page_count(&self) -> usize {
    self.pdf.pages().len()
  }

  fn page_size(&self, index: usize) -> Result<PageSize> {
    let pages = self.pdf.pages();
    let page = pages.get(index).ok_or(PapyraError::PageOutOfRange(index))?;
    let (width, height) = page.render_dimensions();
    Ok(PageSize { width, height })
  }

  fn outline(&self) -> Vec<OutlineItem> {
    outline::read_outline(&self.pdf)
  }

  fn page_text(&self, index: usize) -> Result<PageText> {
    let pages = self.pdf.pages();
    let page = pages.get(index).ok_or(PapyraError::PageOutOfRange(index))?;
    Ok(text::extract(page))
  }

  fn page_svg(&self, index: usize, opts: &RenderOptions) -> Result<String> {
    let pages = self.pdf.pages();
    let page = pages.get(index).ok_or(PapyraError::PageOutOfRange(index))?;
    // hayro-svg keeps its own cache type, separate from `hayro::RenderCache` and with
    // the same borrow of the document — so it is per-call here for the same reason.
    let cache = hayro_svg::RenderCache::new();
    Ok(hayro_svg::convert(
      page,
      &cache,
      &interpreter_settings(opts),
      &svg_settings(opts),
    ))
  }

  fn metadata(&self) -> Metadata {
    info::read_metadata(&self.pdf)
  }

  fn pdf_version(&self) -> Option<String> {
    Some(info::version_string(self.pdf.version()))
  }

  fn page_links(&self, index: usize) -> Result<Vec<Link>> {
    links::read_links(&self.pdf, index)
  }

  fn page_labels(&self) -> Vec<String> {
    info::read_page_labels(&self.pdf)
  }

  fn struct_tree(&self) -> Vec<StructNode> {
    struct_tree::read_struct_tree(&self.pdf)
  }

  fn attachments(&self) -> Vec<Attachment> {
    attachments::read_attachments(&self.pdf)
  }

  fn attachment_data(&self, index: usize) -> Result<Vec<u8>> {
    attachments::read_attachment_data(&self.pdf, index)
  }

  fn render_page(&self, index: usize, opts: &RenderOptions) -> Result<Bitmap> {
    let pages = self.pdf.pages();
    let page = pages.get(index).ok_or(PapyraError::PageOutOfRange(index))?;
    Ok(render(
      page,
      &RenderCache::new(),
      &interpreter_settings(opts),
      opts,
      full_page(page, opts),
    ))
  }
}

#[cfg(test)]
mod thread_safety {
  use super::*;
  fn assert_send<T: Send>() {}
  fn assert_sync<T: Sync>() {}

  /// `render_pages_parallel` shares `&Pdf` across rayon workers. If hayro ever loses
  /// these bounds the parallel path is unsound, so assert them at compile time.
  #[test]
  fn pdf_is_send_and_sync() {
    assert_send::<hayro_syntax::Pdf>();
    assert_sync::<hayro_syntax::Pdf>();
    assert_send::<HayroDocument>();
    assert_sync::<HayroDocument>();
  }
}

#[cfg(test)]
mod render {
  use super::*;

  /// CAD stroke text draws a capital M as one open `m l l l l` polyline whose four
  /// corners are the corners of its bounding box. hayro-interpret 0.7's rectangle
  /// fast path matched any five-element path touching all four corners, so the M
  /// was stroked as a closed rectangle — a hollow box in place of every M.
  #[test]
  fn polyline_touching_its_bbox_corners_is_not_a_rect() {
    let doc = HayroDocument {
      pdf: fixtures::page_with_content("2 w 100 100 m 100 230 l 140 140 l 180 230 l 180 100 l S"),
    };
    let bitmap = doc.render_page(0, &RenderOptions::default()).unwrap();
    // Red channel at a point in PDF space; the page is 792pt tall and rendered at 1x.
    let red = |x: u32, y: u32| bitmap.data[((792 - y) * bitmap.stride + x * 4) as usize];

    assert!(red(140, 140) < 64, "the M's middle vertex is drawn");
    assert!(red(140, 230) > 192, "nothing joins the tops of its legs");
  }
}

#[cfg(test)]
mod svg {
  use super::*;
  use crate::fixtures::build_pdf;

  fn doc(content: &str) -> HayroDocument {
    let bytes = build_pdf(&[
      (1, "<< /Type /Catalog /Pages 2 0 R >>".to_string()),
      (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string()),
      (
        3,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>".to_string(),
      ),
      (
        4,
        format!(
          "<< /Length {} >>\nstream\n{content}\nendstream",
          content.len() + 1
        ),
      ),
    ]);
    HayroEngine::load(bytes).expect("fixture should load")
  }
  /// The viewBox has to be the page's own point size, or every consumer that scales
  /// the SVG to a container silently changes the drawing's proportions.
  #[test]
  fn svg_carries_the_page_geometry() {
    let svg = doc("1 0 0 rg 100 100 200 300 re f")
      .page_svg(0, &RenderOptions::default())
      .unwrap();

    assert!(svg.starts_with("<svg "), "{svg}");
    assert!(svg.contains(r#"viewBox="0 0 612 792""#), "{svg}");
    assert!(svg.trim_end().ends_with("</svg>"), "{svg}");
  }

  /// Filled paths must survive as paths — the whole point of SVG output is that the
  /// geometry is still geometry and not a raster of it.
  #[test]
  fn fills_stay_vector() {
    let svg = doc("1 0 0 rg 100 100 200 300 re f")
      .page_svg(0, &RenderOptions::default())
      .unwrap();

    // hayro-svg writes an axis-aligned rectangle as `<rect>`, anything else as `<path>`.
    assert!(svg.contains("<rect ") || svg.contains("<path "), "{svg}");
    assert!(svg.contains("#ff0000"), "{svg}");
    assert!(!svg.contains("<image "), "{svg}");
  }

  #[test]
  fn white_background_is_opt_out() {
    let d = doc("1 0 0 rg 100 100 200 300 re f");

    let opaque = d.page_svg(0, &RenderOptions::default()).unwrap();
    assert!(opaque.contains("background-color"), "{opaque}");

    let transparent = d
      .page_svg(
        0,
        &RenderOptions {
          white_background: false,
          ..Default::default()
        },
      )
      .unwrap();
    assert!(!transparent.contains("background-color"), "{transparent}");
  }

  /// `scale` is meaningless for a resolution-independent format, and quietly baking it
  /// into the viewBox would make the SVG disagree with the page it came from.
  #[test]
  fn scale_is_ignored() {
    let d = doc("1 0 0 rg 100 100 200 300 re f");
    let at_1x = d.page_svg(0, &RenderOptions::default()).unwrap();
    let at_4x = d
      .page_svg(
        0,
        &RenderOptions {
          scale: 4.0,
          ..Default::default()
        },
      )
      .unwrap();

    assert_eq!(at_1x, at_4x);
  }

  #[test]
  fn out_of_range_pages_error() {
    assert!(doc("").page_svg(7, &RenderOptions::default()).is_err());
  }
}
