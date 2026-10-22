//! TIFF, with the `tiff` feature: opening here, pages over `papyra://` like a PDF's,
//! sized by `maxWidth` and `maxPixels` rather than a DPI.

use std::sync::Arc;

use serde::Serialize;
use tauri::{Runtime, State, Webview};

use crate::commands::{blocking, body};
use crate::error::Result;
use crate::{Doc, Documents};

/// One page, in the napi bindings' `TiffPageInfo` shape, which papyra's `TiffImage`
/// reads.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TiffPage {
  pub width: u32,
  pub height: u32,
  pub x_dpi: Option<f32>,
  pub y_dpi: Option<f32>,
  pub compression: &'static str,
  pub bits_per_sample: u16,
  pub samples_per_pixel: u16,
  pub orientation: u16,
}

#[derive(Serialize)]
pub struct TiffOpened {
  pub id: u32,
  pub pages: Vec<TiffPage>,
}

/// Open a TIFF sent as the raw request body, and list its pages. Only the directory
/// is read; each page is decoded when the protocol asks for it.
#[tauri::command]
pub(crate) async fn open_tiff<R: Runtime>(
  webview: Webview<R>,
  request: tauri::ipc::Request<'_>,
  docs: State<'_, Documents>,
) -> Result<TiffOpened> {
  let bytes = body(&request)?;
  let tiff = blocking(move || Ok(papyra_tiff::Tiff::load(bytes)?)).await?;
  let pages = tiff
    .pages()
    .iter()
    .map(|p| TiffPage {
      width: p.width,
      height: p.height,
      x_dpi: p.dpi.map(|(x, _)| x),
      y_dpi: p.dpi.map(|(_, y)| y),
      compression: p.compression.as_str(),
      bits_per_sample: p.bits_per_sample,
      samples_per_pixel: p.samples_per_pixel,
      orientation: p.orientation,
    })
    .collect();
  Ok(TiffOpened {
    id: docs.insert(webview.label(), Doc::Tiff(Arc::new(tiff)))?,
    pages,
  })
}
