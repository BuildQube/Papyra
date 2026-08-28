//! Reading link annotations.
//!
//! hayro *draws* annotations — `InterpreterSettings::render_annotations` is on by
//! default, so a link's border and any appearance stream already land in the bitmap —
//! but it exposes nothing about where they are or where they point. Without that a
//! viewer can show a link and cannot make it clickable, which is the whole feature.
//!
//! The targets themselves are resolved by [`crate::dest`], the same code the outline
//! uses: a link and a bookmark spell their destinations identically.

use crate::dest::Resolver;
use crate::strings::decode_non_empty;
use hayro_interpret::util::TransformExt;
use hayro_syntax::Pdf;
use hayro_syntax::object::String as PdfString;
use hayro_syntax::object::dict::keys;
use hayro_syntax::object::{Array, Dict, Name, Rect as PdfRect};
use hayro_syntax::page::Page;
use kurbo::Point;
use papyra_core::{Link, LinkTarget, PapyraError, Rect, Result};

/// `/F` bit 2 — the annotation should not be displayed at all.
const FLAG_HIDDEN: u32 = 1 << 1;

/// `/F` bit 6 — invisible on screen, though it may still print. A link the user
/// cannot see is not one they can click.
const FLAG_NO_VIEW: u32 = 1 << 5;

/// Ceiling on annotations read from one page.
///
/// Generous — a dense drawing index legitimately carries hundreds — but bounded, since
/// `/Annots` is attacker-controlled and every entry costs a name-tree lookup.
const MAX_LINKS_PER_PAGE: usize = 10_000;

/// Read the links on one page.
pub fn read_links(pdf: &Pdf, index: usize) -> Result<Vec<Link>> {
  let pages = pdf.pages();
  let page = pages.get(index).ok_or(PapyraError::PageOutOfRange(index))?;
  let Some(resolver) = Resolver::new(pdf) else {
    return Ok(Vec::new());
  };
  Ok(links_of(&resolver, page))
}

fn links_of<'a>(resolver: &Resolver<'a>, page: &'a Page<'a>) -> Vec<Link> {
  let Some(annots) = page.raw().get::<Array<'a>>(keys::ANNOTS) else {
    return Vec::new();
  };

  // The same transform the renderer and the text extractor use, so a hit region lands
  // on the pixels it belongs to. `/Rect` is in default user space — bottom-left
  // origin, no rotation — and deriving the mapping any other way puts every link a
  // quarter turn out on exactly the drawings that are rotated.
  let transform = page.initial_transform(true).to_kurbo();

  let mut links = Vec::new();
  for annot in annots.iter::<Dict<'a>>() {
    if links.len() >= MAX_LINKS_PER_PAGE {
      break;
    }

    if annot
      .get::<Name<'a>>(keys::SUBTYPE)
      .is_none_or(|subtype| &*subtype != b"Link")
    {
      continue;
    }

    let flags = annot.get::<u32>(keys::F).unwrap_or(0);
    if flags & (FLAG_HIDDEN | FLAG_NO_VIEW) != 0 {
      continue;
    }

    let Some(rect) = annot.get::<PdfRect>(keys::RECT) else {
      continue;
    };
    let Some(target) = target_of(resolver, &annot) else {
      continue;
    };

    links.push(Link {
      rect: map_rect(rect, transform),
      target,
      alt: annot
        .get::<PdfString>(keys::CONTENTS)
        .and_then(|contents| decode_non_empty(contents.as_bytes())),
    });
  }
  links
}

/// Where the link goes, or `None` if that is nowhere this document can honour.
///
/// A `/Link` whose `/GoTo` names a page the file does not contain, or whose action is
/// one we do not act on (`/GoToR`, `/Launch`, `/JavaScript`), is dropped rather than
/// reported as a target that does nothing — a viewer would draw a hand cursor over a
/// region that swallows the click.
fn target_of<'a>(resolver: &Resolver<'a>, annot: &Dict<'a>) -> Option<LinkTarget> {
  if let Some(dest) = resolver.resolve(annot) {
    return Some(LinkTarget::Internal(dest));
  }

  let action = annot.get::<Dict<'a>>(keys::A)?;
  if &*action.get::<Name<'a>>(keys::S)? != b"URI" {
    return None;
  }
  // A URI is nominally 7-bit ASCII, but producers write UTF-16 with a BOM often
  // enough that decoding it as a text string is the safer read.
  let uri = decode_non_empty(action.get::<PdfString>(keys::URI)?.as_bytes())?;
  Some(LinkTarget::Uri(uri))
}

/// Map an annotation rectangle into the page-as-rendered space.
///
/// The transform is a scale, a flip and at most a quarter turn, so the corners stay
/// axis-aligned and taking the extremes of the two mapped corners is exact rather
/// than a bounding-box approximation. Normalising afterwards also fixes the `/Rect`
/// written with its corners the wrong way round, which the spec permits.
fn map_rect(rect: PdfRect, transform: kurbo::Affine) -> Rect {
  let a = transform * Point::new(rect.x0, rect.y0);
  let b = transform * Point::new(rect.x1, rect.y1);
  Rect {
    x0: a.x.min(b.x) as f32,
    y0: a.y.min(b.y) as f32,
    x1: a.x.max(b.x) as f32,
    y1: a.y.max(b.y) as f32,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::fixtures::build_pdf;
  use papyra_core::DestinationView;
  use std::sync::Arc;

  /// A two-page document whose first page carries `annots`.
  ///
  /// Object 3 is page 0 and object 4 is page 1, matching the outline tests, so a
  /// destination pointing at `4 0 R` resolves to index 1.
  fn document(page_extra: &str, catalog_extra: &str, objects: &[(u32, &str)]) -> Vec<u8> {
    let mut all = vec![
      (
        1,
        format!("<< /Type /Catalog /Pages 2 0 R {catalog_extra} >>"),
      ),
      (
        2,
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>".to_string(),
      ),
      (
        3,
        format!(
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R {page_extra} >>"
        ),
      ),
      (
        4,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>".to_string(),
      ),
      (5, "<< /Length 0 >>\nstream\nendstream".to_string()),
    ];
    all.extend(objects.iter().map(|(n, body)| (*n, body.to_string())));
    build_pdf(&all)
  }

  fn links_of_page_zero(bytes: Vec<u8>) -> Vec<Link> {
    let pdf = Pdf::new(Arc::new(bytes)).expect("fixture should parse");
    read_links(&pdf, 0).expect("page 0 exists")
  }

  #[test]
  fn reads_an_internal_link() {
    let links = links_of_page_zero(document(
      "/Annots [6 0 R]",
      "",
      &[(
        6,
        "<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] /Dest [4 0 R /Fit] >>",
      )],
    ));
    assert_eq!(links.len(), 1);
    let LinkTarget::Internal(dest) = &links[0].target else {
      panic!("expected an internal link, got {:?}", links[0].target);
    };
    assert_eq!(dest.page_index, 1);
    assert_eq!(dest.view, DestinationView::Fit);
  }

  #[test]
  fn reads_a_uri_link() {
    let links = links_of_page_zero(document(
      "/Annots [6 0 R]",
      "",
      &[(
        6,
        "<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] \
         /A << /S /URI /URI (https://example.com/a) >> >>",
      )],
    ));
    assert_eq!(
      links[0].target,
      LinkTarget::Uri("https://example.com/a".to_string())
    );
  }

  #[test]
  fn resolves_a_named_destination_through_the_shared_resolver() {
    let links = links_of_page_zero(document(
      "/Annots [6 0 R]",
      "/Names 7 0 R",
      &[
        (
          6,
          "<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] /Dest (sheet.a101) >>",
        ),
        (7, "<< /Dests 8 0 R >>"),
        (8, "<< /Names [(sheet.a101) [4 0 R /Fit]] >>"),
      ],
    ));
    let LinkTarget::Internal(dest) = &links[0].target else {
      panic!("expected an internal link");
    };
    assert_eq!(dest.page_index, 1);
  }

  #[test]
  fn maps_the_rect_into_the_space_the_page_renders_in() {
    // `/Rect` is bottom-left origin; the render and text spaces are top-left with y
    // down. On a 792pt-tall page, y 700..720 becomes 72..92 from the top.
    let links = links_of_page_zero(document(
      "/Annots [6 0 R]",
      "",
      &[(
        6,
        "<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] /Dest [4 0 R /Fit] >>",
      )],
    ));
    let rect = links[0].rect;
    assert_eq!((rect.x0, rect.x1), (72.0, 200.0));
    assert_eq!((rect.y0, rect.y1), (72.0, 92.0));
  }

  #[test]
  fn follows_the_page_rotation() {
    // The hazard this guards: `/Rect` is in unrotated user space, so a rect mapped
    // any way but through `initial_transform` lands a quarter turn out on exactly
    // the drawings that are rotated. Under a quarter turn the box's width and height
    // swap, and it has to stay inside the rotated page.
    let bytes = build_pdf(&[
      (1, "<< /Type /Catalog /Pages 2 0 R >>".to_string()),
      (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string()),
      (
        3,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Contents 4 0 R \
         /Annots [5 0 R] >>"
          .to_string(),
      ),
      (4, "<< /Length 0 >>\nstream\nendstream".to_string()),
      (
        5,
        "<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] \
         /A << /S /URI /URI (https://example.com) >> >>"
          .to_string(),
      ),
    ]);
    let pdf = Pdf::new(Arc::new(bytes)).expect("fixture should parse");
    let rect = read_links(&pdf, 0).expect("page 0 exists")[0].rect;

    assert_eq!(rect.x1 - rect.x0, 20.0, "width takes the unrotated height");
    assert_eq!(rect.y1 - rect.y0, 128.0, "height takes the unrotated width");
    // The rotated page is 792 wide and 612 tall.
    assert!(
      rect.x0 >= 0.0 && rect.x1 <= 792.0 && rect.y0 >= 0.0 && rect.y1 <= 612.0,
      "{rect:?} fell outside the rotated page"
    );
  }

  #[test]
  fn normalises_a_rect_written_with_its_corners_reversed() {
    // The spec permits either order, and producers do write both.
    let links = links_of_page_zero(document(
      "/Annots [6 0 R]",
      "",
      &[(
        6,
        "<< /Type /Annot /Subtype /Link /Rect [200 720 72 700] /Dest [4 0 R /Fit] >>",
      )],
    ));
    let rect = links[0].rect;
    assert!(rect.x0 < rect.x1 && rect.y0 < rect.y1, "got {rect:?}");
  }

  #[test]
  fn reads_the_tooltip_when_there_is_one() {
    let links = links_of_page_zero(document(
      "/Annots [6 0 R]",
      "",
      &[(
        6,
        "<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] /Contents (See A101) \
         /Dest [4 0 R /Fit] >>",
      )],
    ));
    assert_eq!(links[0].alt.as_deref(), Some("See A101"));
    assert!(
      links_of_page_zero(document(
        "/Annots [6 0 R]",
        "",
        &[(
          6,
          "<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] /Dest [4 0 R /Fit] >>",
        )],
      ))[0]
        .alt
        .is_none()
    );
  }

  #[test]
  fn skips_annotations_that_are_not_links() {
    let links = links_of_page_zero(document(
      "/Annots [6 0 R 7 0 R]",
      "",
      &[
        (
          6,
          "<< /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /Dest [4 0 R /Fit] >>",
        ),
        (
          7,
          "<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] /Dest [4 0 R /Fit] >>",
        ),
      ],
    ));
    assert_eq!(links.len(), 1, "only the /Link should be reported");
  }

  #[test]
  fn skips_a_hidden_link() {
    let links = links_of_page_zero(document(
      "/Annots [6 0 R]",
      "",
      &[(
        6,
        "<< /Type /Annot /Subtype /Link /Rect [72 700 200 720] /F 2 /Dest [4 0 R /Fit] >>",
      )],
    ));
    assert!(links.is_empty(), "a hidden link is not clickable");
  }

  #[test]
  fn drops_a_link_whose_target_this_document_cannot_honour() {
    // GoToR points into another file, so its page number means nothing here. Unlike
    // an outline entry — which is still worth listing by title — a link with no
    // target is a region that would swallow clicks.
    let links = links_of_page_zero(document(
      "/Annots [6 0 R 7 0 R]",
      "",
      &[
        (
          6,
          "<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] \
           /A << /S /GoToR /F (other.pdf) /D [0 /Fit] >> >>",
        ),
        (
          7,
          "<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] \
           /A << /S /JavaScript /JS (app.alert\\(1\\)) >> >>",
        ),
      ],
    ));
    assert!(links.is_empty());
  }

  #[test]
  fn a_page_with_no_annots_has_no_links() {
    assert!(links_of_page_zero(document("", "", &[])).is_empty());
  }

  #[test]
  fn a_page_out_of_range_is_an_error() {
    let pdf = Pdf::new(Arc::new(document("", "", &[]))).expect("fixture should parse");
    assert!(matches!(
      read_links(&pdf, 9),
      Err(PapyraError::PageOutOfRange(9))
    ));
  }
}
