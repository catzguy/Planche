//! Android system pickers (Storage Access Framework) for Planche: a library
//! folder, a book file, a place to save an export. The commands are written
//! in Kotlin (android/) and called from the front-end; the documents they
//! return are then read by the app through the ContentResolver. The plugin
//! does nothing on other platforms.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("planche-storage")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("com.planche.storage", "StoragePlugin")?;
            Ok(())
        })
        .build()
}
