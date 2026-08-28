//! Resolving PDF destinations against a document.
//!
//! Shared by the outline walk and the link reader, which address destinations
//! identically: a `/Dest` or a `/A` GoTo action, holding either an explicit array or a
//! name that has to be looked up in the document's name tree.
//!
//! Two things make this more than a lookup. Destinations are addressed four different
//! ways (explicit array, name tree, `/A` action, legacy `/Dests` dictionary), and real
//! files contain cyclic `/Kids`, so the tree walk needs a guard that terminates rather
//! than a depth limit that merely delays the hang.

use hayro_syntax::Pdf;
use hayro_syntax::object::dict::keys;
use hayro_syntax::object::{Array, Dict, MaybeRef, Name, Null, Object, ObjectIdentifier};
use hayro_syntax::xref::XRef;
use papyra_core::{Destination, DestinationView};
use std::collections::{HashMap, HashSet};

/// Depth cap for nested structures. Real documents nest a handful deep; anything past
/// this is malformed or hostile.
pub const MAX_DEPTH: usize = 32;

/// Ceiling on entries visited, as a second backstop beside the cycle guard.
pub const MAX_ENTRIES: usize = 50_000;

/// Everything needed to turn a destination into a page index and a view.
///
/// The page map and the name tree are whole-document tables, so a resolver is built
/// once and reused for every destination read against it — every entry of an outline,
/// every annotation on a page.
pub struct Resolver<'a> {
  xref: &'a XRef,
  pages: HashMap<ObjectIdentifier, usize>,
  names: NameTree<'a>,
}

impl<'a> Resolver<'a> {
  pub fn new(pdf: &'a Pdf) -> Option<Self> {
    let xref = pdf.xref();
    let catalog = xref.get::<Dict>(xref.root_id())?;
    Some(Self {
      xref,
      pages: page_index_by_ref(pdf),
      names: NameTree::read(xref, &catalog),
    })
  }

  pub fn xref(&self) -> &'a XRef {
    self.xref
  }

  /// Resolve a dictionary that may carry a destination — an outline entry, or a link
  /// annotation. Both spell it the same way.
  ///
  /// A destination is either `/Dest`, or a `/A` GoTo action's `/D`; either may be an
  /// explicit array or a name pointing into the document's name tree.
  pub fn resolve(&self, node: &Dict<'a>) -> Option<Destination> {
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

  pub fn destination_from(&self, object: Object<'a>) -> Option<Destination> {
    match object {
      Object::Array(array) => self.destination_from_array(&array),
      Object::Name(name) => self.named(&name),
      Object::String(string) => self.named(string.as_bytes()),
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

  fn named(&self, name: &[u8]) -> Option<Destination> {
    match self.names.get(name, self.xref)? {
      // Either the array itself, or a dict wrapping it in `/D`.
      Object::Array(array) => self.destination_from_array(&array),
      Object::Dict(dict) => self.destination_from_array(&dict.get::<Array<'a>>(keys::D)?),
      _ => None,
    }
  }
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
