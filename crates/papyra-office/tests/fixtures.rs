//! `sample.docx` is the demo's own (`apps/demo/public`, from
//! `scripts/make-sample-docx.ts`); `sample.pptx` is DeckCraft's built-in sample deck,
//! saved by `deckcraft-cli run --sample --save`.

use papyra_office::{OfficeDocument, OfficeError, OfficeKind};

fn docx() -> Vec<u8> {
  std::fs::read(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../apps/demo/public/sample.docx"
  ))
  .expect("demo sample.docx")
}

fn pptx() -> Vec<u8> {
  std::fs::read(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/sample.pptx"
  ))
  .expect("sample.pptx")
}

/// Share of pixels that are not paper-white. A blank page — the failure mode when a
/// font or a part fails to resolve — is the thing worth catching.
fn ink(data: &[u8]) -> f64 {
  let px = data.chunks_exact(4);
  let n = px.len() as f64;
  px.filter(|p| p[0] < 240 || p[1] < 240 || p[2] < 240)
    .count() as f64
    / n
}

#[test]
fn word_document_paginates_and_draws() {
  let doc = OfficeDocument::load(&docx()).unwrap();
  assert_eq!(doc.kind(), OfficeKind::Word);
  assert_eq!(doc.page_count(), 2);
  let size = doc.page_size(0).unwrap();
  assert_eq!((size.width, size.height), (612.0, 792.0), "US Letter");

  let bmp = doc.render(0, 1.5).unwrap();
  assert_eq!((bmp.width, bmp.height), (918, 1188));
  assert_eq!(bmp.data.len(), (bmp.stride * bmp.height) as usize);
  assert!(ink(&bmp.data) > 0.01, "page 1 is blank");
  // 254, not 255: vello_cpu's compositing rounds anti-aliased text over paper one
  // short of opaque, on about 700 pixels of this page.
  assert!(
    bmp.data.chunks_exact(4).all(|p| p[3] >= 250),
    "paper is opaque"
  );
}

#[test]
fn deck_draws_every_slide() {
  let deck = OfficeDocument::load(&pptx()).unwrap();
  assert_eq!(deck.kind(), OfficeKind::Slides);
  assert!(deck.page_count() > 1);
  let size = deck.page_size(0).unwrap();
  assert_eq!((size.width, size.height), (960.0, 540.0), "16:9");
  for i in 0..deck.page_count() {
    let bmp = deck.render(i, 0.5).unwrap();
    assert_eq!((bmp.width, bmp.height), (480, 270));
    assert!(ink(&bmp.data) > 0.001, "slide {i} is blank");
  }
}

#[test]
fn out_of_range_is_an_error_not_a_blank_page() {
  let doc = OfficeDocument::load(&docx()).unwrap();
  assert!(matches!(
    doc.render(2, 1.0),
    Err(OfficeError::PageOutOfRange(2))
  ));
  let deck = OfficeDocument::load(&pptx()).unwrap();
  let n = deck.page_count();
  assert!(matches!(
    deck.page_size(n),
    Err(OfficeError::PageOutOfRange(_))
  ));
}

#[test]
fn workbook_is_not_an_office_document() {
  let xlsx = std::fs::read(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../papyra-tables/tests/fixtures/sample.xlsx"
  ))
  .unwrap();
  assert!(matches!(
    OfficeDocument::load(&xlsx),
    Err(OfficeError::NotOffice)
  ));
}

#[test]
fn truncated_package_fails_cleanly() {
  let bytes = docx();
  assert!(OfficeDocument::load(&bytes[..bytes.len() / 2]).is_err());
}
