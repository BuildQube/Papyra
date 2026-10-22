//! Word and PowerPoint for `tauri-plugin-papyra`, over WordCraft and DeckCraft.
//!
//! The WebView side is `TauriOfficeEngine` from `@build-qube/papyra-tauri`. Only
//! opening and fonts are here: an opened document goes into `tauri-plugin-papyra`'s
//! table, so its pages come over the same `papyra://` protocol as a PDF's and `close`
//! frees it. Register both plugins, and allow `papyra:default` and
//! `papyra-office:default`:
//!
//! ```ignore
//! tauri::Builder::default()
//!   .plugin(tauri_plugin_papyra::init())
//!   .plugin(tauri_plugin_papyra_office::init())
//! ```
//!
//! Not on crates.io, because WordCraft and DeckCraft are not: take this crate and
//! `tauri-plugin-papyra` from the repository at the same tag.

use papyra_core::{Bitmap, Document, PageSize, PapyraError, RenderOptions};
use papyra_office::{OfficeDocument, OfficeError};
use serde::Serialize;
use tauri::ipc::InvokeBody;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, State, Webview};
use tauri_plugin_papyra::Documents;

/// An office document as papyra's `Document`: pages only, which is all the page
/// column asks of it. Every reader it lacks answers empty, by the trait's defaults.
struct Office(OfficeDocument);

impl std::fmt::Debug for Office {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_tuple("Office").field(&self.0.kind()).finish()
  }
}

fn papyra_error(e: OfficeError) -> PapyraError {
  match e {
    OfficeError::PageOutOfRange(index) => PapyraError::PageOutOfRange(index),
    e => PapyraError::Unsupported(e.to_string()),
  }
}

impl Document for Office {
  fn page_count(&self) -> usize {
    self.0.page_count()
  }

  fn page_size(&self, index: usize) -> papyra_core::Result<PageSize> {
    self.0.page_size(index).map_err(papyra_error)
  }

  fn render_page(&self, index: usize, opts: &RenderOptions) -> papyra_core::Result<Bitmap> {
    self.0.render(index, opts.scale).map_err(papyra_error)
  }
}

/// The plugin's answer to `open`: what the page column needs before it renders.
#[derive(Serialize)]
pub struct Opened {
  pub id: u32,
  /// `"word"` or `"slides"`.
  pub kind: &'static str,
  /// `[width, height]` per page, in points.
  pub sizes: Vec<[f32; 2]>,
}

/// Laying out a document blocks — a Word file is paginated while it opens — so it
/// runs on the blocking pool.
async fn blocking<T: Send + 'static>(
  work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(work)
    .await
    .map_err(|e| e.to_string())?
}

fn bytes(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
  match request.body() {
    InvokeBody::Raw(bytes) => Ok(bytes.clone()),
    _ => Err("papyra: open takes the file's bytes as the request body".into()),
  }
}

/// Open a `.docx` or `.pptx` sent as the raw request body.
#[tauri::command]
async fn open<R: Runtime>(
  webview: Webview<R>,
  request: tauri::ipc::Request<'_>,
  docs: State<'_, Documents>,
) -> Result<Opened, String> {
  let bytes = bytes(&request)?;
  let doc = blocking(move || OfficeDocument::load(&bytes).map_err(|e| e.to_string())).await?;
  let sizes = (0..doc.page_count())
    .map(|i| doc.page_size(i).map(|s| [s.width, s.height]))
    .collect::<Result<_, _>>()
    .map_err(|e| e.to_string())?;
  let kind = doc.kind().as_str();
  let id = docs
    .insert_paged(webview.label(), Office(doc))
    .map_err(|e| e.to_string())?;
  Ok(Opened { id, kind, sizes })
}

/// Make a font sent as the raw request body available to every document opened
/// after this. How many faces it added: 0 for bytes that are not a font, or a font
/// already registered.
#[tauri::command]
async fn add_font(request: tauri::ipc::Request<'_>) -> Result<usize, String> {
  let bytes = bytes(&request)?;
  blocking(move || Ok(papyra_office::add_font(bytes))).await
}

/// The plugin. Register it after `tauri_plugin_papyra::init()`, whose document table
/// it opens into, and allow `papyra-office:default`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("papyra-office")
    .invoke_handler(tauri::generate_handler![open, add_font])
    .build()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn renders_at_the_scale_the_protocol_asks_for() {
    let bytes = std::fs::read(concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/../../../apps/demo/public/sample.pptx"
    ))
    .unwrap();
    let doc = Office(OfficeDocument::load(&bytes).unwrap());
    let size = doc.page_size(0).unwrap();
    let page = doc.render_page(0, &RenderOptions::at_dpi(144.0)).unwrap();
    assert_eq!(page.width, (size.width * 2.0) as u32);
    assert!(matches!(
      doc.page_size(999),
      Err(PapyraError::PageOutOfRange(999))
    ));
  }
}
