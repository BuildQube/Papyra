//! What crosses the IPC boundary, field for field the shapes the napi bindings hand
//! the TypeScript wrapper — so the wrapper's own normalisers (`toPageText`,
//! `buildOutlineTree`, `toPageLink`, …) read these unchanged, and an outline or a
//! link means the same thing whichever host produced it.

use papyra_core::{DestinationView as V, PapyraError};
use serde::Serialize;

/// Prefixes the TypeScript side strips to rethrow a typed password error, exactly
/// as the napi bindings tag theirs.
const TAG_PASSWORD_REQUIRED: &str = "papyra/password-required";
const TAG_INCORRECT_PASSWORD: &str = "papyra/incorrect-password";

/// A failure as the message the TypeScript engine receives.
pub fn error(e: PapyraError) -> String {
  match &e {
    PapyraError::PasswordRequired => format!("{TAG_PASSWORD_REQUIRED} {e}"),
    PapyraError::IncorrectPassword => format!("{TAG_INCORRECT_PASSWORD} {e}"),
    _ => e.to_string(),
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
  pub id: u32,
  /// `[width, height]` per page, at 72 DPI: the viewer lays out before it renders.
  pub sizes: Vec<[f32; 2]>,
  pub info: DocumentInfo,
  pub pdf_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
  pub title: Option<String>,
  pub author: Option<String>,
  pub subject: Option<String>,
  pub keywords: Option<String>,
  pub creator: Option<String>,
  pub producer: Option<String>,
  pub created: Option<String>,
  pub modified: Option<String>,
}

impl From<papyra_core::Metadata> for DocumentInfo {
  fn from(m: papyra_core::Metadata) -> Self {
    Self {
      title: m.title,
      author: m.author,
      subject: m.subject,
      keywords: m.keywords,
      creator: m.creator,
      producer: m.producer,
      created: m.created,
      modified: m.modified,
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineDestination {
  pub page: u32,
  pub kind: &'static str,
  pub left: Option<f32>,
  pub top: Option<f32>,
  pub right: Option<f32>,
  pub bottom: Option<f32>,
  pub zoom: Option<f32>,
}

impl From<papyra_core::Destination> for OutlineDestination {
  fn from(d: papyra_core::Destination) -> Self {
    let at = |kind| Self {
      page: d.page_index as u32,
      kind,
      left: None,
      top: None,
      right: None,
      bottom: None,
      zoom: None,
    };
    match d.view {
      V::XyZ { left, top, zoom } => Self {
        left,
        top,
        zoom,
        ..at("XYZ")
      },
      V::Fit => at("Fit"),
      V::FitH { top } => Self { top, ..at("FitH") },
      V::FitV { left } => Self { left, ..at("FitV") },
      V::FitR {
        left,
        bottom,
        right,
        top,
      } => Self {
        left: Some(left),
        bottom: Some(bottom),
        right: Some(right),
        top: Some(top),
        ..at("FitR")
      },
      V::FitB => at("FitB"),
      V::FitBH { top } => Self { top, ..at("FitBH") },
      V::FitBV { left } => Self {
        left,
        ..at("FitBV")
      },
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineEntry {
  pub title: String,
  pub level: u32,
  pub dest: Option<OutlineDestination>,
  pub bold: bool,
  pub italic: bool,
  pub open: bool,
}

impl From<papyra_core::OutlineItem> for OutlineEntry {
  fn from(item: papyra_core::OutlineItem) -> Self {
    Self {
      title: item.title,
      level: item.level as u32,
      dest: item.dest.map(Into::into),
      bold: item.bold,
      italic: item.italic,
      open: item.open,
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageLink {
  pub x0: f32,
  pub y0: f32,
  pub x1: f32,
  pub y1: f32,
  pub dest: Option<OutlineDestination>,
  pub uri: Option<String>,
  pub alt: Option<String>,
}

impl From<papyra_core::Link> for PageLink {
  fn from(link: papyra_core::Link) -> Self {
    let (dest, uri) = match link.target {
      papyra_core::LinkTarget::Internal(dest) => (Some(dest.into()), None),
      papyra_core::LinkTarget::Uri(uri) => (None, Some(uri)),
    };
    Self {
      x0: link.rect.x0,
      y0: link.rect.y0,
      x1: link.rect.x1,
      y1: link.rect.y1,
      dest,
      uri,
      alt: link.alt,
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLine {
  pub text: String,
  pub offsets: Vec<f32>,
  pub x: f32,
  pub y: f32,
  pub dx: f32,
  pub dy: f32,
  pub ascent: f32,
  pub descent: f32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub mcid: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageText {
  pub lines: Vec<TextLine>,
  pub undecoded_glyphs: u32,
}

impl From<papyra_core::PageText> for PageText {
  fn from(text: papyra_core::PageText) -> Self {
    Self {
      lines: text
        .lines
        .into_iter()
        .map(|line| TextLine {
          text: line.text,
          offsets: line.offsets,
          x: line.x,
          y: line.y,
          dx: line.dx,
          dy: line.dy,
          ascent: line.ascent,
          descent: line.descent,
          mcid: line.mcid,
        })
        .collect(),
      undecoded_glyphs: text.undecoded_glyphs,
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkedContent {
  pub page: u32,
  pub mcid: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructEntry {
  pub role: String,
  pub raw_role: String,
  pub level: u32,
  pub content: Vec<MarkedContent>,
  pub alt: Option<String>,
  pub actual_text: Option<String>,
  pub lang: Option<String>,
  pub title: Option<String>,
}

impl From<papyra_core::StructNode> for StructEntry {
  fn from(node: papyra_core::StructNode) -> Self {
    Self {
      role: node.role,
      raw_role: node.raw_role,
      level: node.level as u32,
      content: node
        .content
        .into_iter()
        .map(|c| MarkedContent {
          page: c.page as u32,
          mcid: c.mcid,
        })
        .collect(),
      alt: node.alt,
      actual_text: node.actual_text,
      lang: node.lang,
      title: node.title,
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
  pub name: String,
  pub description: Option<String>,
  pub media_type: Option<String>,
  pub size: Option<u64>,
  pub created: Option<String>,
  pub modified: Option<String>,
  pub relationship: Option<String>,
}

impl From<papyra_core::Attachment> for Attachment {
  fn from(a: papyra_core::Attachment) -> Self {
    Self {
      name: a.name,
      description: a.description,
      media_type: a.media_type,
      size: a.size,
      created: a.created,
      modified: a.modified,
      relationship: a.relationship,
    }
  }
}
