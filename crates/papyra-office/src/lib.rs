//! Word and PowerPoint pages for papyra, over WordCraft (`.docx`) and DeckCraft
//! (`.pptx`).
//!
//! Both are clean-room, pure-Rust reimplementations that paginate the document
//! themselves and draw it with vello_cpu, so a page here is a laid-out page — what
//! Word would print — rather than HTML approximating one. That is what lets an office
//! page share `Bitmap` with a PDF page: `paintToCanvas`, `encode` and the thumbnails
//! take it unchanged.
//!
//! Like `papyra-tables` and `papyra-tiff`, this sits beside the PDF stack, not inside
//! it: neither engine has the text, link or outline readers the `Document` trait
//! describes. Unlike them it ships as its own addon, because the two engines cost
//! about as much wasm again as everything else papyra ships, and a PDF-only consumer
//! should not pay that.
//!
//! **Fonts decide the layout.** A document names Calibri; neither engine may ship it,
//! so each substitutes, and a substitute with different advance widths moves every
//! line break after it. Natively both engines also scan the system's fonts, so the
//! same file can paginate differently on two machines. In a browser there are no
//! system fonts at all, and the bundled fallback (Source Sans for Word, Ubuntu Light
//! for slides) is not metric-compatible with anything. [`add_font`] is the way out:
//! Carlito, Caladea and Liberation are metric-compatible with Calibri, Cambria and
//! Arial/Times, and both engines already prefer them by name.

use papyra_core::{Bitmap, PageSize, PixelFormat};

/// What an office file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeKind {
  /// A Word document, template, or their macro-enabled twins.
  Word,
  /// A PowerPoint deck, template or show.
  Slides,
}

impl OfficeKind {
  pub fn as_str(self) -> &'static str {
    match self {
      OfficeKind::Word => "word",
      OfficeKind::Slides => "slides",
    }
  }
}

#[derive(Debug, thiserror::Error)]
pub enum OfficeError {
  /// Not an OOXML package, or one whose main part is neither a Word document nor a
  /// presentation — a workbook, say, or a renamed zip.
  #[error("not a Word document or PowerPoint deck")]
  NotOffice,
  #[error("failed to read Word document: {0}")]
  Word(String),
  #[error("failed to read PowerPoint deck: {0}")]
  Slides(String),
  #[error("page {0} out of range")]
  PageOutOfRange(usize),
}

pub type Result<T> = std::result::Result<T, OfficeError>;

// Both models are boxed: each is over a kilobyte inline (a `Document` ~1.3 KB, a
// `Presentation` ~0.65 KB), and clippy will not have an enum carry either by value.
enum Inner {
  Word {
    doc: Box<wordcraft_doc::Document>,
    pages: Vec<wordcraft_layout::Page>,
  },
  Slides(Box<deckcraft_model::Presentation>),
}

/// An opened Word document or PowerPoint deck, laid out into pages.
pub struct OfficeDocument {
  inner: Inner,
}

/// The main part's content type is the only reliable discriminator: every OOXML
/// format is a zip with `[Content_Types].xml`, and nothing in the leading bytes
/// differs. Matched on the declared type rather than a part name, since writers may
/// name the main part anything.
fn sniff(bytes: &[u8]) -> Option<OfficeKind> {
  if !deckcraft_pptx::sniff(bytes) {
    return None;
  }
  let types = content_types(bytes)?;
  if types.contains("wordprocessingml.document.main")
    || types.contains("wordprocessingml.template.main")
    || types.contains("ms-word.document.macroEnabled.main")
    || types.contains("ms-word.template.macroEnabledTemplate.main")
  {
    Some(OfficeKind::Word)
  } else if types.contains("presentationml.presentation.main")
    || types.contains("presentationml.template.main")
    || types.contains("presentationml.slideshow.main")
    || types.contains("ms-powerpoint.presentation.macroEnabled.main")
    || types.contains("ms-powerpoint.template.macroEnabled.main")
    || types.contains("ms-powerpoint.slideshow.macroEnabled.main")
  {
    Some(OfficeKind::Slides)
  } else {
    None
  }
}

/// `[Content_Types].xml` is a few KB in any real file. The cap is what a declared
/// size cannot talk us past: it bounds the bytes actually inflated.
const MAX_CONTENT_TYPES: u64 = 1024 * 1024;

fn content_types(bytes: &[u8]) -> Option<String> {
  use std::io::Read;
  let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
  let file = zip.by_name("[Content_Types].xml").ok()?;
  let mut out = String::new();
  file.take(MAX_CONTENT_TYPES).read_to_string(&mut out).ok()?;
  Some(out)
}

impl OfficeDocument {
  /// Read and lay out a `.docx` or `.pptx`. A Word document is paginated here, so
  /// this is where its cost is: 30–140ms native for a two-page document.
  pub fn load(bytes: &[u8]) -> Result<Self> {
    let inner = match sniff(bytes).ok_or(OfficeError::NotOffice)? {
      OfficeKind::Word => {
        let doc = wordcraft_docx::read(bytes).map_err(|e| OfficeError::Word(e.to_string()))?;
        let mut cache = wordcraft_layout::LayoutCache::new();
        let layout = wordcraft_layout::layout(&doc, &mut cache, &Default::default());
        Inner::Word {
          doc: Box::new(doc),
          pages: layout.pages,
        }
      }
      OfficeKind::Slides => Inner::Slides(Box::new(
        deckcraft_pptx::import(bytes).map_err(|e| OfficeError::Slides(e.to_string()))?,
      )),
    };
    Ok(Self { inner })
  }

  pub fn kind(&self) -> OfficeKind {
    match self.inner {
      Inner::Word { .. } => OfficeKind::Word,
      Inner::Slides(_) => OfficeKind::Slides,
    }
  }

  /// Pages for a document, slides for a deck. Hidden slides are counted: they are in
  /// the file, and a viewer may want to show them marked.
  pub fn page_count(&self) -> usize {
    match &self.inner {
      Inner::Word { pages, .. } => pages.len(),
      Inner::Slides(p) => p.slides.len(),
    }
  }

  /// Page size in points. Every slide in a deck shares one size; a Word document's
  /// sections may each set their own.
  pub fn page_size(&self, index: usize) -> Result<PageSize> {
    match &self.inner {
      Inner::Word { pages, .. } => {
        let p = pages.get(index).ok_or(OfficeError::PageOutOfRange(index))?;
        Ok(PageSize {
          width: p.w,
          height: p.h,
        })
      }
      Inner::Slides(p) => {
        if index >= p.slides.len() {
          return Err(OfficeError::PageOutOfRange(index));
        }
        Ok(PageSize {
          width: p.slide_size.width as f32,
          height: p.slide_size.height as f32,
        })
      }
    }
  }

  /// Draw one page at `scale` pixels per point, as straight RGBA. Both engines clamp
  /// each side to 16,000 px; the 100 MP cap is the wrapper's, as it is for a PDF.
  pub fn render(&self, index: usize, scale: f32) -> Result<Bitmap> {
    let scale = if scale.is_finite() && scale > 0.0 {
      scale
    } else {
      1.0
    };
    let (width, height, data) = match &self.inner {
      Inner::Word { doc, pages } => {
        let page = pages.get(index).ok_or(OfficeError::PageOutOfRange(index))?;
        let r = wordcraft_render::render_page(doc, page, scale, &Default::default());
        (r.width, r.height, r.to_straight())
      }
      Inner::Slides(p) => {
        if index >= p.slides.len() {
          return Err(OfficeError::PageOutOfRange(index));
        }
        // One thread: DeckCraft's blur-based effects require it, and on wasm there
        // is no other kind. The page-level concurrency is the scheduler's.
        let opts = deckcraft_render::RenderOpts {
          scale: f64::from(scale),
          threads: 0,
          ..Default::default()
        };
        let img = deckcraft_render::render_slide(p, index, &opts);
        (img.width, img.height, img.to_straight())
      }
    };
    let mut data = data;
    data.resize(width as usize * height as usize * 4, 0);
    Ok(Bitmap {
      width,
      height,
      stride: width * 4,
      format: PixelFormat::Rgba8,
      data,
    })
  }
}

/// Make a font available to both engines, for every document opened **after** this
/// call — WordCraft caches each family's resolution, so a document already laid out
/// keeps the substitute it got. Returns how many faces the file held (a `.ttc` may
/// hold several); 0 means it was not a font either engine could read.
pub fn add_font(bytes: Vec<u8>) -> usize {
  let word = wordcraft_fonts::FontDb::global().add_font(bytes.clone());
  let slides = deckcraft_fonts::FontDb::global().add_font(bytes);
  word.max(slides)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn document_is_send_and_sync() {
    fn assert<T: Send + Sync>() {}
    assert::<OfficeDocument>();
  }

  #[test]
  fn rejects_non_zip() {
    assert!(matches!(
      OfficeDocument::load(b"%PDF-1.7"),
      Err(OfficeError::NotOffice)
    ));
  }
}
