//! The plugin's commands through Tauri's real IPC dispatch, on the mock runtime:
//! registration, the capability check, argument names, raw bodies and headers.

use tauri::Manager;
use tauri::ipc::{InvokeBody, InvokeResponseBody};
use tauri::test::mock_builder;

fn corpus(name: &str) -> Option<Vec<u8>> {
  std::fs::read(format!(
    "{}/../../corpus/{name}",
    env!("CARGO_MANIFEST_DIR")
  ))
  .ok()
}

/// A fixture checked in beside another crate's tests: always present.
#[cfg(any(feature = "tiff", feature = "tables"))]
fn fixture(path: &str) -> Vec<u8> {
  std::fs::read(format!("{}/../{path}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

mod common {
  pub mod mock;
}

/// What the guide tells an app to grant, every format included.
fn context() -> tauri::Context<tauri::test::MockRuntime> {
  common::mock::context(
    &[("papyra", env!("CARGO_MANIFEST_DIR"))],
    &[
      "papyra:default",
      "papyra:allow-open-count",
      "papyra:tiff",
      "papyra:tables",
    ],
  )
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
  common::mock::call(webview, &format!("plugin:papyra|{cmd}"), body, headers)
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
  assert!(!text["lines"].as_array().unwrap().is_empty());
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

  let count = |webview| json(call(webview, "open_count", InvokeBody::default(), &[]).unwrap());
  assert_eq!(count(&webview), 1);
  call(&webview, "close", args(serde_json::json!({})), &[]).unwrap();
  assert_eq!(count(&webview), 0);
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

#[cfg(feature = "tiff")]
#[test]
fn opens_a_tiff_and_serves_its_pages_through_the_shared_table() {
  let (app, webview) = app();
  let opened = json(
    call(
      &webview,
      "open_tiff",
      InvokeBody::Raw(fixture("papyra-tiff/tests/fixtures/g4.tif")),
      &[],
    )
    .unwrap(),
  );
  let id = opened["id"].as_u64().unwrap();
  let page = &opened["pages"][0];
  assert_eq!(page["compression"], "ccitt-g4");
  assert!(page["width"].as_u64().unwrap() > 0);
  assert!(page.get("bitsPerSample").is_some());

  // A TIFF is not a PDF: the PDF commands refuse its id by kind.
  let refused = call(
    &webview,
    "outline",
    InvokeBody::Json(serde_json::json!({ "id": id })),
    &[],
  )
  .unwrap_err();
  assert!(
    refused
      .as_str()
      .unwrap()
      .contains("is not a paged document")
  );

  call(
    &webview,
    "close",
    InvokeBody::Json(serde_json::json!({ "id": id })),
    &[],
  )
  .unwrap();
  assert!(app.state::<tauri_plugin_papyra::Documents>().is_empty());
}

#[cfg(feature = "tables")]
#[test]
fn opens_a_workbook_and_reads_a_packed_window() {
  let (_app, webview) = app();
  let opened = json(
    call(
      &webview,
      "open_workbook",
      InvokeBody::Raw(fixture("papyra-tables/tests/fixtures/styled.xlsx")),
      &[],
    )
    .unwrap(),
  );
  assert_eq!(opened["format"], "xlsx");
  assert_eq!(opened["sheets"][0]["kind"], "worksheet");
  assert_eq!(opened["sheets"][0]["visibility"], "visible");
  let id = opened["id"].as_u64().unwrap();

  let sheet = json(
    call(
      &webview,
      "sheet",
      InvokeBody::Json(serde_json::json!({ "id": id, "index": 0 })),
      &[],
    )
    .unwrap(),
  );
  let (rows, cols) = (
    sheet["rows"].as_u64().unwrap(),
    sheet["cols"].as_u64().unwrap(),
  );
  assert!(rows > 0 && cols > 0);
  assert!(sheet["styles"].as_array().unwrap().len() > 1);
  assert!(sheet["layout"]["cols"].is_array());

  let InvokeResponseBody::Raw(packed) = call(
    &webview,
    "window",
    InvokeBody::Json(serde_json::json!({
      "id": id, "sheet": 0, "rowStart": 0, "rowEnd": 1000, "colStart": 0, "colEnd": 1000,
    })),
    &[],
  )
  .unwrap() else {
    panic!("a window is a binary response");
  };
  let u32_at = |i: usize| u32::from_le_bytes(packed[i * 4..i * 4 + 4].try_into().unwrap());
  // Clamped to the sheet, and every array where the layout says.
  assert_eq!((u32_at(0), u32_at(1)), (0, 0));
  assert_eq!((u64::from(u32_at(2)), u64::from(u32_at(3))), (rows, cols));
  let n = (rows * cols) as usize;
  let offsets_at = (16 + n).next_multiple_of(8) + n * 8 + n * 4;
  let text_at = offsets_at + (n + 1) * 4 + n * 2;
  // The last offset is the text's length, which for this ASCII sheet is its bytes.
  let last = u32::from_le_bytes(packed[offsets_at + n * 4..][..4].try_into().unwrap());
  let text = std::str::from_utf8(&packed[text_at..]).unwrap();
  assert!(!text.is_empty());
  assert_eq!(text.len(), last as usize);
}

#[cfg(feature = "tables")]
#[test]
fn workbook_options_travel_in_a_header_and_encryption_is_tagged() {
  let (_app, webview) = app();
  let tsv = call(
    &webview,
    "open_workbook",
    InvokeBody::Raw(b"a\tb\n1\t2\n".to_vec()),
    &[("x-papyra-options", "%7B%22format%22%3A%22tsv%22%7D")],
  )
  .unwrap();
  assert_eq!(json(tsv)["format"], "tsv");

  let bad = call(
    &webview,
    "open_workbook",
    InvokeBody::Raw(b"a,b".to_vec()),
    &[("x-papyra-options", "%7B%22delimiter%22%3A%22%3B%3B%22%7D")],
  )
  .unwrap_err();
  assert!(bad.as_str().unwrap().contains("single ASCII character"));

  let encrypted = call(
    &webview,
    "open_workbook",
    InvokeBody::Raw(fixture("papyra-tables/tests/fixtures/encrypted.xlsx")),
    &[],
  )
  .unwrap_err();
  assert!(
    encrypted
      .as_str()
      .unwrap()
      .starts_with("papyra/encrypted-workbook")
  );
}

#[cfg(feature = "tables")]
#[test]
fn a_sparse_sheet_ships_what_it_stores_not_its_bounding_box() {
  let (_app, webview) = app();
  // Ten kilobytes, values in A1 and XFD1048576: two cells stored, seventeen billion
  // dense. Opened at the default cap, and at one an app set far too high.
  for options in ["%7B%7D", "%7B%22maxCells%22%3A10000000000%7D"] {
    let opened = json(
      call(
        &webview,
        "open_workbook",
        InvokeBody::Raw(fixture("papyra-tables/tests/fixtures/extent.xlsx")),
        &[("x-papyra-options", options)],
      )
      .unwrap(),
    );
    let id = &opened["id"];
    let sheet = json(
      call(
        &webview,
        "sheet",
        InvokeBody::Json(serde_json::json!({ "id": id, "index": 0 })),
        &[],
      )
      .unwrap(),
    );
    let (rows, cols) = (
      sheet["rows"].as_u64().unwrap(),
      sheet["cols"].as_u64().unwrap(),
    );
    assert_eq!(cols, 16384);
    assert!(rows > 0, "{options}");
    assert_eq!(sheet["truncated"], true, "{options}");

    let window = |rows: u64| {
      call(
        &webview,
        "window",
        InvokeBody::Json(serde_json::json!({
          "id": id, "sheet": 0, "rowStart": 0, "rowEnd": rows, "colStart": 0, "colEnd": cols,
        })),
        &[],
      )
    };
    // What the WebView fetches: the rows `sheet` reported, a megabyte or two.
    let InvokeResponseBody::Raw(packed) = window(rows).unwrap() else {
      panic!("a window is a binary response");
    };
    assert!(packed.len() < 2 << 20, "{options}: {} bytes", packed.len());
    // And anything wider is refused, whoever asks.
    let refused = window(1_048_576).unwrap_err();
    assert!(refused.as_str().unwrap().contains("cell cap"), "{options}");
  }
}
