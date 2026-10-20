//! The plugin's commands through Tauri's real IPC dispatch, on the mock runtime:
//! registration, the capability check, argument names, raw bodies and headers.

use tauri::Manager;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context, noop_assets};
use tauri::webview::InvokeRequest;

fn corpus(name: &str) -> Option<Vec<u8>> {
  std::fs::read(format!(
    "{}/../../corpus/{name}",
    env!("CARGO_MANIFEST_DIR")
  ))
  .ok()
}

/// The mock context has no ACL, so it would refuse every plugin command. Grant this
/// plugin's commands to the `main` window — what `papyra:default` resolves to.
fn context() -> tauri::Context<tauri::test::MockRuntime> {
  use tauri_utils::acl::manifest::Manifest;
  use tauri_utils::acl::resolved::{Resolved, ResolvedCommand};
  const COMMANDS: &[&str] = &[
    "open",
    "close",
    "page_text",
    "outline",
    "links",
    "page_labels",
    "attachments",
    "attachment_data",
    "struct_tree",
  ];
  let allowed_commands = COMMANDS
    .iter()
    .map(|cmd| {
      let resolved = ResolvedCommand {
        windows: vec![glob::Pattern::new("main").unwrap()],
        ..Default::default()
      };
      (format!("plugin:papyra|{cmd}"), vec![resolved])
    })
    .collect();
  let acl = [(
    "papyra".to_string(),
    Manifest {
      default_permission: None,
      permissions: Default::default(),
      permission_sets: Default::default(),
      global_scope_schema: None,
    },
  )]
  .into_iter()
  .collect();
  let mut context = mock_context(noop_assets());
  *context.runtime_authority_mut() = tauri::ipc::RuntimeAuthority::new(
    acl,
    Resolved {
      allowed_commands,
      ..Default::default()
    },
  );
  context
}

fn app() -> (
  tauri::App<tauri::test::MockRuntime>,
  tauri::WebviewWindow<tauri::test::MockRuntime>,
) {
  let app = mock_builder()
    .plugin(tauri_plugin_papyra::init())
    .build(context())
    .expect("the mock app builds");
  let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
    .build()
    .expect("the mock webview builds");
  (app, webview)
}

fn call(
  webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
  cmd: &str,
  body: InvokeBody,
  headers: &[(&'static str, &str)],
) -> Result<InvokeResponseBody, serde_json::Value> {
  let mut map = tauri::http::HeaderMap::new();
  for (key, value) in headers {
    map.insert(*key, value.parse().unwrap());
  }
  get_ipc_response(
    webview,
    InvokeRequest {
      cmd: format!("plugin:papyra|{cmd}"),
      callback: CallbackFn(0),
      error: CallbackFn(1),
      url: "tauri://localhost".parse().unwrap(),
      body,
      headers: map,
      invoke_key: INVOKE_KEY.to_string(),
    },
  )
}

fn json(body: InvokeResponseBody) -> serde_json::Value {
  body.deserialize().expect("a JSON response")
}

#[test]
fn opens_reads_and_closes_through_ipc() {
  let Some(bytes) = corpus("basicapi.pdf") else {
    return;
  };
  let (app, webview) = app();

  let opened = json(call(&webview, "open", InvokeBody::Raw(bytes), &[]).unwrap());
  let id = opened["id"].as_u64().unwrap();
  assert_eq!(opened["sizes"].as_array().unwrap().len(), 3);
  assert!(opened["sizes"][0][0].as_f64().unwrap() > 500.0);

  let args = |extra: serde_json::Value| {
    let mut args = serde_json::json!({ "id": id });
    args
      .as_object_mut()
      .unwrap()
      .extend(extra.as_object().unwrap().clone());
    InvokeBody::Json(args)
  };
  let outline = json(call(&webview, "outline", args(serde_json::json!({})), &[]).unwrap());
  assert_eq!(outline[0]["title"], "INDEX");
  let text = json(
    call(
      &webview,
      "page_text",
      args(serde_json::json!({ "index": 0 })),
      &[],
    )
    .unwrap(),
  );
  assert!(text["lines"].as_array().unwrap().len() > 0);
  assert!(text["undecodedGlyphs"].is_number());
  let links = json(
    call(
      &webview,
      "links",
      args(serde_json::json!({ "index": 0 })),
      &[],
    )
    .unwrap(),
  );
  assert!(links.is_array());

  assert_eq!(app.state::<tauri_plugin_papyra::Documents>().len(), 1);
  call(&webview, "close", args(serde_json::json!({})), &[]).unwrap();
  assert!(app.state::<tauri_plugin_papyra::Documents>().is_empty());
  let gone = call(&webview, "outline", args(serde_json::json!({})), &[]).unwrap_err();
  assert!(gone.as_str().unwrap().contains("no open document"));
}

#[test]
fn passwords_travel_in_a_header_and_failures_are_tagged() {
  let Some(bytes) = corpus("pr6531_1.pdf") else {
    return;
  };
  let (_app, webview) = app();
  let missing = call(&webview, "open", InvokeBody::Raw(bytes.clone()), &[]).unwrap_err();
  assert!(
    missing
      .as_str()
      .unwrap()
      .starts_with("papyra/password-required")
  );
  let wrong = call(
    &webview,
    "open",
    InvokeBody::Raw(bytes.clone()),
    &[("x-papyra-password", "nope")],
  )
  .unwrap_err();
  assert!(
    wrong
      .as_str()
      .unwrap()
      .starts_with("papyra/incorrect-password")
  );
  let opened = call(
    &webview,
    "open",
    InvokeBody::Raw(bytes),
    &[("x-papyra-password", "asdfasdf")],
  );
  assert!(opened.is_ok());
}

#[test]
fn open_refuses_a_json_body() {
  let (_app, webview) = app();
  let refused = call(
    &webview,
    "open",
    InvokeBody::Json(serde_json::json!({})),
    &[],
  )
  .unwrap_err();
  assert!(refused.as_str().unwrap().contains("request body"));
}
