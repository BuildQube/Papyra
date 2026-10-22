const COMMANDS: &[&str] = &[
  "open",
  "close",
  "open_count",
  "page_text",
  "outline",
  "links",
  "page_labels",
  "attachments",
  "attachment_data",
  "struct_tree",
  // Generated whatever the features, so the permission files do not change with
  // them; each format's set grants these only to an app that enabled it.
  "open_tiff",
  "open_workbook",
  "sheet",
  "window",
];

fn main() {
  tauri_plugin::Builder::new(COMMANDS).build();
}
