const COMMANDS: &[&str] = &["open", "add_font"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS).build();
}
