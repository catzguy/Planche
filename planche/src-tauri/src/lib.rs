mod book;
mod db;
mod meta;
mod opds;
mod scan;
mod thumbs;
mod vault;

use anyhow::Context;
use book::OpenBook;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use tauri::http::{Response, StatusCode};
use tauri::{Emitter, Manager, State};

/// Books kept open (zip handles / extracted dirs) for page requests.
const OPEN_BOOKS: usize = 3;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub cache_dir: PathBuf,
    pub thumb_dir: PathBuf,
    open: Mutex<Vec<(String, Arc<OpenBook>)>>,
    wake_thumbs: Mutex<Sender<()>>,
    initial_file: Mutex<Option<String>>,
    /// Where OPDS downloads go (Documents/Planche/OPDS); part of the library.
    download_dir: PathBuf,
    vault: vault::Vault,
}

impl AppState {
    /// Writes the encrypted database snapshot now.
    fn persist(&self) {
        if let Err(e) = self.vault.save(&mut self.db.lock().unwrap()) {
            eprintln!("saving the database failed: {e:#}");
        }
    }
}

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

impl AppState {
    fn wake_thumbnails(&self) {
        let _ = self.wake_thumbs.lock().unwrap().send(());
    }

    fn opened(&self, id: &str) -> Res<Arc<OpenBook>> {
        if let Some(b) = self.open.lock().unwrap().iter().find(|(k, _)| k == id) {
            return Ok(b.1.clone());
        }
        let b = {
            let conn = self.db.lock().unwrap();
            db::book(&conn, id).map_err(err)?.ok_or("book not found")?
        };
        let opened = Arc::new(book::open(Path::new(&b.path), &b.kind, &self.cache_dir, id).map_err(err)?);
        let mut open = self.open.lock().unwrap();
        open.retain(|(k, _)| k != id);
        open.insert(0, (id.to_owned(), opened.clone()));
        open.truncate(OPEN_BOOKS);
        Ok(opened)
    }

    fn scan(&self, roots: &[(String, String)]) -> Res<()> {
        let mut conn = self.db.lock().unwrap();
        scan::scan_roots(&mut conn, roots).map_err(err)?;
        db::purge_orphans(&conn).map_err(err)
    }
}

/// A book file passed on the command line (file association, "Open with").
fn book_file_arg<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Option<String> {
    args.into_iter().skip(1).find_map(|a| {
        let p = cwd.join(&a);
        (p.is_file() && scan::book_kind(&p).is_some()).then(|| p.to_string_lossy().into_owned())
    })
}

#[tauri::command]
fn get_library(state: State<Arc<AppState>>) -> Res<db::Library> {
    db::library(&state.db.lock().unwrap()).map_err(err)
}

#[tauri::command(async)]
fn add_root(state: State<'_, Arc<AppState>>, path: String) -> Res<()> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err("Dossier introuvable ou inaccessible".into());
    }
    let id = {
        let conn = state.db.lock().unwrap();
        let lib = db::library(&conn).map_err(err)?;
        let canon = |s: &str| PathBuf::from(s).canonicalize().unwrap_or_else(|_| PathBuf::from(s));
        let new = canon(&path);
        for r in &lib.roots {
            let existing = canon(&r.path);
            if new.starts_with(&existing) {
                return Err("Ce dossier est déjà dans la bibliothèque".into());
            }
            if existing.starts_with(&new) {
                return Err(format!("Ce dossier contient « {} », déjà présent dans la bibliothèque", r.path));
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute("INSERT INTO roots(id, path, added_at) VALUES(?1, ?2, ?3)", params![id, path, db::now()])
            .map_err(err)?;
        id
    };
    state.scan(&[(id, path)])?;
    state.wake_thumbnails();
    Ok(())
}

#[tauri::command]
fn remove_root(state: State<Arc<AppState>>, id: String) -> Res<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM books WHERE root_id = ?1", [&id]).map_err(err)?;
    conn.execute("DELETE FROM shelves WHERE root_id = ?1", [&id]).map_err(err)?;
    conn.execute("DELETE FROM roots WHERE id = ?1", [&id]).map_err(err)?;
    db::purge_orphans(&conn).map_err(err)
}

#[tauri::command(async)]
fn rescan(state: State<'_, Arc<AppState>>) -> Res<()> {
    let roots: Vec<(String, String)> =
        db::library(&state.db.lock().unwrap()).map_err(err)?.roots.into_iter().map(|r| (r.id, r.path)).collect();
    state.scan(&roots)?;
    state.wake_thumbnails();
    Ok(())
}

#[derive(Serialize)]
struct Opened {
    book: db::Book,
    /// 0 for PDFs and text EPUBs: the front-end counts pages itself.
    page_count: usize,
    /// Text EPUB, rendered by the front-end's reflowable reader.
    reflowable: bool,
}

#[tauri::command(async)]
fn open_book(state: State<'_, Arc<AppState>>, id: String) -> Res<Opened> {
    let book = db::book(&state.db.lock().unwrap(), &id).map_err(err)?.ok_or("Livre introuvable")?;
    if book.kind == "pdf" {
        return Ok(Opened { book, page_count: 0, reflowable: false });
    }
    match state.opened(&id) {
        Ok(opened) => {
            let page_count = opened.pages.len();
            db::set_page_count(&state.db.lock().unwrap(), &id, page_count as i64).map_err(err)?;
            Ok(Opened { book, page_count, reflowable: false })
        }
        Err(e) if book.kind == "epub" && e.contains(book::TEXT_EPUB) => {
            Ok(Opened { book, page_count: 0, reflowable: true })
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn opds_list(state: State<Arc<AppState>>) -> Res<Vec<opds::Catalog>> {
    opds::list(&state.db.lock().unwrap()).map_err(err)
}

#[tauri::command]
fn opds_save(
    state: State<Arc<AppState>>,
    id: String,
    name: String,
    url: String,
    username: Option<String>,
    password: Option<String>,
) -> Res<String> {
    let conn = state.db.lock().unwrap();
    opds::save(&conn, &id, &name, &url, username.as_deref(), password.as_deref()).map_err(err)
}

#[tauri::command]
fn opds_remove(state: State<Arc<AppState>>, id: String) -> Res<()> {
    opds::remove(&state.db.lock().unwrap(), &id).map_err(err)
}

#[tauri::command]
async fn opds_fetch(state: State<'_, Arc<AppState>>, catalog_id: String, url: String) -> Res<opds::Fetched> {
    let catalog = opds::get(&state.db.lock().unwrap(), &catalog_id).map_err(err)?;
    opds::fetch(&catalog, &url).await.map_err(err)
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    url: String,
    received: u64,
    total: Option<u64>,
}

/// Downloads a publication into the OPDS folder, makes sure that folder is in
/// the library, and returns the new book id.
#[tauri::command]
async fn opds_download(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    catalog_id: String,
    url: String,
    title: String,
) -> Res<String> {
    let catalog = opds::get(&state.db.lock().unwrap(), &catalog_id).map_err(err)?;
    let dir = state.download_dir.clone();
    let path = opds::download(&catalog, &url, &title, &dir, |received, total| {
        let _ = app.emit("opds-progress", DownloadProgress { url: url.clone(), received, total });
    })
    .await
    .map_err(err)?;
    // Scan the root that holds the download, adding the OPDS folder if needed.
    let roots: Vec<(String, String)> =
        db::library(&state.db.lock().unwrap()).map_err(err)?.roots.into_iter().map(|r| (r.id, r.path)).collect();
    let holder = roots.iter().find(|(_, p)| dir.starts_with(p)).cloned();
    let root = match holder {
        Some(r) => r,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            let p = dir.to_string_lossy().into_owned();
            state
                .db
                .lock()
                .unwrap()
                .execute("INSERT INTO roots(id, path, added_at) VALUES(?1, ?2, ?3)", params![id, p, db::now()])
                .map_err(err)?;
            (id, p)
        }
    };
    state.scan(&[root])?;
    state.wake_thumbnails();
    let _ = app.emit("library-changed", ());
    let p = path.to_string_lossy().into_owned();
    let kind = scan::book_kind(&path).unwrap_or("zip");
    db::open_path(&state.db.lock().unwrap(), &p, kind, &scan::display_name(&path)).map_err(err)
}

/// `planche://localhost/opds-img/{catalog}?u={url}`: covers behind the catalog's login.
fn opds_image(state: &AppState, catalog_id: &str, query: &str) -> Result<(Vec<u8>, String), (StatusCode, String)> {
    let bad = |e: String| (StatusCode::BAD_GATEWAY, e);
    let url = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("u="))
        .map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned())
        .ok_or_else(|| bad("missing url".into()))?;
    let catalog = opds::get(&state.db.lock().unwrap(), catalog_id).map_err(|e| bad(err(e)))?;
    tauri::async_runtime::block_on(opds::image(&catalog, &url)).map_err(|e| bad(err(e)))
}

/// Book record without opening it (library or standalone).
#[tauri::command]
fn get_book(state: State<Arc<AppState>>, id: String) -> Res<Option<db::Book>> {
    db::book(&state.db.lock().unwrap(), &id).map_err(err)
}

#[tauri::command]
fn set_progress(state: State<Arc<AppState>>, id: String, page: i64, position: Option<String>) -> Res<()> {
    db::set_progress(&state.db.lock().unwrap(), &id, page, position.as_deref()).map_err(err)
}

#[tauri::command]
fn list_annotations(state: State<Arc<AppState>>, book_id: Option<String>) -> Res<Vec<db::Annotation>> {
    db::annotations(&state.db.lock().unwrap(), book_id.as_deref()).map_err(err)
}

#[tauri::command]
fn save_annotation(state: State<Arc<AppState>>, annotation: db::Annotation) -> Res<String> {
    db::save_annotation(&state.db.lock().unwrap(), &annotation).map_err(err)
}

#[tauri::command]
fn delete_annotation(state: State<Arc<AppState>>, id: String) -> Res<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM annotations WHERE id = ?1", [id]).map_err(err)?;
    Ok(())
}

/// Exports annotations: the save dialog is opened here, so the web page never
/// chooses where to write. The file gets Markdown or W3C JSON depending on the
/// extension picked by the user. Returns the path, or None if cancelled.
#[tauri::command(async)]
fn export_annotations(
    app: tauri::AppHandle,
    title: String,
    default_name: String,
    markdown: String,
    json: String,
) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app
        .dialog()
        .file()
        .set_title(title)
        .set_file_name(&default_name)
        .add_filter("Markdown", &["md"])
        .add_filter("W3C Web Annotation (JSON)", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(err)?;
    let is_json = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("json"));
    std::fs::write(&path, if is_json { json } else { markdown }).map_err(err)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn set_page_count(state: State<Arc<AppState>>, id: String, count: i64) -> Res<()> {
    db::set_page_count(&state.db.lock().unwrap(), &id, count).map_err(err)
}

#[tauri::command]
fn set_favorite(state: State<Arc<AppState>>, id: String, value: bool) -> Res<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("UPDATE books SET favorite = ?2 WHERE id = ?1", params![id, value]).map_err(err)?;
    Ok(())
}

#[tauri::command]
fn set_finished(state: State<Arc<AppState>>, ids: Vec<String>, value: bool) -> Res<()> {
    let conn = state.db.lock().unwrap();
    for id in ids {
        conn.execute(
            "UPDATE books SET finished = ?2, current_page = CASE WHEN ?2 THEN current_page ELSE 0 END WHERE id = ?1",
            params![id, value],
        )
        .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn set_manga(state: State<Arc<AppState>>, ids: Vec<String>, value: Option<bool>) -> Res<()> {
    let conn = state.db.lock().unwrap();
    for id in ids {
        db::set_manga(&conn, &id, value).map_err(err)?;
    }
    Ok(())
}

/// Opens a file from outside the library (dialog, drag & drop, file
/// association) and returns the book id to read.
#[tauri::command]
fn open_file(state: State<Arc<AppState>>, path: String) -> Res<String> {
    let p = PathBuf::from(&path);
    let kind = if p.is_dir() { Some("folder") } else { scan::book_kind(&p) };
    let kind = kind.filter(|_| p.exists()).ok_or("Format non pris en charge ou fichier introuvable")?;
    db::open_path(&state.db.lock().unwrap(), &path, kind, &scan::display_name(&p)).map_err(err)
}

/// Shows the system "Open with" chooser for a file Planche cannot read (text
/// EPUBs), since Planche may itself be the default handler.
#[tauri::command]
fn open_with_other_app(path: String) -> Res<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // OpenAs_RunDLL takes the rest of the command line verbatim: no quoting.
        std::process::Command::new("rundll32.exe")
            .raw_arg(format!("shell32.dll,OpenAs_RunDLL {path}"))
            .spawn()
            .map_err(err)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("unsupported".into())
    }
}

/// File the app was launched with, handed out once.
#[tauri::command]
fn take_initial_file(state: State<Arc<AppState>>) -> Option<String> {
    state.initial_file.lock().unwrap().take()
}

#[tauri::command]
fn list_bookmarks(state: State<Arc<AppState>>, book_id: Option<String>) -> Res<Vec<db::Bookmark>> {
    db::bookmarks(&state.db.lock().unwrap(), book_id.as_deref()).map_err(err)
}

#[tauri::command]
fn add_bookmark(
    state: State<Arc<AppState>>,
    book_id: String,
    page: i64,
    name: String,
    position: Option<String>,
) -> Res<()> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO bookmarks(id, book_id, name, page, position, created_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![uuid::Uuid::new_v4().to_string(), book_id, name, page, position, db::now()],
    )
    .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn rename_bookmark(state: State<Arc<AppState>>, id: String, name: String) -> Res<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("UPDATE bookmarks SET name = ?2 WHERE id = ?1", params![id, name]).map_err(err)?;
    Ok(())
}

#[tauri::command]
fn delete_bookmark(state: State<Arc<AppState>>, id: String) -> Res<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM bookmarks WHERE id = ?1", [id]).map_err(err)?;
    Ok(())
}

/// Thumbnail rendered by the front-end (PDF books).
#[tauri::command]
fn save_thumbnail(state: State<Arc<AppState>>, id: String, data: Vec<u8>) -> Res<()> {
    let result = thumbs::write_thumbnail(&data, &state.thumb_dir.join(format!("{id}.jpg")));
    db::set_thumb(&state.db.lock().unwrap(), &id, if result.is_ok() { 1 } else { 2 }).map_err(err)?;
    result.map_err(err)
}

#[tauri::command]
fn get_settings(state: State<Arc<AppState>>) -> Res<Option<String>> {
    db::kv_get(&state.db.lock().unwrap(), "settings").map_err(err)
}

#[tauri::command]
fn set_settings(state: State<Arc<AppState>>, json: String) -> Res<()> {
    db::kv_set(&state.db.lock().unwrap(), "settings", &json).map_err(err)
}

/// `planche://localhost/page/{id}/{n}`, `/thumb/{id}`, `/raw/{id}`.
fn serve(state: &AppState, path: &str) -> Result<(Vec<u8>, String), (StatusCode, String)> {
    let not_found = |e: String| (StatusCode::NOT_FOUND, e);
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    match parts.as_slice() {
        ["page", id, n] => {
            let n: usize = n.parse().map_err(|_| not_found("bad page".into()))?;
            let b = state.opened(id).map_err(not_found)?;
            let bytes = b.page_bytes(n).map_err(|e| not_found(err(e)))?;
            Ok((bytes, book::mime_for(&b.pages[n]).into()))
        }
        ["thumb", id] => {
            let bytes = std::fs::read(state.thumb_dir.join(format!("{id}.jpg"))).map_err(|e| not_found(err(e)))?;
            Ok((bytes, "image/jpeg".into()))
        }
        ["raw", id] => {
            let b = db::book(&state.db.lock().unwrap(), id)
                .map_err(|e| not_found(err(e)))?
                .ok_or_else(|| not_found("book not found".into()))?;
            let bytes = std::fs::read(&b.path).map_err(|e| not_found(err(e)))?;
            let mime = if b.kind == "epub" { "application/epub+zip" } else { "application/pdf" };
            Ok((bytes, mime.into()))
        }
        _ => Err(not_found("unknown route".into())),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // A second launch (double-click on another file) hands its file to the running window.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        if let Some(path) = book_file_arg(args, Path::new(&cwd)) {
            let _ = app.emit("open-file", path);
        }
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("planche", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            let query = request.uri().query().unwrap_or("").to_owned();
            std::thread::spawn(move || {
                let state = app.state::<Arc<AppState>>();
                let result = match path.strip_prefix("/opds-img/") {
                    Some(catalog_id) => opds_image(&state, catalog_id, &query),
                    None => serve(&state, &path),
                };
                let resp = match result {
                    Ok((bytes, mime)) => Response::builder()
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Cache-Control", "no-cache")
                        .body(bytes),
                    Err((status, msg)) => Response::builder()
                        .status(status)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(msg.into_bytes()),
                };
                responder.respond(resp.unwrap());
            });
        })
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let cache_dir = data.join("cache");
            let thumb_dir = data.join("thumbnails");
            std::fs::create_dir_all(&cache_dir)?;
            std::fs::create_dir_all(&thumb_dir)?;
            std::fs::create_dir_all(&data)?;
            let (mut conn, vault) = vault::Vault::open(&data, &app.path().app_config_dir()?)?;
            db::init(&conn).context("database schema")?;
            opds::migrate(&conn).context("catalog schema")?;
            vault.save(&mut conn).context("saving the library")?;
            let download_dir = app
                .path()
                .document_dir()
                .unwrap_or_else(|_| data.clone())
                .join("Planche")
                .join("OPDS");
            let (tx, rx) = channel();
            let state = Arc::new(AppState {
                db: Mutex::new(conn),
                cache_dir,
                thumb_dir,
                open: Mutex::new(Vec::new()),
                wake_thumbs: Mutex::new(tx),
                download_dir,
                vault,
                initial_file: Mutex::new(book_file_arg(
                    std::env::args(),
                    &std::env::current_dir().unwrap_or_default(),
                )),
            });
            app.manage(state.clone());
            // Persist the encrypted snapshot shortly after changes (and on exit).
            let saver = state.clone();
            std::thread::spawn(move || {
                let mut saved = saver.db.lock().unwrap().total_changes();
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let now = saver.db.lock().unwrap().total_changes();
                    if now != saved {
                        saver.persist();
                        saved = now;
                    }
                }
            });
            let handle = app.handle().clone();
            let worker_state = state.clone();
            std::thread::spawn(move || thumbs::run(handle, worker_state, rx));
            state.wake_thumbnails();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_library,
            add_root,
            remove_root,
            rescan,
            open_book,
            set_progress,
            set_page_count,
            set_favorite,
            set_finished,
            set_manga,
            save_thumbnail,
            get_settings,
            set_settings,
            open_file,
            take_initial_file,
            open_with_other_app,
            get_book,
            list_annotations,
            save_annotation,
            delete_annotation,
            export_annotations,
            opds_list,
            opds_save,
            opds_remove,
            opds_fetch,
            opds_download,
            list_bookmarks,
            add_bookmark,
            rename_bookmark,
            delete_bookmark
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            if let tauri::RunEvent::Exit = _event {
                _app.state::<Arc<AppState>>().persist();
            }
            // macOS delivers "Open with" files as an event rather than argv.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                for path in urls.iter().filter_map(|u| u.to_file_path().ok()) {
                    let path = path.to_string_lossy().into_owned();
                    *_app.state::<Arc<AppState>>().initial_file.lock().unwrap() = Some(path.clone());
                    let _ = _app.emit("open-file", path);
                }
            }
        });
}
