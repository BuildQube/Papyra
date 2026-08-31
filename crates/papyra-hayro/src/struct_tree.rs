//! Reading the document structure tree (tagged PDF).
//!
//! `/StructTreeRoot` is the only place a PDF states what its content *means* — which
//! runs are a heading, which are a table cell, and above all what order they are meant
//! to be read in. Content-stream order carries none of that: a two-column paper
//! interleaves its columns, and no amount of geometry recovers the author's intent on
//! a page whose layout is genuinely ambiguous.
//!
//! hayro parses no part of this, but it does the one thing that cannot be done from
//! outside: [`hayro_interpret::Device`] reports `BDC`/`BMC` with the marked-content id
//! attached, so [`crate::text`] can tag each line with the id that produced it. This
//! module supplies the other half — the tree those ids point into.
//!
//! The join is deliberately left to the caller: this returns ids, `text` returns ids,
//! and matching them is a hash lookup that belongs in TypeScript with the rest of the
//! ergonomics. See `structure.ts`.

use crate::dest::{MAX_DEPTH, MAX_ENTRIES, page_index_by_ref};
use crate::strings::decode_text_string;
use hayro_syntax::Pdf;
use hayro_syntax::object::String as PdfString;
use hayro_syntax::object::dict::keys;
use hayro_syntax::object::{Array, Dict, MaybeRef, Object, ObjectIdentifier};
use hayro_syntax::xref::XRef;
use papyra_core::{MarkedContent, StructNode};
use std::collections::{HashMap, HashSet};

/// `/Type /MCR`, a marked-content reference written as a dictionary rather than a bare
/// integer. hayro predefines every other key this walk needs, but not this one.
const MCR: &[u8] = b"MCR";

/// Read the structure tree in pre-order.
///
/// Empty for an untagged document, which is the common case and not an error — most
/// PDFs in the wild carry no `/StructTreeRoot` at all. A caller distinguishes "no
/// structure" from "structure with no text" by whether this is empty.
pub fn read_struct_tree(pdf: &Pdf) -> Vec<StructNode> {
  let xref = pdf.xref();
  let Some(catalog) = xref.get::<Dict>(xref.root_id()) else {
    return Vec::new();
  };
  let Some(root) = catalog.get::<Dict>(keys::STRUCT_TREE_ROOT) else {
    return Vec::new();
  };

  let mut walker = Walker {
    xref,
    pages: page_index_by_ref(pdf),
    roles: RoleMap::read(&root),
    visited: HashSet::new(),
    nodes: Vec::new(),
  };
  // The root is not itself an element — it is a container whose `/K` holds the real
  // top-level ones, so its children start at level 0.
  walker.walk_kids(&root, None, None, 0);
  walker.nodes
}

struct Walker<'a> {
  xref: &'a XRef,
  /// Object id of each page, for resolving `/Pg`. Shared with destination resolution
  /// rather than rebuilt, since it is a whole-document table either way.
  pages: HashMap<ObjectIdentifier, usize>,
  roles: RoleMap,
  /// Guards against `/K` cycles. Structure trees are supposed to be trees and a
  /// malformed one is not, so this is what terminates the walk — see the note in
  /// [`crate::dest`] on why a depth cap alone does not.
  visited: HashSet<ObjectIdentifier>,
  nodes: Vec<StructNode>,
}

impl<'a> Walker<'a> {
  /// Visit one structure element, then its children.
  ///
  /// `parent` is the element above this one, and matters only for the untagged
  /// passthrough below: content found under a dictionary that is not itself an element
  /// still belongs to something, and that something is the nearest element above it.
  fn visit(
    &mut self,
    node: &Dict<'a>,
    parent: Option<usize>,
    inherited_page: Option<usize>,
    level: usize,
  ) {
    // `/S` is what makes this an element rather than a content reference. Without it
    // there is nothing to report, but the subtree beneath it may still hold elements.
    let Some(raw_role) = node.get::<hayro_syntax::object::Name<'a>>(keys::S) else {
      self.walk_kids(node, parent, inherited_page, level);
      return;
    };
    let raw_role = raw_role.as_str().to_string();
    let role = self.roles.resolve(&raw_role);

    // `/Pg` is the page this element's content sits on, and it is inherited: a `/P`
    // that names no page uses its ancestor's. Without this, elements whose `/K` holds
    // bare integers lose the page half of the pair and cannot be joined to anything.
    let page = node
      .get_ref(keys::PG)
      .and_then(|id| self.pages.get(&id.into()).copied())
      .or(inherited_page);

    let index = self.nodes.len();
    self.nodes.push(StructNode {
      role,
      raw_role,
      level,
      content: Vec::new(),
      alt: text_string(node, keys::ALT),
      actual_text: text_string(node, keys::ACTUAL_TEXT),
      lang: text_string(node, keys::LANG),
      title: text_string(node, keys::T),
    });

    self.walk_kids(node, Some(index), page, level + 1);
  }

  /// Walk `/K`, which is the element's children *and* its content, mixed.
  ///
  /// `/K` is one of: an integer (an mcid on this element's own page), a dictionary
  /// (a child element, an `/MCR` content reference, or an `/OBJR` object reference),
  /// an array of any of those, or a reference to any of those.
  ///
  /// `owner` is the element whose `/K` this is, and it is threaded rather than taken
  /// as "the last node pushed": `/K [ <</S /Span>> 3 ]` pushes the span first, so the
  /// bare `3` that follows would otherwise be filed under the span instead of under
  /// the element that actually owns it.
  fn walk_kids(
    &mut self,
    node: &Dict<'a>,
    owner: Option<usize>,
    page: Option<usize>,
    level: usize,
  ) {
    if level >= MAX_DEPTH || self.nodes.len() >= MAX_ENTRIES {
      return;
    }
    let Some(kids) = node.get_raw::<Object<'a>>(keys::K) else {
      return;
    };
    self.walk_kid(kids, owner, page, level);
  }

  fn walk_kid(
    &mut self,
    kid: MaybeRef<Object<'a>>,
    owner: Option<usize>,
    page: Option<usize>,
    level: usize,
  ) {
    if self.nodes.len() >= MAX_ENTRIES {
      return;
    }
    let object = match kid {
      MaybeRef::Ref(id) => {
        if !self.visited.insert(id.into()) {
          return;
        }
        let Some(object) = self.xref.get::<Object<'a>>(id.into()) else {
          return;
        };
        object
      }
      // Inline: nested syntax, so it cannot point back at an ancestor.
      MaybeRef::NotRef(object) => object,
    };

    match object {
      // A bare integer is an mcid on the element's own page.
      Object::Number(number) => self.push_content(owner, page, i32::try_from(number.as_i64()).ok()),
      Object::Array(array) => self.walk_array(&array, owner, page, level),
      Object::Dict(dict) => self.walk_dict(&dict, owner, page, level),
      _ => {}
    }
  }

  fn walk_array(
    &mut self,
    array: &Array<'a>,
    owner: Option<usize>,
    page: Option<usize>,
    level: usize,
  ) {
    if level >= MAX_DEPTH {
      return;
    }
    for kid in array.raw_iter() {
      self.walk_kid(kid, owner, page, level);
    }
  }

  fn walk_dict(
    &mut self,
    dict: &Dict<'a>,
    owner: Option<usize>,
    page: Option<usize>,
    level: usize,
  ) {
    // An `/MCR` names its own page, falling back to the element's.
    let own_page = dict
      .get_ref(keys::PG)
      .and_then(|id| self.pages.get(&id.into()).copied())
      .or(page);

    match dict.get::<hayro_syntax::object::Name<'a>>(keys::TYPE) {
      Some(ty) if ty.as_str().as_bytes() == MCR => {
        self.push_content(owner, own_page, dict.get::<i32>(keys::MCID));
      }
      // `/OBJR` points at an annotation or form field, not at content in the stream.
      // It has no mcid, so there is nothing here to join text to.
      Some(ty) if ty.as_str().as_bytes() == keys::OBJR => {}
      // `/StructElem`, or an element that omitted `/Type` — which is legal, and
      // common. `visit` decides on `/S`, not on this.
      _ => self.visit(dict, owner, own_page, level),
    }
  }

  /// Attach an mcid to the element that owns it.
  ///
  /// An mcid with no page cannot be joined — the id is only unique within one content
  /// stream — so it is dropped rather than reported as unaddressable. So is one with
  /// no owner, which is content hanging directly off `/StructTreeRoot`.
  fn push_content(&mut self, owner: Option<usize>, page: Option<usize>, mcid: Option<i32>) {
    let (Some(owner), Some(page), Some(mcid)) = (owner, page, mcid) else {
      return;
    };
    let Some(node) = self.nodes.get_mut(owner) else {
      return;
    };
    node.content.push(MarkedContent { page, mcid });
  }
}

/// `/RoleMap`: the document's own tags mapped onto the standard ones.
///
/// Worth doing rather than skipping. A tagged PDF is free to name its heading
/// `/Heading1` and map that to `/H1`, and Word and InDesign both emit files that do —
/// so matching on the raw tag misses a large share of real tagged documents.
struct RoleMap {
  map: HashMap<String, String>,
}

impl RoleMap {
  fn read(root: &Dict<'_>) -> Self {
    let mut map = HashMap::new();
    if let Some(dict) = root.get::<Dict<'_>>(keys::ROLE_MAP) {
      for (name, value) in dict.entries() {
        if let MaybeRef::NotRef(Object::Name(target)) = value {
          map.insert(name.as_str().to_string(), target.as_str().to_string());
        }
      }
    }
    Self { map }
  }

  /// Follow the mapping to a standard role.
  ///
  /// Chained rather than single-step, because a document may map its own tag onto
  /// another of its own tags. The visited set is not optional: a `/RoleMap` mapping
  /// two names onto each other is malformed and does occur, and it would otherwise
  /// spin here.
  fn resolve(&self, raw: &str) -> String {
    let mut role = raw;
    let mut seen = HashSet::new();
    while let Some(next) = self.map.get(role) {
      if !seen.insert(role.to_string()) {
        break;
      }
      role = next;
    }
    role.to_string()
  }
}

fn text_string(node: &Dict<'_>, key: &[u8]) -> Option<String> {
  node
    .get::<PdfString>(key)
    .and_then(|value| decode_text_string(value.as_bytes()))
    .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::fixtures::build_pdf;
  use std::sync::Arc;

  /// A two-page tagged document whose structure tree is whatever `objects` describe.
  ///
  /// Object 1 is the catalog, 3 and 4 are the pages (0- and 1-indexed), and 6 is the
  /// structure tree root. `objects` supplies 6 upward.
  fn document(objects: &[(u32, &str)]) -> Vec<StructNode> {
    let mut all = vec![
      (
        1,
        "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R >>".to_string(),
      ),
      (
        2,
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>".to_string(),
      ),
      // Pages need `/Contents` or hayro drops them from `Pages`, which would shift
      // every page index these tests assert on.
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
    let pdf = Pdf::new(Arc::new(build_pdf(&all))).expect("fixture should parse");
    read_struct_tree(&pdf)
  }

  /// `(role, level, [(page, mcid)])` — the shape most assertions care about.
  type Summary<'a> = Vec<(&'a str, usize, Vec<(usize, i32)>)>;

  fn summary(nodes: &[StructNode]) -> Summary<'_> {
    nodes
      .iter()
      .map(|n| {
        (
          n.role.as_str(),
          n.level,
          n.content.iter().map(|c| (c.page, c.mcid)).collect(),
        )
      })
      .collect()
  }

  #[test]
  fn untagged_document_reads_empty() {
    let pdf = crate::fixtures::page_with_content("");
    assert!(read_struct_tree(&pdf).is_empty());
  }

  #[test]
  fn reads_nested_elements_in_pre_order() {
    let nodes = document(&[
      (6, "<< /Type /StructTreeRoot /K 7 0 R >>"),
      (7, "<< /S /Document /P 6 0 R /K [8 0 R 9 0 R] >>"),
      (8, "<< /S /H1 /P 7 0 R /Pg 3 0 R /K 0 >>"),
      (9, "<< /S /P /P 7 0 R /Pg 3 0 R /K [1 2] >>"),
    ]);
    assert_eq!(
      summary(&nodes),
      [
        ("Document", 0, vec![]),
        ("H1", 1, vec![(0, 0)]),
        ("P", 1, vec![(0, 1), (0, 2)]),
      ]
    );
  }

  #[test]
  fn page_is_inherited_from_an_ancestor() {
    // Only the `/Document` names a `/Pg`; both children's bare mcids still resolve.
    let nodes = document(&[
      (6, "<< /Type /StructTreeRoot /K 7 0 R >>"),
      (7, "<< /S /Document /Pg 4 0 R /K [8 0 R 9 0 R] >>"),
      (8, "<< /S /P /K 0 >>"),
      (9, "<< /S /P /Pg 3 0 R /K 1 >>"),
    ]);
    assert_eq!(
      summary(&nodes),
      [
        ("Document", 0, vec![]),
        // Inherited page 1.
        ("P", 1, vec![(1, 0)]),
        // Its own `/Pg` wins over the inherited one.
        ("P", 1, vec![(0, 1)]),
      ]
    );
  }

  #[test]
  fn mcid_follows_the_element_that_owns_it_not_the_last_one_seen() {
    // The regression this guards: `/K [ <</S /Span>> 3 ]` pushes the span first, so
    // filing content under "the most recently pushed node" would give the span the 3.
    let nodes = document(&[
      (6, "<< /Type /StructTreeRoot /K 7 0 R >>"),
      (7, "<< /S /P /Pg 3 0 R /K [0 << /S /Span /K 1 >> 2] >>"),
    ]);
    assert_eq!(
      summary(&nodes),
      [("P", 0, vec![(0, 0), (0, 2)]), ("Span", 1, vec![(0, 1)])]
    );
  }

  #[test]
  fn reads_marked_content_reference_dicts() {
    let nodes = document(&[
      (6, "<< /Type /StructTreeRoot /K 7 0 R >>"),
      (
        7,
        "<< /S /P /Pg 3 0 R /K [<< /Type /MCR /MCID 4 >> << /Type /MCR /Pg 4 0 R /MCID 5 >>] >>",
      ),
    ]);
    // The second names its own page; the first falls back to the element's.
    assert_eq!(summary(&nodes), [("P", 0, vec![(0, 4), (1, 5)])]);
  }

  #[test]
  fn object_references_carry_no_content() {
    let nodes = document(&[
      (6, "<< /Type /StructTreeRoot /K 7 0 R >>"),
      (
        7,
        "<< /S /Link /Pg 3 0 R /K [<< /Type /OBJR /Obj 8 0 R >> 0] >>",
      ),
      (8, "<< /Type /Annot /Subtype /Link >>"),
    ]);
    // The `/OBJR` contributes nothing; the bare mcid beside it still lands.
    assert_eq!(summary(&nodes), [("Link", 0, vec![(0, 0)])]);
  }

  #[test]
  fn role_map_remaps_custom_tags() {
    let nodes = document(&[
      (
        6,
        "<< /Type /StructTreeRoot /RoleMap << /Heading1 /H1 /BodyCopy /P >> /K 7 0 R >>",
      ),
      (7, "<< /S /Heading1 /Pg 3 0 R /K 0 >>"),
    ]);
    assert_eq!(nodes[0].role, "H1");
    // The document's own tag is kept beside the standard one.
    assert_eq!(nodes[0].raw_role, "Heading1");
  }

  #[test]
  fn role_map_follows_a_chain_and_survives_a_cycle() {
    let nodes = document(&[
      (
        6,
        "<< /Type /StructTreeRoot /RoleMap << /A /B /B /C /X /Y /Y /X >> /K [7 0 R 8 0 R] >>",
      ),
      (7, "<< /S /A /Pg 3 0 R /K 0 >>"),
      (8, "<< /S /X /Pg 3 0 R /K 1 >>"),
    ]);
    // `/A` -> `/B` -> `/C`, which maps to nothing further.
    assert_eq!(nodes[0].role, "C");
    // `/X` <-> `/Y` is a cycle: it terminates rather than spinning, and what it
    // settles on matters less than that it settles.
    assert!(matches!(nodes[1].role.as_str(), "X" | "Y"));
  }

  #[test]
  fn attributes_are_decoded() {
    let nodes = document(&[
      (6, "<< /Type /StructTreeRoot /K 7 0 R >>"),
      (
        7,
        "<< /S /Figure /Pg 3 0 R /Alt (A bar chart) /ActualText (fi) /Lang (en-US) \
         /T (Figure 1) /K 0 >>",
      ),
    ]);
    assert_eq!(nodes[0].alt.as_deref(), Some("A bar chart"));
    assert_eq!(nodes[0].actual_text.as_deref(), Some("fi"));
    assert_eq!(nodes[0].lang.as_deref(), Some("en-US"));
    assert_eq!(nodes[0].title.as_deref(), Some("Figure 1"));
  }

  #[test]
  fn a_kid_cycle_terminates() {
    // Two elements whose `/K` point at each other. A depth cap alone would not save
    // this; the visited set is what does.
    let nodes = document(&[
      (6, "<< /Type /StructTreeRoot /K 7 0 R >>"),
      (7, "<< /S /Sect /Pg 3 0 R /K [8 0 R] >>"),
      (8, "<< /S /Sect /Pg 3 0 R /K [7 0 R] >>"),
    ]);
    assert_eq!(nodes.len(), 2);
  }

  #[test]
  fn an_element_without_a_role_passes_its_content_to_the_parent() {
    let nodes = document(&[
      (6, "<< /Type /StructTreeRoot /K 7 0 R >>"),
      (7, "<< /S /P /Pg 3 0 R /K [<< /K 0 >>] >>"),
    ]);
    // The `/S`-less dictionary is not an element, so its mcid belongs to the `/P`.
    assert_eq!(summary(&nodes), [("P", 0, vec![(0, 0)])]);
  }
}
