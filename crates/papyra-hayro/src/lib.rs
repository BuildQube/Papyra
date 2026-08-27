//! hayro-backed implementation of the papyra engine traits.

mod dest;
#[cfg(test)]
mod fixtures;
mod info;
mod links;
mod outline;
mod strings;
mod text;

pub use info::{read_metadata, read_page_labels};
pub use links::read_links;
pub use outline::read_outline;
pub use text::extract as extract_text;

use hayro::{RenderCache, RenderSettings};
use hayro_interpret::InterpreterSettings;
use hayro_syntax::{DecryptionError, LoadPdfError, Pdf};
use papyra_core::{
  Bitmap, Document, Engine, Link, Metadata, OutlineItem, PageSize, PageText, PapyraError,
  PixelFormat, RenderOptions, Result,
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
    let interp = InterpreterSettings::default();
    let settings = render_settings(opts);

    indices
      .iter()
      .map(|&i| {
        let page = pages.get(i).ok_or(PapyraError::PageOutOfRange(i))?;
        Ok(to_bitmap(hayro::render(page, &cache, &interp, &settings)))
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
    let interp = InterpreterSettings::default();
    let settings = render_settings(opts);

    indices
      .par_iter()
      .map_init(RenderCache::new, |cache, &i| {
        let page = pages.get(i).ok_or(PapyraError::PageOutOfRange(i))?;
        Ok(to_bitmap(hayro::render(page, cache, &interp, &settings)))
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

fn render_settings(opts: &RenderOptions) -> RenderSettings {
  RenderSettings {
    x_scale: opts.scale,
    y_scale: opts.scale,
    width: None,
    height: None,
    bg_color: if opts.white_background {
      hayro::vello_cpu::color::palette::css::WHITE
    } else {
      hayro::vello_cpu::color::palette::css::TRANSPARENT
    },
  }
}

fn to_bitmap(pixmap: hayro::vello_cpu::Pixmap) -> Bitmap {
  let width = pixmap.width() as u32;
  let height = pixmap.height() as u32;
  Bitmap {
    width,
    height,
    stride: width * 4,
    format: PixelFormat::Rgba8,
    data: bytemuck::cast_vec::<_, u8>(pixmap.take_unpremultiplied()),
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

  fn render_page(&self, index: usize, opts: &RenderOptions) -> Result<Bitmap> {
    let pages = self.pdf.pages();
    let page = pages.get(index).ok_or(PapyraError::PageOutOfRange(index))?;
    let cache = RenderCache::new();
    Ok(to_bitmap(hayro::render(
      page,
      &cache,
      &InterpreterSettings::default(),
      &render_settings(opts),
    )))
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
