//! papyra's PDF engine inside a Tauri 2 app.
//!
//! The WebView side is `TauriEngine` from `@build-qube/papyra-tauri`. Documents are
//! parsed and rendered here, on the host's real cores, so the viewer needs no
//! cross-origin isolation, no wasm, and nothing of the main thread but the paint.
//!
//! ```ignore
//! tauri::Builder::default().plugin(tauri_plugin_papyra::init())
//! ```
//!
//! and `"papyra:default"` in the app's capabilities.
//!
//! Two channels, because the payloads are so different:
//!
//! - **Commands** carry everything small — opening, text, outline, links — as JSON in
//!   the shapes papyra's TypeScript wrapper already reads.
//! - **The `papyra://` protocol** carries pages: `GET papyra://localhost/<id>/<page>
//!   ?dpi=144&annots=1&format=png`. A page is megabytes, and a protocol response is
//!   bytes the WebView can hand to `createImageBitmap` without a JSON round trip.

mod commands;
mod error;
mod models;
mod protocol;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use papyra_hayro::HayroDocument;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, Runtime};

pub use error::{Error, Result};

/// The documents this host holds open, by the id the WebView knows them by, each
/// with the label of the WebView that opened it.
///
/// Freed by `close`, and all of a WebView's at once when it loads a page: a reload —
/// dev HMR, recovering from a crash, a session expiring — loses every id the old
/// page held, and nothing could ever close those documents again.
#[derive(Default)]
pub struct Documents {
  next: AtomicU32,
  open: Mutex<HashMap<u32, (String, Arc<HayroDocument>)>>,
}

impl Documents {
  pub(crate) fn get(&self, id: u32) -> Result<Arc<HayroDocument>> {
    self
      .open
      .lock()
      .map_err(|e| Error::Host(e.to_string()))?
      .get(&id)
      .map(|(_, doc)| doc.clone())
      .ok_or(Error::NotOpen(id))
  }

  pub(crate) fn insert(&self, webview: &str, doc: HayroDocument) -> Result<u32> {
    let id = self.next.fetch_add(1, Ordering::Relaxed);
    self
      .open
      .lock()
      .map_err(|e| Error::Host(e.to_string()))?
      .insert(id, (webview.to_string(), Arc::new(doc)));
    Ok(id)
  }

  /// Drop everything one WebView opened; how many that was.
  fn release(&self, webview: &str) -> usize {
    let Ok(mut open) = self.open.lock() else {
      return 0;
    };
    let before = open.len();
    open.retain(|_, (owner, _)| owner != webview);
    before - open.len()
  }

  pub(crate) fn remove(&self, id: u32) -> Result<()> {
    self
      .open
      .lock()
      .map_err(|e| Error::Host(e.to_string()))?
      .remove(&id);
    Ok(())
  }

  /// How many documents are open: for a test, or a leak check from the app.
  pub fn len(&self) -> usize {
    self.open.lock().map(|open| open.len()).unwrap_or(0)
  }

  /// Whether nothing is open.
  pub fn is_empty(&self) -> bool {
    self.len() == 0
  }
}

/// The plugin. Register it with `tauri::Builder::plugin`, and allow
/// `papyra:default` in the app's capabilities.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("papyra")
    .invoke_handler(tauri::generate_handler![
      commands::open,
      commands::close,
      commands::open_count,
      commands::page_text,
      commands::outline,
      commands::links,
      commands::page_labels,
      commands::attachments,
      commands::attachment_data,
      commands::struct_tree
    ])
    .register_asynchronous_uri_scheme_protocol("papyra", |ctx, request, responder| {
      let app = ctx.app_handle().clone();
      tauri::async_runtime::spawn_blocking(move || {
        responder.respond(protocol::render(&app.state::<Documents>(), &request));
      });
    })
    .setup(|app, _| {
      app.manage(Documents::default());
      Ok(())
    })
    .on_page_load(|webview, payload| {
      if payload.event() == PageLoadEvent::Started {
        webview.state::<Documents>().release(webview.label());
      }
    })
    .build()
}

#[cfg(test)]
mod tests {
  use super::*;
  use papyra_core::Engine;
  use papyra_hayro::HayroEngine;

  fn corpus(name: &str) -> Option<Vec<u8>> {
    std::fs::read(format!(
      "{}/../../corpus/{name}",
      env!("CARGO_MANIFEST_DIR")
    ))
    .ok()
  }

  #[test]
  fn a_page_load_releases_only_that_webviews_documents() {
    let Some(bytes) = corpus("tracemonkey.pdf") else {
      return;
    };
    let docs = Documents::default();
    let mine = docs
      .insert("main", HayroEngine::load(bytes.clone()).unwrap())
      .unwrap();
    docs
      .insert("main", HayroEngine::load(bytes.clone()).unwrap())
      .unwrap();
    let theirs = docs
      .insert("other", HayroEngine::load(bytes).unwrap())
      .unwrap();
    assert_eq!(docs.release("main"), 2);
    assert!(docs.get(mine).is_err());
    assert!(docs.get(theirs).is_ok());
    assert_eq!(docs.len(), 1);
  }
}
