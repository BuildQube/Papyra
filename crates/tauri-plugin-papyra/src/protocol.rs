//! Pages, over `papyra://`.
//!
//! `GET papyra://localhost/<id>/<page>?dpi=144&annots=1&format=png` —
//! `http://papyra.localhost/…` on Android and Windows. A page is megabytes, and a
//! protocol response is bytes the WebView hands to `createImageBitmap` with no JSON
//! round trip.
//!
//! `&x=…&y=…&width=…&height=…` asks for one tile of that page instead: the window of
//! its render at `dpi` with that corner and size, so a page too large to render whole
//! can still be shown in pieces.
//!
//! A TIFF page is sized by `maxWidth` and `maxPixels` instead of `dpi`, as papyra's
//! `TiffImage.renderPage` is, and comes back in the same two formats.

use papyra_core::{Bitmap, RenderOptions, Tile};
use papyra_encode::{EncodeOptions, ImageFormat};
use tauri::http::{Request, Response, StatusCode};

use crate::error::Error;
use crate::{Doc, Documents};

/// The TypeScript wrapper's `MAX_PIXELS`, held here too: any page in the WebView can
/// fetch this scheme, and an unbounded `dpi` would allocate gigabytes in the host.
const MAX_PIXELS: f64 = 100_000_000.0;

/// How a page is sent back. PNG costs an encode here and a decode in the WebView;
/// raw RGBA costs neither and is four times the bytes over an in-process channel.
/// Which wins depends on the phone, so the caller picks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PageFormat {
  Png,
  Rgba,
}

/// A page request, parsed from `/<id>/<page>?dpi=…&annots=0|1&format=png|rgba`, plus
/// `&x=…&y=…&width=…&height=…` for a tile, or for a TIFF `?maxWidth=…&maxPixels=…&format=…`.
#[derive(Debug, PartialEq)]
struct PageRequest {
  id: u32,
  page: usize,
  dpi: f32,
  annotations: bool,
  format: PageFormat,
  max_width: Option<u32>,
  max_pixels: Option<u64>,
  tile: Option<Tile>,
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
    max_width: None,
    max_pixels: None,
    tile: None,
  };
  let (mut x, mut y, mut width, mut height) = (None, None, None, None);
  for pair in query.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
    let (key, value) = pair.split_once('=')?;
    match key {
      "dpi" => {
        request.dpi = value
          .parse()
          .ok()
          .filter(|d: &f32| d.is_finite() && *d > 0.0)?
      }
      "annots" => request.annotations = value != "0",
      "maxWidth" => request.max_width = Some(value.parse().ok().filter(|w| *w > 0)?),
      "maxPixels" => request.max_pixels = Some(value.parse().ok().filter(|p| *p > 0)?),
      "x" => x = Some(value.parse().ok()?),
      "y" => y = Some(value.parse().ok()?),
      "width" => width = Some(value.parse().ok().filter(|w: &u16| *w > 0)?),
      "height" => height = Some(value.parse().ok().filter(|h: &u16| *h > 0)?),
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
  request.tile = match (x, y, width, height) {
    (None, None, None, None) => None,
    (Some(x), Some(y), Some(width), Some(height)) => Some(Tile {
      x,
      y,
      width,
      height,
    }),
    _ => return None,
  };
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

/// [`render`], answering a panic in the engine with a 500 that carries it. Without
/// this the responder is dropped unanswered and the WebView's fetch never settles —
/// a page that spins forever. Needs unwinding: an app built with `panic = "abort"`
/// loses the process instead.
pub(crate) fn serve(docs: &Documents, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
  std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render(docs, request))).unwrap_or_else(
    |panic| {
      let message = panic
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_default();
      failure(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("papyra: rendering panicked: {message}"),
      )
    },
  )
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
  let bitmap = match doc {
    Doc::Paged(doc) => {
      let pixels = match doc.page_size(page.page) {
        Ok(size) => match page.tile {
          Some(tile) => f64::from(tile.width) * f64::from(tile.height),
          None => {
            let scale = f64::from(page.dpi) / 72.0;
            (f64::from(size.width) * scale).floor() * (f64::from(size.height) * scale).floor()
          }
        },
        Err(e) => return failure(StatusCode::UNPROCESSABLE_ENTITY, Error::from(e).to_string()),
      };
      if pixels > MAX_PIXELS {
        return failure(
          StatusCode::PAYLOAD_TOO_LARGE,
          format!(
            "papyra: {pixels} pixels at {} dpi is over the 100 MP cap",
            page.dpi
          ),
        );
      }
      let options = RenderOptions {
        annotations: page.annotations,
        ..RenderOptions::at_dpi(page.dpi)
      };
      match page.tile {
        Some(tile) => doc.render_tile(page.page, &options, tile),
        None => doc.render_page(page.page, &options),
      }
      .map_err(Error::from)
    }
    #[cfg(feature = "tiff")]
    Doc::Tiff(tiff) => {
      let mut options = papyra_tiff::RenderOptions {
        max_width: page.max_width,
        ..Default::default()
      };
      if let Some(n) = page.max_pixels {
        // Never enlarged, but a full-size scan can still be gigabytes.
        options.max_pixels = n.min(MAX_PIXELS as u64);
      }
      tiff.render(page.page, &options).map_err(Error::from)
    }
    #[cfg(feature = "tables")]
    Doc::Workbook(..) => Err(Error::WrongKind(page.id, "paged document")),
  };
  match bitmap {
    Ok(bitmap) => respond_page(bitmap, page.format),
    Err(e) => failure(StatusCode::UNPROCESSABLE_ENTITY, e.to_string()),
  }
}

fn respond_page(bitmap: Bitmap, format: PageFormat) -> Response<Vec<u8>> {
  let (width, height) = (bitmap.width, bitmap.height);
  let (content_type, body) = match format {
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
        max_width: None,
        max_pixels: None,
        tile: None,
      })
    );
    assert_eq!(
      parse("/3/12", Some("dpi=600&x=1024&y=0&width=1024&height=512")).and_then(|r| r.tile),
      Some(Tile {
        x: 1024,
        y: 0,
        width: 1024,
        height: 512,
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
      ("/1/2", Some("dpi=inf")),
      ("/1/2", Some("dpi=NaN")),
      ("/1/2", Some("maxWidth=0")),
      ("/1/2", Some("maxWidth=-1")),
      ("/1/2", Some("maxPixels=x")),
      ("/1/2", Some("x=0&y=0&width=8")),
      ("/1/2", Some("x=-1&y=0&width=8&height=8")),
      ("/1/2", Some("x=0&y=0&width=0&height=8")),
      ("/1/2", Some("x=0&y=0&width=65536&height=8")),
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
      .insert_paged("main", HayroEngine::load(bytes).unwrap())
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

    // 100000 dpi is refused for the page below; one tile of it is not, and the 100 MP
    // guard reads the tile's pixels instead.
    let tile = |w: u32| {
      format!(
        "papyra://localhost/{id}/0?dpi=100000&x=400000&y=500000&width={w}&height=300&format=rgba"
      )
    };
    let ok = get(&docs, &tile(200));
    assert_eq!(ok.status(), StatusCode::OK);
    assert_eq!(ok.headers()["x-width"], "200");
    assert_eq!(ok.body().len(), 200 * 300 * 4);
    assert_eq!(
      get(&docs, &tile(65535).replace("height=300", "height=65535")).status(),
      StatusCode::PAYLOAD_TOO_LARGE
    );
  }

  #[test]
  fn answers_unknown_documents_and_pages_with_errors() {
    let Some(bytes) = corpus("tracemonkey.pdf") else {
      return;
    };
    let docs = Documents::default();
    let id = docs
      .insert_paged("main", HayroEngine::load(bytes).unwrap())
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
      get(&docs, &format!("papyra://localhost/{id}/0?dpi=100000")).status(),
      StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
      get(&docs, "papyra://localhost/nope").status(),
      StatusCode::BAD_REQUEST
    );
    docs.remove(id).unwrap();
    assert!(docs.is_empty());
  }

  #[cfg(feature = "tiff")]
  #[test]
  fn serves_a_tiff_page_at_its_max_width_in_either_format() {
    let bytes = std::fs::read(format!(
      "{}/../papyra-tiff/tests/fixtures/g4.tif",
      env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let docs = Documents::default();
    let id = docs
      .insert(
        "main",
        Doc::Tiff(std::sync::Arc::new(papyra_tiff::Tiff::load(bytes).unwrap())),
      )
      .unwrap();
    let rgba = get(
      &docs,
      &format!("papyra://localhost/{id}/0?maxWidth=50&format=rgba"),
    );
    assert_eq!(rgba.status(), StatusCode::OK);
    let width: usize = rgba.headers()["x-width"].to_str().unwrap().parse().unwrap();
    let height: usize = rgba.headers()["x-height"]
      .to_str()
      .unwrap()
      .parse()
      .unwrap();
    assert_eq!(width, 50);
    assert_eq!(rgba.body().len(), width * height * 4);

    let png = get(&docs, &format!("papyra://localhost/{id}/0?maxWidth=50"));
    assert_eq!(png.headers()["content-type"], "image/png");
    assert!(png.body().starts_with(b"\x89PNG"));
    assert!(
      png.body().len() < rgba.body().len() / 10,
      "bilevel compresses"
    );
    assert_eq!(
      get(&docs, &format!("papyra://localhost/{id}/9")).status(),
      StatusCode::UNPROCESSABLE_ENTITY
    );
  }

  /// A page whose engine panics, as a malformed file can make WordCraft or hayro do.
  #[derive(Debug)]
  struct Panics;

  impl papyra_core::Document for Panics {
    fn page_count(&self) -> usize {
      1
    }
    fn page_size(&self, _: usize) -> papyra_core::Result<papyra_core::PageSize> {
      Ok(papyra_core::PageSize {
        width: 10.0,
        height: 10.0,
      })
    }
    fn render_page(&self, _: usize, _: &RenderOptions) -> papyra_core::Result<Bitmap> {
      panic!("a malformed page");
    }
  }

  #[test]
  fn a_panicking_render_is_answered_not_dropped() {
    let docs = Documents::default();
    let id = docs.insert_paged("main", Panics).unwrap();
    let request = Request::builder()
      .uri(format!("papyra://localhost/{id}/0"))
      .body(Vec::new())
      .unwrap();
    let response = serve(&docs, &request);
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.headers()["access-control-allow-origin"], "*");
    assert!(String::from_utf8_lossy(response.body()).contains("a malformed page"));
  }
}
