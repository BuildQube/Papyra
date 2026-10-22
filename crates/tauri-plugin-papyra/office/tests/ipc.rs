//! The office plugin through Tauri's real IPC dispatch, beside the PDF plugin whose
//! document table it opens into.

use tauri::Manager;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;

#[path = "../../tests/common/acl.rs"]
mod acl;

fn sample(name: &str) -> Vec<u8> {
  std::fs::read(format!(
    "{}/../../../apps/demo/public/{name}",
    env!("CARGO_MANIFEST_DIR")
  ))
  .expect("the demo's sample")
}

fn call(
  webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
  cmd: &str,
  body: InvokeBody,
) -> Result<InvokeResponseBody, serde_json::Value> {
  get_ipc_response(
    webview,
    InvokeRequest {
      cmd: cmd.to_string(),
      callback: CallbackFn(0),
      error: CallbackFn(1),
      url: "tauri://localhost".parse().unwrap(),
      body,
      headers: Default::default(),
      invoke_key: INVOKE_KEY.to_string(),
    },
  )
}

#[test]
fn opens_into_the_shared_table_and_closes_through_the_pdf_plugin() {
  let context = acl::context(
    &[
      ("papyra", concat!(env!("CARGO_MANIFEST_DIR"), "/..")),
      ("papyra-office", env!("CARGO_MANIFEST_DIR")),
    ],
    &["papyra:default", "papyra-office:default"],
  );
  let app = mock_builder()
    .plugin(tauri_plugin_papyra::init())
    .plugin(tauri_plugin_papyra_office::init())
    .build(context)
    .expect("the mock app builds");
  let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
    .build()
    .expect("the mock webview builds");

  let opened: serde_json::Value = call(
    &webview,
    "plugin:papyra-office|open",
    InvokeBody::Raw(sample("sample.docx")),
  )
  .unwrap()
  .deserialize()
  .unwrap();
  assert_eq!(opened["kind"], "word");
  assert_eq!(
    opened["sizes"],
    serde_json::json!([[612.0, 792.0], [612.0, 792.0]])
  );
  let docs = app.state::<tauri_plugin_papyra::Documents>();
  assert_eq!(docs.len(), 1);

  let refused = call(
    &webview,
    "plugin:papyra-office|open",
    InvokeBody::Raw(b"not a zip".to_vec()),
  )
  .unwrap_err();
  assert!(refused.as_str().unwrap().contains("not a Word document"));

  let faces: usize = call(
    &webview,
    "plugin:papyra-office|add_font",
    InvokeBody::Raw(b"not a font".to_vec()),
  )
  .unwrap()
  .deserialize()
  .unwrap();
  assert_eq!(faces, 0);

  call(
    &webview,
    "plugin:papyra|close",
    InvokeBody::Json(serde_json::json!({ "id": opened["id"] })),
  )
  .unwrap();
  assert!(docs.is_empty());
}
