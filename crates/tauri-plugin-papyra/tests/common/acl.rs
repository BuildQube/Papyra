//! A mock-runtime context whose ACL is resolved from plugins' real permission files,
//! for a capability granting `permissions` to the `main` window. The mock context has
//! none, so it would refuse every plugin command; resolving the files themselves means
//! a command missing from its set fails a test, not an app.
//!
//! Shared with the office crate's tests by `#[path]`.

use tauri_utils::acl::capability::Capability;
use tauri_utils::acl::manifest::Manifest;
use tauri_utils::acl::resolved::Resolved;

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
