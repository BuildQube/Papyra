//! Reading the PDF outline (bookmarks).
//!
//! hayro exposes no outline API — it defines the `/Outlines` key and never reads it —
//! but its generic object layer is public, so the walk is ours to do.
//!
//! Destination resolution lives in [`crate::dest`], because link annotations address
//! their targets exactly the same way. What is left here is the tree walk itself, and
//! its guard: real-world outlines contain cycles, so every recursion needs something
//! that terminates rather than a depth limit that merely delays the hang.

use crate::dest::{MAX_DEPTH, MAX_ENTRIES, Resolver};
use crate::strings::decode_text_string;
use hayro_syntax::Pdf;
use hayro_syntax::object::String as PdfString;
use hayro_syntax::object::dict::keys;
use hayro_syntax::object::{Dict, ObjectIdentifier};
use papyra_core::OutlineItem;
use std::collections::HashSet;

/// Read the document outline in pre-order.
///
/// Container entries — a folder with children but no destination — are kept, with a
/// `dest` of `None`, because dropping them would reparent their children and destroy
/// the shape of the table of contents.
pub fn read_outline(pdf: &Pdf) -> Vec<OutlineItem> {
  let Some(resolver) = Resolver::new(pdf) else {
    return Vec::new();
  };
  let xref = resolver.xref();
  let Some(catalog) = xref.get::<Dict>(xref.root_id()) else {
    return Vec::new();
  };
  let Some(outlines) = catalog.get::<Dict>(keys::OUTLINES) else {
    return Vec::new();
  };

  let mut walker = Walker {
    resolver,
    visited: HashSet::new(),
    items: Vec::new(),
  };
  walker.walk_siblings(&outlines, 0);
  walker.items
}

struct Walker<'a> {
  resolver: Resolver<'a>,
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
      let Some(node) = self.resolver.xref().get::<Dict<'a>>(current.into()) else {
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
      dest: self.resolver.resolve(node),
      bold: flags & 0b10 != 0,
      italic: flags & 0b01 != 0,
      open,
    });
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::fixtures::build_pdf;
  use papyra_core::DestinationView;
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
}
