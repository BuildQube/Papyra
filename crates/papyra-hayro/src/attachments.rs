//! Reading embedded files.
//!
//! A PDF can carry arbitrary files inside itself, filed in the `/Names /EmbeddedFiles`
//! name tree. Mostly this is a curiosity — a spreadsheet stapled to a report — but it
//! is the whole mechanism behind hybrid e-invoicing: a ZUGFeRD or Factur-X document
//! *is* a PDF wrapping an XML payload, and the PDF half exists so a human can read
//! what the machine is going to process.
//!
//! The tree walk is [`crate::dest::walk_name_tree`], shared with named destinations,
//! cycle guard and all. What is left here is the file specification: which of its
//! three names to believe, and where the bytes actually live.

use crate::dest::walk_name_tree;
use crate::strings::decode_non_empty;
use hayro_syntax::Pdf;
use hayro_syntax::object::String as PdfString;
use hayro_syntax::object::dict::keys;
use hayro_syntax::object::{Dict, MaybeRef, Name, Object, Stream};
use hayro_syntax::xref::XRef;
use papyra_core::{Attachment, PapyraError, Result};

/// Read every embedded file's metadata, in tree order.
///
/// Empty for a document that embeds nothing, which is the common case.
pub fn read_attachments(pdf: &Pdf) -> Vec<Attachment> {
  let mut out = Vec::new();
  for_each_filespec(pdf, &mut |name, spec| {
    if let Some(attachment) = to_attachment(name, &spec) {
      out.push(attachment);
    }
  });
  out
}

/// Decompress one embedded file, addressed the way [`read_attachments`] listed it.
///
/// The tree is walked again rather than cached, deliberately: it is an object-graph
/// read, the document owns the bytes for as long as it lives, and holding every
/// attachment's decoded contents against the chance a caller wants one of them is the
/// cost this API is shaped to avoid.
pub fn read_attachment_data(pdf: &Pdf, index: usize) -> Result<Vec<u8>> {
  let mut found = None;
  let mut seen = 0usize;
  for_each_filespec(pdf, &mut |name, spec| {
    // `to_attachment` decides what counts as an attachment, so the index has to be
    // counted over the same set it accepts — not over every filespec in the tree.
    if to_attachment(name, &spec).is_none() {
      return;
    }
    if seen == index {
      found = embedded_stream(&spec);
    }
    seen += 1;
  });

  let stream = found.ok_or(PapyraError::AttachmentOutOfRange(index))?;
  stream
    .decoded()
    .map(|bytes| bytes.into_owned())
    .map_err(|e| PapyraError::Parse(format!("attachment {index} could not be decoded: {e:?}")))
}

/// Walk `/Names /EmbeddedFiles`, handing each file specification to `on_spec`.
fn for_each_filespec<'a>(pdf: &'a Pdf, on_spec: &mut impl FnMut(&[u8], Dict<'a>)) {
  let xref = pdf.xref();
  let Some(catalog) = xref.get::<Dict>(xref.root_id()) else {
    return;
  };
  let Some(root) = catalog
    .get::<Dict>(keys::NAMES)
    .and_then(|names| names.get::<Dict>(keys::EMBEDDED_FILES))
  else {
    return;
  };

  walk_name_tree(xref, &root, &mut |name, value| {
    if let Some(spec) = as_dict(xref, value) {
      on_spec(name, spec);
    }
  });
}

fn as_dict<'a>(xref: &'a XRef, value: MaybeRef<Object<'a>>) -> Option<Dict<'a>> {
  match value {
    MaybeRef::Ref(id) => xref.get::<Dict<'a>>(id.into()),
    MaybeRef::NotRef(Object::Dict(dict)) => Some(dict),
    MaybeRef::NotRef(_) => None,
  }
}

/// The embedded stream itself: `/EF /F`, or one of the other four spellings.
///
/// `/F` is the one every producer writes. The rest exist because the file
/// specification predates Unicode and carried a separate name per platform, and a file
/// keyed only under `/UF` is rare but legal.
fn embedded_stream<'a>(spec: &Dict<'a>) -> Option<Stream<'a>> {
  let ef = spec.get::<Dict<'a>>(keys::EF)?;
  for key in [keys::F, keys::UF, b"DOS".as_slice(), b"Mac", b"Unix"] {
    if let Some(stream) = ef.get::<Stream<'a>>(key) {
      return Some(stream);
    }
  }
  None
}

fn to_attachment(tree_name: &[u8], spec: &Dict<'_>) -> Option<Attachment> {
  let stream = embedded_stream(spec)?;

  // `/UF` first: it is the Unicode spelling, and the one the spec tells a reader to
  // prefer. The tree key is the last resort rather than the first because it is an
  // index key — producers use paths, hashes and ordinals for it — while `/F` is what
  // the document means the file to be called.
  let name = text(spec, keys::UF)
    .or_else(|| text(spec, keys::F))
    .or_else(|| decode_non_empty(tree_name))?;

  let params = stream.dict().get::<Dict<'_>>(keys::PARAMS);
  Some(Attachment {
    name,
    description: text(spec, keys::DESC),
    media_type: stream
      .dict()
      .get::<Name<'_>>(keys::SUBTYPE)
      .map(|subtype| subtype.as_str().to_string())
      .filter(|subtype| !subtype.is_empty()),
    size: params
      .as_ref()
      .and_then(|p| p.get::<i64>(keys::SIZE))
      .and_then(|size| u64::try_from(size).ok()),
    created: params.as_ref().and_then(|p| date(p, keys::CREATION_DATE)),
    modified: params.as_ref().and_then(|p| date(p, keys::MOD_DATE)),
    relationship: spec
      .get::<Name<'_>>(keys::AF_RELATIONSHIP)
      .map(|r| r.as_str().to_string())
      .filter(|r| !r.is_empty()),
  })
}

fn date(dict: &Dict<'_>, key: &[u8]) -> Option<String> {
  crate::info::date_string_to_iso8601(dict.get::<PdfString>(key)?.as_bytes())
}

fn text(dict: &Dict<'_>, key: &[u8]) -> Option<String> {
  dict
    .get::<PdfString>(key)
    .and_then(|value| decode_non_empty(value.as_bytes()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::fixtures::build_pdf;
  use std::sync::Arc;

  /// A one-page document whose `/EmbeddedFiles` tree is whatever `objects` describe.
  ///
  /// Object 1 is the catalog and 5 is the `/EmbeddedFiles` tree root; `objects`
  /// supplies 5 upward.
  fn document(objects: &[(u32, String)]) -> Pdf {
    let mut all = vec![
      (
        1,
        "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 5 0 R >> >>".to_string(),
      ),
      (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string()),
      (
        3,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>".to_string(),
      ),
      (4, "<< /Length 0 >>\nstream\nendstream".to_string()),
    ];
    all.extend(objects.iter().cloned());
    Pdf::new(Arc::new(build_pdf(&all))).expect("fixture should parse")
  }

  /// An uncompressed embedded-file stream holding `body`.
  fn file_stream(number: u32, body: &str, params: &str) -> (u32, String) {
    (
      number,
      format!(
        "<< /Type /EmbeddedFile /Length {} {params} >>\nstream\n{body}\nendstream",
        body.len() + 1
      ),
    )
  }

  #[test]
  fn a_document_with_no_attachments_reads_empty() {
    let pdf = crate::fixtures::page_with_content("");
    assert!(read_attachments(&pdf).is_empty());
  }

  #[test]
  fn reads_a_file_and_its_bytes() {
    let pdf = document(&[
      (5, "<< /Names [(invoice.xml) 6 0 R] >>".to_string()),
      (
        6,
        "<< /Type /Filespec /F (invoice.xml) /UF (invoice.xml) /Desc (The invoice) \
         /AFRelationship /Alternative /EF << /F 7 0 R >> >>"
          .to_string(),
      ),
      file_stream(
        7,
        "<invoice/>",
        "/Subtype /text#2Fxml /Params << /Size 10 >>",
      ),
    ]);

    let files = read_attachments(&pdf);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name, "invoice.xml");
    assert_eq!(files[0].description.as_deref(), Some("The invoice"));
    // The subtype is a name with the slash escaped, and comes back unescaped.
    assert_eq!(files[0].media_type.as_deref(), Some("text/xml"));
    assert_eq!(files[0].size, Some(10));
    assert_eq!(files[0].relationship.as_deref(), Some("Alternative"));

    let data = read_attachment_data(&pdf, 0).expect("bytes");
    assert_eq!(String::from_utf8_lossy(&data).trim(), "<invoice/>");
  }

  #[test]
  fn prefers_the_unicode_name_then_f_then_the_tree_key() {
    let pdf = document(&[
      (
        5,
        "<< /Names [(a) 6 0 R (b) 8 0 R (tree-key) 10 0 R] >>".to_string(),
      ),
      (
        6,
        "<< /Type /Filespec /F (ascii.txt) /UF (unicode.txt) /EF << /F 7 0 R >> >>".to_string(),
      ),
      file_stream(7, "a", ""),
      (
        8,
        "<< /Type /Filespec /F (only-f.txt) /EF << /F 9 0 R >> >>".to_string(),
      ),
      file_stream(9, "b", ""),
      (10, "<< /Type /Filespec /EF << /F 11 0 R >> >>".to_string()),
      file_stream(11, "c", ""),
    ]);

    let names: Vec<_> = read_attachments(&pdf).into_iter().map(|a| a.name).collect();
    assert_eq!(names, ["unicode.txt", "only-f.txt", "tree-key"]);
  }

  #[test]
  fn a_filespec_with_no_stream_is_not_an_attachment() {
    let pdf = document(&[
      (
        5,
        "<< /Names [(real) 6 0 R (dangling) 8 0 R] >>".to_string(),
      ),
      (
        6,
        "<< /Type /Filespec /F (real.txt) /EF << /F 7 0 R >> >>".to_string(),
      ),
      file_stream(7, "here", ""),
      // A file specification that names an external file carries no `/EF` at all.
      (8, "<< /Type /Filespec /F (external.txt) >>".to_string()),
    ]);

    let files = read_attachments(&pdf);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name, "real.txt");
    // The index is counted over what `read_attachments` reported, so 0 is still the
    // real file and there is no index 1 to fetch.
    assert_eq!(
      String::from_utf8_lossy(&read_attachment_data(&pdf, 0).expect("bytes")).trim(),
      "here"
    );
    assert!(read_attachment_data(&pdf, 1).is_err());
  }

  #[test]
  fn walks_a_nested_tree_and_survives_a_cycle() {
    let pdf = document(&[
      (5, "<< /Kids [6 0 R] >>".to_string()),
      // The second kid points back at the root.
      (6, "<< /Kids [7 0 R 5 0 R] >>".to_string()),
      (7, "<< /Names [(deep) 8 0 R] >>".to_string()),
      (
        8,
        "<< /Type /Filespec /F (deep.txt) /EF << /F 9 0 R >> >>".to_string(),
      ),
      file_stream(9, "found", ""),
    ]);

    let files = read_attachments(&pdf);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name, "deep.txt");
  }

  #[test]
  fn dates_become_iso8601() {
    let pdf = document(&[
      (5, "<< /Names [(dated) 6 0 R] >>".to_string()),
      (
        6,
        "<< /Type /Filespec /F (dated.txt) /EF << /F 7 0 R >> >>".to_string(),
      ),
      file_stream(
        7,
        "x",
        "/Params << /CreationDate (D:20240115103000+01'00') /ModDate (D:2024) >>",
      ),
    ]);

    let files = read_attachments(&pdf);
    assert_eq!(
      files[0].created.as_deref(),
      Some("2024-01-15T10:30:00+01:00")
    );
    // Truncated to the year, and defaulted the way the information dictionary's are.
    assert_eq!(files[0].modified.as_deref(), Some("2024-01-01T00:00:00Z"));
  }
}
