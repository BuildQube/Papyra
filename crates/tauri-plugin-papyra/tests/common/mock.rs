//! The mock runtime, for both plugins' IPC tests: shared with the office crate's by
//! `#[path]`.

use tauri_utils::acl::capability::Capability;
use tauri_utils::acl::manifest::Manifest;
use tauri_utils::acl::resolved::Resolved;

/// A mock-runtime context whose ACL is resolved from plugins' real permission files,
/// for a capability granting `permissions` to the `main` window. The mock context has
/// none, so it would refuse every plugin command; resolving the files themselves means
/// a command missing from its set fails a test, not an app.
///
/// `plugins` is each plugin's name and its crate directory.
pub fn context(
  plugins: &[(&str, &str)],
  permissions: &[&str],
) -> tauri::Context<tauri::test::MockRuntime> {
  let acl = plugins
    .iter()
    .map(|(name, dir)| {
      let files = glob::glob(&format!("{dir}/permissions/**/*.toml"))
        .unwrap()
        .map(|path| toml::from_str(&std::fs::read_to_string(path.unwrap()).unwrap()).unwrap())
        .collect();
      (name.to_string(), Manifest::new(files, None))
    })
    .collect();
  let capability: Capability = serde_json::from_value(serde_json::json!({
    "identifier": "test",
    "windows": ["main"],
    "permissions": permissions,
  }))
  .unwrap();
  let resolved = Resolved::resolve(
    &acl,
    [("test".to_string(), capability)].into_iter().collect(),
    tauri_utils::platform::Target::current(),
  )
  .expect("the permission sets resolve");
  let mut context = tauri::test::mock_context(tauri::test::noop_assets());
  *context.runtime_authority_mut() = tauri::ipc::RuntimeAuthority::new(acl, resolved);
  context
}

/// Call `cmd` — the full `plugin:<name>|<command>` — through Tauri's real dispatch.
pub fn call(
  webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
  cmd: &str,
  body: tauri::ipc::InvokeBody,
  headers: &[(&'static str, &str)],
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
  let mut map = tauri::http::HeaderMap::new();
  for (key, value) in headers {
    map.insert(*key, value.parse().unwrap());
  }
  tauri::test::get_ipc_response(
    webview,
    tauri::webview::InvokeRequest {
      cmd: cmd.to_string(),
      callback: tauri::ipc::CallbackFn(0),
      error: tauri::ipc::CallbackFn(1),
      url: "tauri://localhost".parse().unwrap(),
      body,
      headers: map,
      invoke_key: tauri::test::INVOKE_KEY.to_string(),
    },
  )
}
