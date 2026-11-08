//! Android system pickers (Storage Access Framework) for Planche: a library
//! folder, a book file, a place to save an export. The commands are written
//! in Kotlin (android/) and called from the Rust backend through [`Storage`],
//! never from the web page: the backend records what the user picked, so the
//! page cannot name paths of its own. The documents are then read through the
//! ContentResolver. The plugin does nothing on other platforms.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// A document chosen in the system picker: its `content://` URI and display name.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Picked {
    pub path: String,
    pub name: String,
}

#[cfg(target_os = "android")]
mod android {
    use super::Picked;
    use tauri::plugin::mobile::PluginInvokeError;
    use tauri::plugin::PluginHandle;
    use tauri::Runtime;

    /// Handle on the Kotlin plugin, managed as Tauri state.
    pub struct Storage<R: Runtime>(pub(crate) PluginHandle<R>);

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SaveArgs<'a> {
        name: &'a str,
        mime_type: &'a str,
        content: &'a str,
    }

    impl<R: Runtime> Storage<R> {
        /// Runs a picker; `None` when the user backs out. Must not be called
        /// from the main thread (the picker's result is delivered there).
        fn run(&self, command: &str, args: impl serde::Serialize) -> Result<Option<Picked>, String> {
            match self.0.run_mobile_plugin::<Picked>(command, args) {
                Ok(p) => Ok(Some(p)),
                Err(PluginInvokeError::InvokeRejected(e)) if e.message.as_deref() == Some("cancelled") => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }

        pub fn pick_folder(&self) -> Result<Option<Picked>, String> {
            self.run("pickFolder", ())
        }

        pub fn pick_file(&self) -> Result<Option<Picked>, String> {
            self.run("pickFile", ())
        }

        /// Asks where to save, then writes `content` there.
        pub fn save_document(&self, name: &str, mime_type: &str, content: &str) -> Result<Option<Picked>, String> {
            self.run("saveDocument", SaveArgs { name, mime_type, content })
        }
    }
}

#[cfg(target_os = "android")]
pub use android::Storage;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("planche-storage")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("com.planche.storage", "StoragePlugin")?;
                _app.manage(Storage(handle));
            }
            Ok(())
        })
        .build()
}
