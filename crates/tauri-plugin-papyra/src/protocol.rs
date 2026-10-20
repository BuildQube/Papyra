//! Pages, over `papyra://`.
//!
//! `GET papyra://localhost/<id>/<page>?dpi=144&annots=1&format=png` —
//! `http://papyra.localhost/…` on Android and Windows. A page is megabytes, and a
//! protocol response is bytes the WebView hands to `createImageBitmap` with no JSON
//! round trip.

use papyra_core::{Document, RenderOptions};
use papyra_encode::{EncodeOptions, ImageFormat};
use tauri::http::{Request, Response, StatusCode};

use crate::Documents;
use crate::error::Error;

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

pub(crate) fn render(docs: &Documents, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
  let Some(page) = parse(request.uri().path(), request.uri().query()) else {
    return failure(
      StatusCode::BAD_REQUEST,
      format!("papyra: bad page request {}", request.uri()),
    );
  };
  let doc = match docs.get(page.id) {
    Ok(doc) => doc,
    Err(e) => return failure(StatusCode::NOT_FOUND, e.to_string()),
  };
  let options = RenderOptions {
    annotations: page.annotations,
    ..RenderOptions::at_dpi(page.dpi)
  };
  let bitmap = match doc.render_page(page.page, &options) {
    Ok(bitmap) => bitmap,
    Err(e) => return failure(StatusCode::UNPROCESSABLE_ENTITY, Error::from(e).to_string()),
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
    Err(e) => failure(
      StatusCode::INTERNAL_SERVER_ERROR,
      Error::from(e).to_string(),
    ),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use papyra_core::Engine;
  use papyra_hayro::HayroEngine;

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
    let id = docs
      .insert("main", HayroEngine::load(bytes).unwrap())
      .unwrap();

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
    let id = docs
      .insert("main", HayroEngine::load(bytes).unwrap())
      .unwrap();
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
