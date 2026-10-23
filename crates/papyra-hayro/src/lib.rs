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
  PapyraError, PixelFormat, RenderOptions, Result, StructNode, Tile,
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
        Ok(render(page, &cache, &interp, opts, None))
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
        Ok(render(page, cache, &interp, opts, None))
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

/// The whole page as a [`Tile`]. Floored the way `hayro::render` floors it.
fn full_page(page: &Page, opts: &RenderOptions) -> Tile {
  let (w, h) = page.render_dimensions();
  Tile {
    x: 0,
    y: 0,
    width: (w * opts.scale) as u16,
    height: (h * opts.scale) as u16,
  }
}

/// What `hayro::render` does, into a context the size of `tile` with the page
/// transform shifted so the tile's corner is the origin — the whole page when `tile`
/// is `None`. hayro culls nothing outside the context, so a tile costs about what the
/// page does — see Addendum 13.
fn render<'a>(
  page: &'a Page<'a>,
  cache: &RenderCache<'a>,
  interp: &InterpreterSettings,
  opts: &RenderOptions,
  tile: Option<Tile>,
) -> Bitmap {
  let Tile {
    x,
    y,
    width,
    height,
  } = tile.unwrap_or_else(|| full_page(page, opts));
  let mut ctx = RenderContext::new(width, height);
  hayro::render_into(
    page,
    cache,
    interp,
    &RenderSettings::default(),
    &mut ctx,
    Affine::translate((-f64::from(x), -f64::from(y)))
      * Affine::scale(f64::from(opts.scale))
      * page.initial_transform(true).to_kurbo(),
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
  fn render_one(&self, index: usize, opts: &RenderOptions, tile: Option<Tile>) -> Result<Bitmap> {
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
    self.render_one(index, opts, None)
  }

  fn render_tile(&self, index: usize, opts: &RenderOptions, tile: Tile) -> Result<Bitmap> {
    self.render_one(index, opts, Some(tile))
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

  /// Antialiased edges, a curve and a stroke, all crossing wherever a tile is cut.
  fn drawing() -> HayroDocument {
    HayroDocument {
      pdf: fixtures::page_with_content(
        "0 0 1 rg 50 50 m 560 700 l 300 90 l f \
         1 0 0 RG 3 w 20 400 m 200 760 590 20 600 380 c S \
         BT /F1 31 Tf 40 300 Td (Tiles) Tj ET",
      ),
    }
  }

  /// The pixels of `bitmap` inside `tile`, row by row.
  fn crop(bitmap: &Bitmap, tile: Tile) -> Vec<u8> {
    let (x, w) = (tile.x as usize * 4, tile.width as usize * 4);
    (tile.y..tile.y + u32::from(tile.height))
      .flat_map(|row| {
        let start = row as usize * bitmap.stride as usize + x;
        bitmap.data[start..start + w].iter().copied()
      })
      .collect()
  }

  /// A tile is the page cut where it sits, so tiles laid edge to edge meet with
  /// neither a seam nor an overlap, at a fractional scale and odd offsets. Within one
  /// level, not to the byte: away from the origin vello_cpu rounds a few edge
  /// coverages the other way (2-24 bytes of 160,000 here). A seam is 255.
  #[test]
  fn a_tile_is_the_page_cut_where_it_sits() {
    let doc = drawing();
    let opts = RenderOptions {
      scale: 1.37,
      ..Default::default()
    };
    let page = doc.render_page(0, &opts).unwrap();
    for tile in [
      Tile {
        x: 0,
        y: 0,
        width: 301,
        height: 257,
      },
      Tile {
        x: 301,
        y: 257,
        width: 250,
        height: 190,
      },
      Tile {
        x: 3,
        y: 600,
        width: 520,
        height: 4,
      },
    ] {
      let bitmap = doc.render_tile(0, &opts, tile).unwrap();
      assert_eq!((bitmap.width, bitmap.height), (tile.width.into(), tile.height.into()));
      let off = bitmap
        .data
        .iter()
        .zip(crop(&page, tile))
        .map(|(a, b)| a.abs_diff(b))
        .max()
        .unwrap();
      assert!(off <= 1, "{tile:?} is off by {off}");
    }
  }

  /// Full pages go through the tile path now; they must still be exactly what
  /// `hayro::render`, the path they replaced, draws.
  #[test]
  fn a_page_is_what_hayro_render_draws() {
    let doc = drawing();
    let pages = doc.pdf.pages();
    for (scale, white_background) in [(1.0, true), (2.3, false)] {
      let opts = RenderOptions {
        scale,
        white_background,
        ..Default::default()
      };
      let ours = doc.render_page(0, &opts).unwrap();
      let theirs = hayro::render(
        &pages[0],
        &RenderCache::new(),
        &interpreter_settings(&opts),
        &RenderSettings::default(),
        &hayro::PixmapSettings {
          x_scale: scale,
          y_scale: scale,
          bg_color: background(&opts),
        },
      );
      assert_eq!(
        (ours.width, ours.height),
        (theirs.width().into(), theirs.height().into())
      );
      assert!(ours.data == theirs.take_rgba8(ImageAlphaType::Alpha));
    }
  }

  #[test]
  fn a_tile_off_the_end_of_the_document_errors() {
    let tile = Tile {
      x: 0,
      y: 0,
      width: 8,
      height: 8,
    };
    assert!(
      drawing()
        .render_tile(1, &RenderOptions::default(), tile)
        .is_err()
    );
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
