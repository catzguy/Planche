const COMMANDS: &[&str] = &["pick_folder", "pick_file", "save_document"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
