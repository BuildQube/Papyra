//! Reading the PDF outline (bookmarks).
//!
//! hayro exposes no outline API — it defines the `/Outlines` key and never reads it —
//! but its generic object layer is public, so the walk is ours to do.
//!
//! Two things make this more than a tree traversal. Destinations are addressed four
//! different ways (explicit array, name-tree lookup, `/A` action, legacy `/Dests`
//! dictionary), and real-world outlines contain cycles, so every recursion needs a
//! guard that terminates rather than a depth limit that merely delays the hang.

use hayro_syntax::Pdf;
use hayro_syntax::object::String as PdfString;
use hayro_syntax::object::dict::keys;
use hayro_syntax::object::{Array, Dict, MaybeRef, Name, Null, Object, ObjectIdentifier};
use hayro_syntax::xref::XRef;
use papyra_core::{Destination, DestinationView, OutlineItem};
use std::collections::{HashMap, HashSet};

/// Depth cap for nested bookmarks. Real documents nest a handful deep; anything past
/// this is malformed or hostile.
const MAX_DEPTH: usize = 32;

/// Ceiling on entries visited, as a second backstop beside the cycle guard.
const MAX_ENTRIES: usize = 50_000;

/// Read the document outline in pre-order.
///
/// Container entries — a folder with children but no destination — are kept, with a
/// `dest` of `None`, because dropping them would reparent their children and destroy
/// the shape of the table of contents.
pub fn read_outline(pdf: &Pdf) -> Vec<OutlineItem> {
  let xref = pdf.xref();
  let Some(catalog) = xref.get::<Dict>(xref.root_id()) else {
    return Vec::new();
  };
  let Some(outlines) = catalog.get::<Dict>(keys::OUTLINES) else {
    return Vec::new();
  };

  let mut walker = Walker {
    xref,
    pages: page_index_by_ref(pdf),
    names: NameTree::read(xref, &catalog),
    visited: HashSet::new(),
    items: Vec::new(),
  };
  walker.walk_siblings(&outlines, 0);
  walker.items
}

/// Map each page's object id to its 0-based index.
fn page_index_by_ref(pdf: &Pdf) -> HashMap<ObjectIdentifier, usize> {
  let mut map = HashMap::new();
  for (index, page) in pdf.pages().iter().enumerate() {
    let Some(id) = page.raw().obj_id() else {
      continue;
    };
    // A page dict written inline in `/Kids` inherits its parent's id, so the same id
    // can appear twice. First page wins rather than last.
    map.entry(id).or_insert(index);
  }
  map
}

struct Walker<'a> {
  xref: &'a XRef,
  pages: HashMap<ObjectIdentifier, usize>,
  names: NameTree<'a>,
  /// Guards against sibling and child cycles, which malformed outlines do contain and
  /// which would otherwise spin forever.
  visited: HashSet<ObjectIdentifier>,
  items: Vec<OutlineItem>,
}

impl<'a> Walker<'a> {
  /// Walk `/First`, then each `/Next`, recursing into children.
  fn walk_siblings(&mut self, parent: &Dict<'a>, level: usize) {
    if level >= MAX_DEPTH {
      return;
    }

    let mut next = parent.get_ref(keys::FIRST);
    while let Some(current) = next {
      if self.items.len() >= MAX_ENTRIES || !self.visited.insert(current.into()) {
        return;
      }
      let Some(node) = self.xref.get::<Dict<'a>>(current.into()) else {
        return;
      };

      self.visit(&node, level);

      if node.contains_key(keys::FIRST) {
        self.walk_siblings(&node, level + 1);
      }

      next = node.get_ref(keys::NEXT);
    }
  }

  fn visit(&mut self, node: &Dict<'a>, level: usize) {
    let Some(title) = node
      .get::<PdfString>(keys::TITLE)
      .and_then(|title| decode_text_string(title.as_bytes()))
    else {
      return;
    };
    let title = title.trim().to_string();
    if title.is_empty() {
      return;
    }

    // `/F` is a bit field: bit position 1 is italic, 2 is bold.
    let flags = node.get::<u32>(keys::F).unwrap_or(0);
    // `/Count` is the number of visible descendants; negative means collapsed. Absent
    // means no children, for which "open" is meaningless — report it as closed.
    let open = node.get::<i32>(keys::COUNT).unwrap_or(0) > 0;

    self.items.push(OutlineItem {
      title,
      level,
      dest: self.resolve_destination(node),
      bold: flags & 0b10 != 0,
      italic: flags & 0b01 != 0,
      open,
    });
  }

  /// Resolve an entry's destination.
  ///
  /// A destination is either `/Dest`, or a `/A` GoTo action's `/D`; either may be an
  /// explicit array or a name pointing into the document's name tree.
  fn resolve_destination(&self, node: &Dict<'a>) -> Option<Destination> {
    if let Some(dest) = node.get::<Object<'a>>(keys::DEST)
      && let Some(resolved) = self.destination_from(dest)
    {
      return Some(resolved);
    }

    let action = node.get::<Dict<'a>>(keys::A)?;
    // Only GoTo addresses a page in this document; GoToR and URI do not.
    if let Some(kind) = action.get::<Name<'a>>(keys::S)
      && &*kind != b"GoTo"
    {
      return None;
    }
    self.destination_from(action.get::<Object<'a>>(keys::D)?)
  }

  fn destination_from(&self, object: Object<'a>) -> Option<Destination> {
    match object {
      Object::Array(array) => self.destination_from_array(&array),
      Object::Name(name) => self.resolve_named_destination(&name),
      Object::String(string) => self.resolve_named_destination(string.as_bytes()),
      _ => None,
    }
  }

  /// `[ 3 0 R /XYZ null 792 null ]` — the page, then the view.
  fn destination_from_array(&self, array: &Array<'a>) -> Option<Destination> {
    let mut items = array.raw_iter();
    let page_index = match items.next()? {
      MaybeRef::Ref(page_ref) => self.pages.get(&page_ref.into()).copied()?,
      // A literal page *number* is only legal in a remote destination, which by
      // definition does not point into this document.
      MaybeRef::NotRef(_) => return None,
    };

    // The remainder is `/Name` followed by 0-4 numbers, any of which may be null.
    let mut rest = items.map(|item| match item {
      MaybeRef::NotRef(object) => object,
      // A number written as a reference is legal but pointless; treat it as absent
      // rather than chasing it, since no real file does this.
      MaybeRef::Ref(_) => Object::Null(Null),
    });
    let kind = match rest.next() {
      Some(Object::Name(name)) => name,
      // A destination array with no view is malformed but common; show the page.
      _ => {
        return Some(Destination {
          page_index,
          view: DestinationView::Fit,
        });
      }
    };
    let mut number = || match rest.next() {
      Some(Object::Number(n)) => Some(n.as_f32()),
      _ => None,
    };

    let view = match &*kind {
      b"XYZ" => DestinationView::XyZ {
        left: number(),
        top: number(),
        // The spec spells "unchanged" as either null or 0, so normalise both away and
        // save every caller the same special case.
        zoom: number().filter(|z| *z != 0.0),
      },
      b"FitH" => DestinationView::FitH { top: number() },
      b"FitV" => DestinationView::FitV { left: number() },
      b"FitR" => DestinationView::FitR {
        left: number()?,
        bottom: number()?,
        right: number()?,
        top: number()?,
      },
      b"FitB" => DestinationView::FitB,
      b"FitBH" => DestinationView::FitBH { top: number() },
      b"FitBV" => DestinationView::FitBV { left: number() },
      // `/Fit`, and anything unrecognised.
      _ => DestinationView::Fit,
    };
    Some(Destination { page_index, view })
  }

  fn resolve_named_destination(&self, name: &[u8]) -> Option<Destination> {
    match self.names.get(name, self.xref)? {
      // Either the array itself, or a dict wrapping it in `/D`.
      Object::Array(array) => self.destination_from_array(&array),
      Object::Dict(dict) => self.destination_from_array(&dict.get::<Array<'a>>(keys::D)?),
      _ => None,
    }
  }
}

/// The document's named-destination table, flattened.
///
/// Covers both `/Names /Dests` (a name tree) and the legacy `/Dests` catalog
/// dictionary. Usually empty — most files use explicit destinations.
///
/// Values are kept unresolved because a destination is equally legal written inline or
/// behind a reference.
struct NameTree<'a> {
  entries: HashMap<Vec<u8>, MaybeRef<Object<'a>>>,
}

impl<'a> NameTree<'a> {
  fn read(xref: &'a XRef, catalog: &Dict<'a>) -> Self {
    let mut tree = Self {
      entries: HashMap::new(),
    };
    if let Some(dests) = catalog
      .get::<Dict<'a>>(keys::NAMES)
      .and_then(|names| names.get::<Dict<'a>>(keys::DESTS))
    {
      tree.read_node(xref, &dests, 0, &mut HashSet::new());
    }
    if let Some(legacy) = catalog.get::<Dict<'a>>(keys::DESTS) {
      for (name, value) in legacy.entries() {
        tree.entries.insert(name.to_vec(), value);
      }
    }
    tree
  }

  /// Walk one name-tree node, then its `/Kids`.
  ///
  /// `visited` is what actually bounds this. A depth cap alone does not: a node whose
  /// `/Kids` points back at itself branches rather than repeats, so 32 levels of a
  /// two-kid cycle is four billion visits, not 32.
  fn read_node(
    &mut self,
    xref: &'a XRef,
    node: &Dict<'a>,
    depth: usize,
    visited: &mut HashSet<ObjectIdentifier>,
  ) {
    if depth >= MAX_DEPTH || self.entries.len() >= MAX_ENTRIES {
      return;
    }

    if let Some(names) = node.get::<Array<'a>>(keys::NAMES) {
      // Flat `[ key1 value1 key2 value2 ... ]`.
      let mut iter = names.raw_iter();
      while let Some(key) = iter.next() {
        let Some(value) = iter.next() else { break };
        let MaybeRef::NotRef(Object::String(key)) = key else {
          continue;
        };
        self.entries.insert(key.as_bytes().to_vec(), value);
      }
    }

    let Some(kids) = node.get::<Array<'a>>(keys::KIDS) else {
      return;
    };
    for kid in kids.raw_iter() {
      match kid {
        MaybeRef::Ref(kid_ref) => {
          if !visited.insert(kid_ref.into()) {
            continue;
          }
          if let Some(kid) = xref.get::<Dict<'a>>(kid_ref.into()) {
            self.read_node(xref, &kid, depth + 1, visited);
          }
        }
        // An inline kid is nested syntax, so it cannot point back at an ancestor.
        MaybeRef::NotRef(Object::Dict(kid)) => self.read_node(xref, &kid, depth + 1, visited),
        MaybeRef::NotRef(_) => {}
      }
    }
  }

  fn get(&self, name: &[u8], xref: &'a XRef) -> Option<Object<'a>> {
    match self.entries.get(name)? {
      MaybeRef::Ref(id) => xref.get::<Object<'a>>((*id).into()),
      MaybeRef::NotRef(object) => Some(object.clone()),
    }
  }
}

/// PDFDocEncoding's `0x80..=0x9F` block (PDF 32000-1, annex D.2).
///
/// Latin-1 puts unused C1 control codes here, so the two encodings agree everywhere
/// *except* this range — which is precisely where the em and en dashes live, and a
/// bookmark title like `A101 — SITE PLAN` is mostly dash. Decoding as Latin-1 would
/// bury a control character in the middle of the title.
const PDF_DOC_ENCODING_C1: [char; 32] = [
  '\u{2022}', '\u{2020}', '\u{2021}', '\u{2026}', '\u{2014}', '\u{2013}', '\u{0192}', '\u{2044}',
  '\u{2039}', '\u{203A}', '\u{2212}', '\u{2030}', '\u{201E}', '\u{201C}', '\u{201D}', '\u{2018}',
  '\u{2019}', '\u{201A}', '\u{2122}', '\u{FB01}', '\u{FB02}', '\u{0141}', '\u{0152}', '\u{0160}',
  '\u{0178}', '\u{017D}', '\u{0131}', '\u{0142}', '\u{0153}', '\u{0161}', '\u{017E}', '\u{FFFD}',
];

/// Decode UTF-16 code units of a known endianness.
///
/// `as_chunks` leaves a trailing odd byte in the remainder, which is the right answer
/// for a truncated string: half a code unit decodes to nothing.
fn decode_utf16(bytes: &[u8], to_unit: fn([u8; 2]) -> u16) -> String {
  let (pairs, _trailing) = bytes.as_chunks::<2>();
  let units: Vec<u16> = pairs.iter().copied().map(to_unit).collect();
  String::from_utf16_lossy(&units)
}

/// Decode a PDF text string.
///
/// hayro hands back raw bytes, so the encoding is ours to sort out: UTF-16 and UTF-8
/// announce themselves with a BOM, and everything else is PDFDocEncoding.
fn decode_text_string(bytes: &[u8]) -> Option<String> {
  if bytes.is_empty() {
    return None;
  }

  if let [0xFE, 0xFF, rest @ ..] = bytes {
    return Some(decode_utf16(rest, u16::from_be_bytes));
  }

  if let [0xFF, 0xFE, rest @ ..] = bytes {
    return Some(decode_utf16(rest, u16::from_le_bytes));
  }

  if let [0xEF, 0xBB, 0xBF, rest @ ..] = bytes {
    return Some(String::from_utf8_lossy(rest).into_owned());
  }

  Some(
    bytes
      .iter()
      .map(|byte| match byte {
        0x80..=0x9F => PDF_DOC_ENCODING_C1[(byte - 0x80) as usize],
        _ => *byte as char,
      })
      .collect(),
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::fixtures::build_pdf;
  use std::sync::Arc;

  /// A two-page document whose outline is whatever `objects` describe.
  ///
  /// Object 1 is the catalog, 3 and 4 are the pages (0- and 1-indexed respectively),
  /// 6 is the outline root. `objects` supplies 6 upward.
  fn document(catalog_extra: &str, objects: &[(u32, &str)]) -> Vec<u8> {
    // Pages need `/Contents` or hayro drops them from `Pages` entirely, which would
    // shift every index these tests assert on.
    let mut all = vec![
      (
        1,
        format!("<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R {catalog_extra} >>"),
      ),
      (
        2,
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>".to_string(),
      ),
      (
        3,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>".to_string(),
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

  fn outline_of(bytes: Vec<u8>) -> Vec<OutlineItem> {
    let pdf = Pdf::new(Arc::new(bytes)).expect("fixture should parse");
    read_outline(&pdf)
  }

  /// `(title, level, page)` — the shape most assertions care about.
  fn summary(items: &[OutlineItem]) -> Vec<(&str, usize, Option<usize>)> {
    items
      .iter()
      .map(|i| (i.title.as_str(), i.level, i.dest.map(|d| d.page_index)))
      .collect()
  }

  // ---- destination resolution ----

  #[test]
  fn resolves_an_explicit_dest_array() {
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (
          7,
          "<< /Title (A101 - SITE PLAN) /Parent 6 0 R /Dest [4 0 R /XYZ null null null] >>",
        ),
      ],
    ));
    assert_eq!(summary(&items), vec![("A101 - SITE PLAN", 0, Some(1))]);
  }

  #[test]
  fn resolves_a_goto_action() {
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (
          7,
          "<< /Title (COVER) /Parent 6 0 R /A << /S /GoTo /D [3 0 R /Fit] >> >>",
        ),
      ],
    ));
    assert_eq!(summary(&items), vec![("COVER", 0, Some(0))]);
  }

  #[test]
  fn ignores_an_action_that_leaves_this_document() {
    // GoToR points at a *different* file, so its page number means nothing here.
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (
          7,
          "<< /Title (ELSEWHERE) /Parent 6 0 R /A << /S /GoToR /F (other.pdf) /D [0 /Fit] >> >>",
        ),
      ],
    ));
    // The entry survives — a viewer still shows the title — but it points nowhere.
    assert_eq!(summary(&items), vec![("ELSEWHERE", 0, None)]);
  }

  #[test]
  fn resolves_a_named_destination() {
    let items = outline_of(document(
      "/Names 8 0 R",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (7, "<< /Title (BY NAME) /Parent 6 0 R /Dest (sheet.a101) >>"),
        (8, "<< /Dests 9 0 R >>"),
        (9, "<< /Names [(sheet.a101) 10 0 R] >>"),
        (10, "[4 0 R /XYZ null null null]"),
      ],
    ));
    assert_eq!(summary(&items), vec![("BY NAME", 0, Some(1))]);
  }

  #[test]
  fn resolves_a_named_destination_written_inline() {
    // The value may be the array itself rather than a reference to one.
    let items = outline_of(document(
      "/Names 8 0 R",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (7, "<< /Title (INLINE) /Parent 6 0 R /Dest (sheet.a101) >>"),
        (8, "<< /Dests 9 0 R >>"),
        (9, "<< /Names [(sheet.a101) [4 0 R /XYZ null null null]] >>"),
      ],
    ));
    assert_eq!(summary(&items), vec![("INLINE", 0, Some(1))]);
  }

  #[test]
  fn resolves_a_named_destination_from_the_legacy_dests_dictionary() {
    // Pre-1.2 files put named destinations straight in the catalog.
    let items = outline_of(document(
      "/Dests 8 0 R",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (7, "<< /Title (LEGACY) /Parent 6 0 R /Dest /sheet >>"),
        (8, "<< /sheet [4 0 R /Fit] >>"),
      ],
    ));
    assert_eq!(summary(&items), vec![("LEGACY", 0, Some(1))]);
  }

  #[test]
  fn a_named_destination_may_wrap_its_array_in_d() {
    let items = outline_of(document(
      "/Names 8 0 R",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (7, "<< /Title (WRAPPED) /Parent 6 0 R /Dest (sheet) >>"),
        (8, "<< /Dests 9 0 R >>"),
        (9, "<< /Names [(sheet) << /D [4 0 R /Fit] >>] >>"),
      ],
    ));
    assert_eq!(summary(&items), vec![("WRAPPED", 0, Some(1))]);
  }

  #[test]
  fn keeps_a_container_entry_that_points_nowhere() {
    // A `Sheets` folder holds children but has no destination of its own. Dropping it
    // would reparent its children and flatten the table of contents.
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (
          7,
          "<< /Title (Sheets) /Parent 6 0 R /First 8 0 R /Last 8 0 R /Count 1 >>",
        ),
        (
          8,
          "<< /Title (A101 - SITE PLAN) /Parent 7 0 R /Dest [4 0 R /Fit] >>",
        ),
      ],
    ));
    assert_eq!(
      summary(&items),
      vec![("Sheets", 0, None), ("A101 - SITE PLAN", 1, Some(1))]
    );
  }

  // ---- destination views ----

  #[test]
  fn reads_an_xyz_view() {
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (
          7,
          "<< /Title (SECTION) /Parent 6 0 R /Dest [3 0 R /XYZ 72 640 2] >>",
        ),
      ],
    ));
    assert_eq!(
      items[0].dest.unwrap().view,
      DestinationView::XyZ {
        left: Some(72.0),
        top: Some(640.0),
        zoom: Some(2.0),
      }
    );
  }

  #[test]
  fn a_zero_zoom_means_unchanged_just_as_null_does() {
    // The spec allows both spellings; normalising here saves every caller the same
    // special case.
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (
          7,
          "<< /Title (SECTION) /Parent 6 0 R /Dest [3 0 R /XYZ null 640 0] >>",
        ),
      ],
    ));
    assert_eq!(
      items[0].dest.unwrap().view,
      DestinationView::XyZ {
        left: None,
        top: Some(640.0),
        zoom: None,
      }
    );
  }

  #[test]
  fn reads_the_remaining_view_kinds() {
    let cases: &[(&str, DestinationView)] = &[
      ("/Fit", DestinationView::Fit),
      ("/FitH 700", DestinationView::FitH { top: Some(700.0) }),
      ("/FitV 20", DestinationView::FitV { left: Some(20.0) }),
      (
        "/FitR 10 20 30 40",
        DestinationView::FitR {
          left: 10.0,
          bottom: 20.0,
          right: 30.0,
          top: 40.0,
        },
      ),
      ("/FitB", DestinationView::FitB),
      ("/FitBH 700", DestinationView::FitBH { top: Some(700.0) }),
      ("/FitBV 20", DestinationView::FitBV { left: Some(20.0) }),
    ];

    for (written, expected) in cases {
      let items = outline_of(document(
        "",
        &[
          (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
          (
            7,
            &format!("<< /Title (T) /Parent 6 0 R /Dest [3 0 R {written}] >>"),
          ),
        ],
      ));
      assert_eq!(items[0].dest.unwrap().view, *expected, "for {written}");
    }
  }

  #[test]
  fn a_destination_array_with_no_view_still_resolves_its_page() {
    // Malformed, but common enough that refusing it would lose real bookmarks.
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (7, "<< /Title (BARE) /Parent 6 0 R /Dest [4 0 R] >>"),
      ],
    ));
    assert_eq!(summary(&items), vec![("BARE", 0, Some(1))]);
    assert_eq!(items[0].dest.unwrap().view, DestinationView::Fit);
  }

  // ---- tree shape and presentation ----

  #[test]
  fn level_records_nesting_depth_in_pre_order() {
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 10 0 R >>"),
        (
          7,
          "<< /Title (Part One) /Parent 6 0 R /First 8 0 R /Last 8 0 R /Next 10 0 R >>",
        ),
        (
          8,
          "<< /Title (Chapter A) /Parent 7 0 R /First 9 0 R /Last 9 0 R /Dest [3 0 R /Fit] >>",
        ),
        (
          9,
          "<< /Title (Section i) /Parent 8 0 R /Dest [4 0 R /Fit] >>",
        ),
        (
          10,
          "<< /Title (Part Two) /Parent 6 0 R /Dest [4 0 R /Fit] >>",
        ),
      ],
    ));
    assert_eq!(
      summary(&items),
      vec![
        ("Part One", 0, None),
        ("Chapter A", 1, Some(0)),
        ("Section i", 2, Some(1)),
        ("Part Two", 0, Some(1)),
      ]
    );
  }

  #[test]
  fn reads_style_flags_and_open_state() {
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (
          7,
          "<< /Title (BOLD ITALIC OPEN) /Parent 6 0 R /Dest [3 0 R /Fit] /F 3 /Count 2 \
           /First 8 0 R /Last 8 0 R >>",
        ),
        (8, "<< /Title (child) /Parent 7 0 R /Dest [4 0 R /Fit] >>"),
      ],
    ));
    assert!(items[0].bold, "F bit 2 is bold");
    assert!(items[0].italic, "F bit 1 is italic");
    assert!(items[0].open, "a positive /Count starts expanded");
    assert!(!items[1].open, "no /Count and no children is not open");
  }

  #[test]
  fn a_negative_count_is_collapsed() {
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (
          7,
          "<< /Title (Closed) /Parent 6 0 R /Count -2 /First 8 0 R /Last 8 0 R >>",
        ),
        (8, "<< /Title (child) /Parent 7 0 R /Dest [4 0 R /Fit] >>"),
      ],
    ));
    assert!(!items[0].open);
    // Collapsed is a presentation hint, not a filter: the children are still read.
    assert_eq!(items.len(), 2);
  }

  // ---- defences against malformed outlines ----

  #[test]
  fn terminates_on_a_cyclic_sibling_chain() {
    // B's /Next points back at A. Without the visited set this never returns.
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 8 0 R >>"),
        (
          7,
          "<< /Title (A) /Parent 6 0 R /Dest [3 0 R /Fit] /Next 8 0 R >>",
        ),
        (
          8,
          "<< /Title (B) /Parent 6 0 R /Dest [4 0 R /Fit] /Next 7 0 R >>",
        ),
      ],
    ));
    // Everything before the cycle closes is still collected.
    assert_eq!(summary(&items), vec![("A", 0, Some(0)), ("B", 0, Some(1))]);
  }

  #[test]
  fn terminates_on_a_self_referential_entry() {
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (
          7,
          "<< /Title (LOOP) /Parent 6 0 R /Dest [3 0 R /Fit] /Next 7 0 R /First 7 0 R >>",
        ),
      ],
    ));
    assert_eq!(items.len(), 1, "got {items:?}");
  }

  #[test]
  fn terminates_on_a_name_tree_kids_cycle() {
    // A depth cap alone does not save this: two self-referential kids branch rather
    // than repeat, so the walk would explode long before it hit 32.
    let items = outline_of(document(
      "/Names 8 0 R",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (7, "<< /Title (BY NAME) /Parent 6 0 R /Dest (sheet.a101) >>"),
        (8, "<< /Dests 9 0 R >>"),
        (
          9,
          "<< /Kids [9 0 R 9 0 R] /Names [(sheet.a101) [4 0 R /Fit]] >>",
        ),
      ],
    ));
    assert_eq!(summary(&items), vec![("BY NAME", 0, Some(1))]);
  }

  #[test]
  fn an_entry_with_no_title_is_dropped() {
    let items = outline_of(document(
      "",
      &[
        (6, "<< /Type /Outlines /First 7 0 R /Last 7 0 R >>"),
        (7, "<< /Parent 6 0 R /Dest [3 0 R /Fit] >>"),
      ],
    ));
    assert!(items.is_empty(), "got {items:?}");
  }

  #[test]
  fn no_outline_yields_no_entries() {
    let bytes = build_pdf(&[
      (1, "<< /Type /Catalog /Pages 2 0 R >>".to_string()),
      (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string()),
      (
        3,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>".to_string(),
      ),
      (4, "<< /Length 0 >>\nstream\nendstream".to_string()),
    ]);
    assert!(outline_of(bytes).is_empty());
  }

  // ---- text strings ----

  #[test]
  fn decodes_ascii() {
    assert_eq!(
      decode_text_string(b"A101 - SITE PLAN").as_deref(),
      Some("A101 - SITE PLAN")
    );
  }

  #[test]
  fn decodes_utf16be_with_bom() {
    let bytes = [0xFE, 0xFF, 0x00, 0x48, 0x00, 0x69];
    assert_eq!(decode_text_string(&bytes).as_deref(), Some("Hi"));
  }

  #[test]
  fn decodes_utf16le_with_bom() {
    let bytes = [0xFF, 0xFE, 0x48, 0x00, 0x69, 0x00];
    assert_eq!(decode_text_string(&bytes).as_deref(), Some("Hi"));
  }

  #[test]
  fn decodes_utf8_with_bom() {
    let bytes = [0xEF, 0xBB, 0xBF, b'H', b'i'];
    assert_eq!(decode_text_string(&bytes).as_deref(), Some("Hi"));
  }

  #[test]
  fn decodes_latin1_high_bytes() {
    // 0xE9 is é in both Latin-1 and PDFDocEncoding.
    assert_eq!(decode_text_string(&[0xE9]).as_deref(), Some("é"));
  }

  #[test]
  fn decodes_pdfdoc_dashes_rather_than_latin1_controls() {
    // 0x84 is an em dash in PDFDocEncoding and an unused C1 control in Latin-1.
    // Titles like `A101 — SITE PLAN` are mostly this byte.
    assert_eq!(decode_text_string(&[0x84]).as_deref(), Some("\u{2014}"));
  }

  #[test]
  fn empty_string_is_none() {
    assert_eq!(decode_text_string(b""), None);
  }
}
