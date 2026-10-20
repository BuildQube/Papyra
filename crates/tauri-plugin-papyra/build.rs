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
];

fn main() {
  tauri_plugin::Builder::new(COMMANDS).build();
}
