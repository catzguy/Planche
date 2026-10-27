//! Access to book files. On the desktop they are plain paths. On Android, the
//! folders and files the user picked with the system picker (Storage Access
//! Framework) are `content://` document URIs, read through the
//! ContentResolver over JNI, from any thread. Everything else (app storage,
//! the extraction cache, OPDS downloads) is a plain path on every platform.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// A directory entry, or what `stat` knows about a file.
pub struct Entry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub size: u64,
    /// Seconds since the Unix epoch, 0 when unknown.
    pub mtime: i64,
}

/// A `content://` document picked through the Storage Access Framework.
#[cfg(target_os = "android")]
fn is_document(path: &Path) -> bool {
    path.to_str().is_some_and(|s| s.starts_with("content://"))
}

pub fn open(path: &Path) -> io::Result<File> {
    #[cfg(target_os = "android")]
    if is_document(path) {
        return android::open(path, "r");
    }
    File::open(path)
}

pub fn read(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open(path)?.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// A path that native code (the UnRAR library) can open: the path itself, or
/// `/proc/self/fd/N` for a document opened as `file`, which must stay open.
pub fn native_path(path: &Path, file: &File) -> PathBuf {
    #[cfg(target_os = "android")]
    if is_document(path) {
        use std::os::fd::AsRawFd;
        return PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
    }
    let _ = file;
    path.to_path_buf()
}

pub fn list(dir: &Path) -> io::Result<Vec<Entry>> {
    #[cfg(target_os = "android")]
    if is_document(dir) {
        return android::list(dir);
    }
    Ok(std::fs::read_dir(dir)?
        .flatten()
        .map(|e| {
            // Not following links, like the scan always did.
            let meta = e.metadata().ok();
            Entry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path(),
                is_dir: e.file_type().is_ok_and(|t| t.is_dir()),
                size: meta.as_ref().filter(|m| m.is_file()).map_or(0, |m| m.len()),
                mtime: meta.and_then(|m| m.modified().ok()).map_or(0, unix_secs),
            }
        })
        .collect())
}

pub fn stat(path: &Path) -> Option<Entry> {
    #[cfg(target_os = "android")]
    if is_document(path) {
        return android::stat(path);
    }
    let meta = std::fs::metadata(path).ok()?;
    Some(Entry {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: path.to_path_buf(),
        is_dir: meta.is_dir(),
        size: if meta.is_file() { meta.len() } else { 0 },
        mtime: meta.modified().ok().map_or(0, unix_secs),
    })
}

pub fn exists(path: &Path) -> bool {
    stat(path).is_some()
}

pub fn is_dir(path: &Path) -> bool {
    stat(path).is_some_and(|e| e.is_dir)
}

fn unix_secs(t: std::time::SystemTime) -> i64 {
    t.duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

#[cfg(target_os = "android")]
mod android {
    use super::Entry;
    use jni::objects::{JObject, JObjectArray, JString, JValue};
    use jni::{JNIEnv, JavaVM};
    use std::fs::File;
    use std::io;
    use std::os::fd::FromRawFd;
    use std::path::{Path, PathBuf};

    const DIR_MIME: &str = "vnd.android.document/directory";
    /// DocumentsContract.Document columns.
    const COLUMNS: [&str; 5] = ["document_id", "_display_name", "mime_type", "_size", "last_modified"];

    fn jerr(e: jni::errors::Error) -> io::Error {
        io::Error::other(format!("Android: {e}"))
    }

    /// Runs `f` with a JNI environment attached to this thread and the app context.
    fn with_env<T>(f: impl FnOnce(&mut JNIEnv, &JObject) -> jni::errors::Result<T>) -> io::Result<T> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(jerr)?;
        let mut env = vm.attach_current_thread().map_err(jerr)?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let result = env.with_local_frame(64, |env| f(env, &context));
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
        result.map_err(jerr)
    }

    fn uri<'a>(env: &mut JNIEnv<'a>, path: &Path) -> jni::errors::Result<JObject<'a>> {
        let s = env.new_string(path.to_string_lossy())?;
        env.call_static_method("android/net/Uri", "parse", "(Ljava/lang/String;)Landroid/net/Uri;", &[(&s).into()])?
            .l()
    }

    fn resolver<'a>(env: &mut JNIEnv<'a>, context: &JObject) -> jni::errors::Result<JObject<'a>> {
        env.call_method(context, "getContentResolver", "()Landroid/content/ContentResolver;", &[])?.l()
    }

    fn string(env: &mut JNIEnv, obj: JObject) -> jni::errors::Result<String> {
        if obj.is_null() {
            return Ok(String::new());
        }
        Ok(env.get_string(&JString::from(obj))?.into())
    }

    /// Rows of `uri` with the `COLUMNS` columns, read with `row`.
    fn query<T>(
        env: &mut JNIEnv,
        context: &JObject,
        uri: &JObject,
        mut row: impl FnMut(&mut JNIEnv, &JObject) -> jni::errors::Result<T>,
    ) -> jni::errors::Result<Vec<T>> {
        let projection: JObjectArray = env.new_object_array(COLUMNS.len() as i32, "java/lang/String", JObject::null())?;
        for (i, c) in COLUMNS.iter().enumerate() {
            let s = env.new_string(c)?;
            env.set_object_array_element(&projection, i as i32, s)?;
        }
        let resolver = resolver(env, context)?;
        let null = JObject::null();
        let cursor = env
            .call_method(
                &resolver,
                "query",
                "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
                &[uri.into(), (&projection).into(), (&null).into(), (&null).into(), (&null).into()],
            )?
            .l()?;
        let mut rows = Vec::new();
        if cursor.is_null() {
            return Ok(rows);
        }
        while env.call_method(&cursor, "moveToNext", "()Z", &[])?.z()? {
            rows.push(env.with_local_frame(16, |env| row(env, &cursor))?);
        }
        env.call_method(&cursor, "close", "()V", &[])?;
        Ok(rows)
    }

    fn column_string(env: &mut JNIEnv, cursor: &JObject, i: i32) -> jni::errors::Result<String> {
        let v = env.call_method(cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(i)])?.l()?;
        string(env, v)
    }

    fn column_long(env: &mut JNIEnv, cursor: &JObject, i: i32) -> jni::errors::Result<i64> {
        env.call_method(cursor, "getLong", "(I)J", &[JValue::Int(i)])?.j()
    }

    /// (document id, name, is directory, size, mtime) of the current row.
    fn read_row(env: &mut JNIEnv, cursor: &JObject) -> jni::errors::Result<(String, String, bool, u64, i64)> {
        let id = column_string(env, cursor, 0)?;
        let name = column_string(env, cursor, 1)?;
        let mime = column_string(env, cursor, 2)?;
        let size = column_long(env, cursor, 3)?.max(0) as u64;
        let mtime = column_long(env, cursor, 4)? / 1000;
        Ok((id, name, mime == DIR_MIME, size, mtime))
    }

    pub fn open(path: &Path, mode: &str) -> io::Result<File> {
        let fd = with_env(|env, context| {
            let uri = uri(env, path)?;
            let mode = env.new_string(mode)?;
            let resolver = resolver(env, context)?;
            let pfd = env
                .call_method(
                    &resolver,
                    "openFileDescriptor",
                    "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;",
                    &[(&uri).into(), (&mode).into()],
                )?
                .l()?;
            env.call_method(&pfd, "detachFd", "()I", &[])?.i()
        })?;
        if fd < 0 {
            return Err(io::Error::new(io::ErrorKind::NotFound, "document unavailable"));
        }
        // We own the detached descriptor; File closes it.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub fn list(dir: &Path) -> io::Result<Vec<Entry>> {
        with_env(|env, context| {
            let dir_uri = uri(env, dir)?;
            let doc_id = env
                .call_static_method(
                    "android/provider/DocumentsContract",
                    "getDocumentId",
                    "(Landroid/net/Uri;)Ljava/lang/String;",
                    &[(&dir_uri).into()],
                )?
                .l()?;
            let children = env
                .call_static_method(
                    "android/provider/DocumentsContract",
                    "buildChildDocumentsUriUsingTree",
                    "(Landroid/net/Uri;Ljava/lang/String;)Landroid/net/Uri;",
                    &[(&dir_uri).into(), (&doc_id).into()],
                )?
                .l()?;
            query(env, context, &children, |env, cursor| {
                let (id, name, is_dir, size, mtime) = read_row(env, cursor)?;
                let id = env.new_string(id)?;
                let child = env
                    .call_static_method(
                        "android/provider/DocumentsContract",
                        "buildDocumentUriUsingTree",
                        "(Landroid/net/Uri;Ljava/lang/String;)Landroid/net/Uri;",
                        &[(&dir_uri).into(), (&id).into()],
                    )?
                    .l()?;
                let child = env.call_method(&child, "toString", "()Ljava/lang/String;", &[])?.l()?;
                let path = PathBuf::from(string(env, child)?);
                Ok(Entry { name, path, is_dir, size, mtime })
            })
        })
    }

    pub fn stat(path: &Path) -> Option<Entry> {
        with_env(|env, context| {
            let uri = uri(env, path)?;
            query(env, context, &uri, read_row)
        })
        .ok()?
        .into_iter()
        .next()
        .map(|(_, name, is_dir, size, mtime)| Entry { name, path: path.to_path_buf(), is_dir, size, mtime })
    }
}
