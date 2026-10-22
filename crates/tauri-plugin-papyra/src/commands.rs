//! What the WebView can call. Everything small travels here, as JSON in the shapes of
//! [`crate::models`]; pages travel over the protocol in [`crate::protocol`].

use papyra_core::{Document, Engine};
use papyra_hayro::{HayroDocument, HayroEngine};
use tauri::ipc::{InvokeBody, Response as Bytes};
use tauri::{Runtime, State, Webview};

use crate::Documents;
use crate::error::{Error, Result};
use crate::models::{Attachment, Opened, OutlineEntry, PageLink, PageText, StructEntry};

/// Parsing and rendering block, so both go to the blocking pool rather than the
/// async runtime's worker threads.
pub async fn blocking<T: Send + 'static>(
  work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
  tauri::async_runtime::spawn_blocking(work)
    .await
    .map_err(|e| Error::Host(e.to_string()))?
}

/// Header the password travels in, percent-encoded: the body is the file's bytes.
const PASSWORD_HEADER: &str = "x-papyra-password";

/// The file's bytes, which every `open` takes as the raw request body.
pub fn body(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>> {
  match request.body() {
    InvokeBody::Raw(bytes) => Ok(bytes.clone()),
    _ => Err(Error::NotBytes),
  }
}

/// A percent-encoded header, decoded: headers are ASCII, and what they carry need not be.
pub(crate) fn header(
  request: &tauri::ipc::Request<'_>,
  name: &'static str,
) -> Result<Option<String>> {
  request
    .headers()
    .get(name)
    .map(|value| {
      percent_encoding::percent_decode(value.as_bytes())
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| Error::Header(name))
    })
    .transpose()
}

/// Open a PDF sent as the raw request body. Answers with its id and every page's
/// size, its metadata and its version — everything a viewer needs before it renders.
#[tauri::command]
pub(crate) async fn open<R: Runtime>(
  webview: Webview<R>,
  request: tauri::ipc::Request<'_>,
  docs: State<'_, Documents>,
) -> Result<Opened> {
  let bytes = body(&request)?;
  let password = header(&request, PASSWORD_HEADER)?;
  let (doc, sizes, info, pdf_version) = blocking(move || {
    let doc = match password {
      Some(password) => HayroDocument::load_with_password(bytes, &password),
      None => HayroEngine::load(bytes),
    }?;
    let sizes = (0..doc.page_count())
      .map(|i| doc.page_size(i).map(|s| [s.width, s.height]))
      .collect::<std::result::Result<Vec<_>, _>>()?;
    let info = doc.metadata().into();
    let version = doc.pdf_version();
    Ok((doc, sizes, info, version))
  })
  .await?;
  Ok(Opened {
    id: docs.insert_paged(webview.label(), doc)?,
    sizes,
    info,
    pdf_version,
  })
}

/// Release a document, of any format. Closing one that is not open is not an error: the WebView
/// may close on unmount after a failed open.
#[tauri::command]
pub(crate) fn close(id: u32, docs: State<'_, Documents>) -> Result<()> {
  docs.remove(id)
}

/// How many documents the host holds, across every WebView — for an app's leak check.
/// Not in `papyra:default`; allow `papyra:allow-open-count` to use it.
#[tauri::command]
pub(crate) fn open_count(docs: State<'_, Documents>) -> usize {
  docs.len()
}

#[tauri::command]
pub(crate) async fn page_text(
  id: u32,
  index: usize,
  docs: State<'_, Documents>,
) -> Result<PageText> {
  let doc = docs.paged(id)?;
  blocking(move || Ok(doc.page_text(index)?.into())).await
}

#[tauri::command]
pub(crate) async fn outline(id: u32, docs: State<'_, Documents>) -> Result<Vec<OutlineEntry>> {
  let doc = docs.paged(id)?;
  blocking(move || Ok(doc.outline().into_iter().map(Into::into).collect())).await
}

#[tauri::command]
pub(crate) async fn links(
  id: u32,
  index: usize,
  docs: State<'_, Documents>,
) -> Result<Vec<PageLink>> {
  let doc = docs.paged(id)?;
  blocking(move || Ok(doc.page_links(index)?.into_iter().map(Into::into).collect())).await
}

#[tauri::command]
pub(crate) async fn page_labels(id: u32, docs: State<'_, Documents>) -> Result<Vec<String>> {
  let doc = docs.paged(id)?;
  blocking(move || Ok(doc.page_labels())).await
}

#[tauri::command]
pub(crate) async fn attachments(id: u32, docs: State<'_, Documents>) -> Result<Vec<Attachment>> {
  let doc = docs.paged(id)?;
  blocking(move || Ok(doc.attachments().into_iter().map(Into::into).collect())).await
}

/// An attachment's bytes, as a binary response rather than a JSON array of numbers.
#[tauri::command]
pub(crate) async fn attachment_data(
  id: u32,
  index: usize,
  docs: State<'_, Documents>,
) -> Result<Bytes> {
  let doc = docs.paged(id)?;
  blocking(move || Ok(Bytes::new(doc.attachment_data(index)?))).await
}

#[tauri::command]
pub(crate) async fn struct_tree(id: u32, docs: State<'_, Documents>) -> Result<Vec<StructEntry>> {
  let doc = docs.paged(id)?;
  blocking(move || Ok(doc.struct_tree().into_iter().map(Into::into).collect())).await
}
