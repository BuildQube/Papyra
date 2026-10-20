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

mod shapes;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use papyra_core::{Document, Engine, RenderOptions};
use papyra_encode::{EncodeOptions, ImageFormat};
use papyra_hayro::{HayroDocument, HayroEngine};
use tauri::http::{Request, Response, StatusCode};
use tauri::ipc::{InvokeBody, Response as Bytes};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, State};

use shapes::{Attachment, OutlineEntry, PageLink, PageText, StructEntry, error};

/// The documents this host holds open, by the id the WebView knows them by.
///
/// Freed only by `close`: a document the WebView forgets to close stays here until
/// the app exits, which is why the viewer closes what it opens.
#[derive(Default)]
pub struct Documents {
  next: AtomicU32,
  open: Mutex<HashMap<u32, Arc<HayroDocument>>>,
}

impl Documents {
  fn get(&self, id: u32) -> Result<Arc<HayroDocument>, String> {
    self
      .open
      .lock()
      .map_err(|e| e.to_string())?
      .get(&id)
      .cloned()
      .ok_or_else(|| format!("papyra: no open document {id}"))
  }

  fn insert(&self, doc: HayroDocument) -> Result<u32, String> {
    let id = self.next.fetch_add(1, Ordering::Relaxed);
    self
      .open
      .lock()
      .map_err(|e| e.to_string())?
      .insert(id, Arc::new(doc));
    Ok(id)
  }

  fn remove(&self, id: u32) -> Result<(), String> {
    self.open.lock().map_err(|e| e.to_string())?.remove(&id);
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

/// Parsing and rendering block, so both go to the blocking pool rather than the
/// async runtime's worker threads.
async fn blocking<T: Send + 'static>(
  work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(work)
    .await
    .map_err(|e| e.to_string())?
}

/// Header the password travels in, percent-encoded: the body is the file's bytes.
const PASSWORD_HEADER: &str = "x-papyra-password";

/// Open a PDF sent as the raw request body. Answers with its id and every page's
/// size, its metadata and its version — everything a viewer needs before it renders.
#[tauri::command]
async fn open(
  request: tauri::ipc::Request<'_>,
  docs: State<'_, Documents>,
) -> Result<shapes::Opened, String> {
  let InvokeBody::Raw(bytes) = request.body() else {
    return Err("papyra: open takes the file's bytes as the request body".into());
  };
  let bytes = bytes.clone();
  let password = match request.headers().get(PASSWORD_HEADER) {
    Some(value) => Some(
      percent_encoding::percent_decode(value.as_bytes())
        .decode_utf8()
        .map_err(|e| e.to_string())?
        .into_owned(),
    ),
    None => None,
  };
  let (doc, sizes, info, pdf_version) = blocking(move || {
    let doc = match password {
      Some(password) => HayroDocument::load_with_password(bytes, &password),
      None => HayroEngine::load(bytes),
    }
    .map_err(error)?;
    let sizes = (0..doc.page_count())
      .map(|i| doc.page_size(i).map(|s| [s.width, s.height]))
      .collect::<Result<Vec<_>, _>>()
      .map_err(error)?;
    let info = doc.metadata().into();
    let version = doc.pdf_version();
    Ok((doc, sizes, info, version))
  })
  .await?;
  Ok(shapes::Opened {
    id: docs.insert(doc)?,
    sizes,
    info,
    pdf_version,
  })
}

/// Release a document. Closing one that is not open is not an error: the WebView
/// may close on unmount after a failed open.
#[tauri::command]
fn close(id: u32, docs: State<'_, Documents>) -> Result<(), String> {
  docs.remove(id)
}

#[tauri::command]
async fn page_text(id: u32, index: usize, docs: State<'_, Documents>) -> Result<PageText, String> {
  let doc = docs.get(id)?;
  blocking(move || doc.page_text(index).map(Into::into).map_err(error)).await
}

#[tauri::command]
async fn outline(id: u32, docs: State<'_, Documents>) -> Result<Vec<OutlineEntry>, String> {
  let doc = docs.get(id)?;
  blocking(move || Ok(doc.outline().into_iter().map(Into::into).collect())).await
}

#[tauri::command]
async fn links(id: u32, index: usize, docs: State<'_, Documents>) -> Result<Vec<PageLink>, String> {
  let doc = docs.get(id)?;
  blocking(move || {
    doc
      .page_links(index)
      .map(|links| links.into_iter().map(Into::into).collect())
      .map_err(error)
  })
  .await
}

#[tauri::command]
async fn page_labels(id: u32, docs: State<'_, Documents>) -> Result<Vec<String>, String> {
  let doc = docs.get(id)?;
  blocking(move || Ok(doc.page_labels())).await
}

#[tauri::command]
async fn attachments(id: u32, docs: State<'_, Documents>) -> Result<Vec<Attachment>, String> {
  let doc = docs.get(id)?;
  blocking(move || Ok(doc.attachments().into_iter().map(Into::into).collect())).await
}

/// An attachment's bytes, as a binary response rather than a JSON array of numbers.
#[tauri::command]
async fn attachment_data(
  id: u32,
  index: usize,
  docs: State<'_, Documents>,
) -> Result<Bytes, String> {
  let doc = docs.get(id)?;
  blocking(move || doc.attachment_data(index).map(Bytes::new).map_err(error)).await
}

#[tauri::command]
async fn struct_tree(id: u32, docs: State<'_, Documents>) -> Result<Vec<StructEntry>, String> {
  let doc = docs.get(id)?;
  blocking(move || Ok(doc.struct_tree().into_iter().map(Into::into).collect())).await
}

/// How a page is sent back. PNG costs an encode here and a decode in the WebView;
/// raw RGBA costs neither and is four times the bytes over an in-process channel.
/// Which wins depends on the phone, so the caller picks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PageFormat {
  Png,
  Rgba,
}

/// A page request, parsed from `/<id>/<page>?dpi=…&annots=0|1&format=png|rgba`.
#[derive(Debug, PartialEq)]
struct PageRequest {
  id: u32,
  page: usize,
  dpi: f32,
  annotations: bool,
  format: PageFormat,
}

fn parse(path: &str, query: Option<&str>) -> Option<PageRequest> {
  let mut parts = path.trim_start_matches('/').split('/');
  let id = parts.next()?.parse().ok()?;
  let page = parts.next()?.parse().ok()?;
  if parts.next().is_some() {
    return None;
  }
  let mut request = PageRequest {
    id,
    page,
    dpi: 72.0,
    annotations: true,
    format: PageFormat::Png,
  };
  for pair in query.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
    let (key, value) = pair.split_once('=')?;
    match key {
      "dpi" => request.dpi = value.parse().ok().filter(|d: &f32| *d > 0.0)?,
      "annots" => request.annotations = value != "0",
      "format" => {
        request.format = match value {
          "png" => PageFormat::Png,
          "rgba" => PageFormat::Rgba,
          _ => return None,
        }
      }
      _ => {}
    }
  }
  Some(request)
}

/// Every response says so: the page's origin is `tauri://localhost` (or
/// `http://tauri.localhost`) and this scheme is another, so the fetch is cross-origin.
fn respond(status: StatusCode) -> tauri::http::response::Builder {
  Response::builder()
    .status(status)
    .header("Access-Control-Allow-Origin", "*")
    .header("Access-Control-Expose-Headers", "X-Width, X-Height")
}

fn failure(status: StatusCode, message: String) -> Response<Vec<u8>> {
  respond(status)
    .header("Content-Type", "text/plain; charset=utf-8")
    .body(message.into_bytes())
    .expect("a static response is valid")
}

fn render(docs: &Documents, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
  let Some(page) = parse(request.uri().path(), request.uri().query()) else {
    return failure(
      StatusCode::BAD_REQUEST,
      format!("papyra: bad page request {}", request.uri()),
    );
  };
  let doc = match docs.get(page.id) {
    Ok(doc) => doc,
    Err(e) => return failure(StatusCode::NOT_FOUND, e),
  };
  let options = RenderOptions {
    annotations: page.annotations,
    ..RenderOptions::at_dpi(page.dpi)
  };
  let bitmap = match doc.render_page(page.page, &options) {
    Ok(bitmap) => bitmap,
    Err(e) => return failure(StatusCode::UNPROCESSABLE_ENTITY, error(e)),
  };
  let (width, height) = (bitmap.width, bitmap.height);
  let (content_type, body) = match page.format {
    PageFormat::Rgba => ("application/octet-stream", Ok(bitmap.data)),
    PageFormat::Png => (
      "image/png",
      papyra_encode::encode(
        &bitmap,
        &EncodeOptions {
          format: ImageFormat::Png,
          ..Default::default()
        },
      ),
    ),
  };
  match body {
    Ok(body) => respond(StatusCode::OK)
      .header("Content-Type", content_type)
      .header("X-Width", width)
      .header("X-Height", height)
      .body(body)
      .expect("a page response is valid"),
    Err(e) => failure(StatusCode::INTERNAL_SERVER_ERROR, error(e)),
  }
}

/// The plugin. Register it with `tauri::Builder::plugin`, and allow
/// `papyra:default` in the app's capabilities.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("papyra")
    .invoke_handler(tauri::generate_handler![
      open,
      close,
      page_text,
      outline,
      links,
      page_labels,
      attachments,
      attachment_data,
      struct_tree
    ])
    .register_asynchronous_uri_scheme_protocol("papyra", |ctx, request, responder| {
      let app = ctx.app_handle().clone();
      tauri::async_runtime::spawn_blocking(move || {
        responder.respond(render(&app.state::<Documents>(), &request));
      });
    })
    .setup(|app, _| {
      app.manage(Documents::default());
      Ok(())
    })
    .build()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_a_page_request() {
    assert_eq!(
      parse("/3/12", Some("dpi=144&annots=0&format=rgba")),
      Some(PageRequest {
        id: 3,
        page: 12,
        dpi: 144.0,
        annotations: false,
        format: PageFormat::Rgba,
      })
    );
  }

  #[test]
  fn defaults_to_72_dpi_png_with_annotations() {
    let request = parse("/0/0", None).expect("a bare path is a request");
    assert_eq!(
      (request.dpi, request.annotations, request.format),
      (72.0, true, PageFormat::Png)
    );
  }

  #[test]
  fn refuses_malformed_requests() {
    for (path, query) in [
      ("/x/1", None),
      ("/1", None),
      ("/1/2/3", None),
      ("/1/2", Some("dpi=0")),
      ("/1/2", Some("dpi=-5")),
      ("/1/2", Some("format=webp")),
      ("/1/2", Some("dpi")),
    ] {
      assert_eq!(parse(path, query), None, "{path}?{query:?}");
    }
  }

  fn corpus(name: &str) -> Option<Vec<u8>> {
    std::fs::read(format!(
      "{}/../../corpus/{name}",
      env!("CARGO_MANIFEST_DIR")
    ))
    .ok()
  }

  fn get(docs: &Documents, uri: &str) -> Response<Vec<u8>> {
    render(docs, &Request::builder().uri(uri).body(Vec::new()).unwrap())
  }

  #[test]
  fn serves_a_page_as_png_and_as_rgba() {
    let Some(bytes) = corpus("tracemonkey.pdf") else {
      return;
    };
    let docs = Documents::default();
    let id = docs.insert(HayroEngine::load(bytes).unwrap()).unwrap();

    let png = get(&docs, &format!("papyra://localhost/{id}/0?dpi=72"));
    assert_eq!(png.status(), StatusCode::OK);
    assert_eq!(png.headers()["content-type"], "image/png");
    assert_eq!(png.headers()["access-control-allow-origin"], "*");
    assert!(png.body().starts_with(b"\x89PNG"));

    let rgba = get(
      &docs,
      &format!("papyra://localhost/{id}/0?dpi=72&format=rgba"),
    );
    let width: usize = rgba.headers()["x-width"].to_str().unwrap().parse().unwrap();
    let height: usize = rgba.headers()["x-height"]
      .to_str()
      .unwrap()
      .parse()
      .unwrap();
    assert_eq!(rgba.body().len(), width * height * 4);
    assert_eq!(width, 612);
  }

  #[test]
  fn answers_unknown_documents_and_pages_with_errors() {
    let Some(bytes) = corpus("tracemonkey.pdf") else {
      return;
    };
    let docs = Documents::default();
    let id = docs.insert(HayroEngine::load(bytes).unwrap()).unwrap();
    assert_eq!(
      get(&docs, "papyra://localhost/99/0").status(),
      StatusCode::NOT_FOUND
    );
    assert_eq!(
      get(&docs, &format!("papyra://localhost/{id}/999")).status(),
      StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
      get(&docs, "papyra://localhost/nope").status(),
      StatusCode::BAD_REQUEST
    );
    docs.remove(id).unwrap();
    assert!(docs.is_empty());
  }
}
