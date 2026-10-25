//! Background worker filling in page counts and cover thumbnails for books
//! discovered by a scan. PDFs are handled by the front-end (pdf.js).

use crate::scan::is_image;
use crate::{book, db, meta, AppState};
use anyhow::{anyhow, bail, Result};
use image::ImageFormat;
use std::io::Cursor;
use std::path::Path;
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub const THUMB_W: u32 = 300;
pub const THUMB_H: u32 = 450;

/// First page bytes and page count, reading as little as possible.
fn cover_and_count(state: &AppState, path: &Path, kind: &str, id: &str) -> Result<(Vec<u8>, i64)> {
    let sorted = |mut names: Vec<String>| {
        names.retain(|n| is_image(n) && !n.split(['/', '\\']).any(|c| c.starts_with('.') || c == "__MACOSX"));
        names.sort_by(|a, b| natord::compare_ignore_case(a, b));
        names
    };
    match book::sniff(path, kind).as_str() {
        "rar" => {
            let names = sorted(
                unrar::Archive::new(path)
                    .open_for_listing()
                    .map_err(|e| anyhow!("rar: {e}"))?
                    .filter_map(|e| e.ok())
                    .filter(|e| e.is_file())
                    .map(|e| e.filename.to_string_lossy().into_owned())
                    .collect(),
            );
            let first = names.first().ok_or_else(|| anyhow!("no images"))?.clone();
            let mut archive = unrar::Archive::new(path).open_for_processing().map_err(|e| anyhow!("rar: {e}"))?;
            while let Some(header) = archive.read_header().map_err(|e| anyhow!("rar: {e}"))? {
                if header.entry().filename.to_string_lossy() == first {
                    if header.entry().unpacked_size > book::MAX_ENTRY_BYTES {
                        bail!("page too large");
                    }
                    let (bytes, _) = header.read().map_err(|e| anyhow!("rar: {e}"))?;
                    return Ok((bytes, names.len() as i64));
                }
                archive = header.skip().map_err(|e| anyhow!("rar: {e}"))?;
            }
            bail!("rar: first page not found")
        }
        "7z" => {
            let mut reader = sevenz_rust2::ArchiveReader::open(path, sevenz_rust2::Password::empty())
                .map_err(|e| anyhow!("7z: {e}"))?;
            let names = sorted(
                reader.archive().files.iter().filter(|f| !f.is_directory()).map(|f| f.name().to_owned()).collect(),
            );
            let first = names.first().ok_or_else(|| anyhow!("no images"))?.clone();
            let size = reader.archive().files.iter().find(|f| f.name() == first).map_or(0, |f| f.size());
            if size > book::MAX_ENTRY_BYTES {
                bail!("page too large");
            }
            let bytes = reader.read_file(&first).map_err(|e| anyhow!("7z: {e}"))?;
            Ok((bytes, names.len() as i64))
        }
        real => match book::open(path, kind, &state.cache_dir, id) {
            Ok(b) => Ok((b.page_bytes(0)?, b.pages.len() as i64)),
            // Text EPUB: its declared cover; pages are counted by the reader.
            Err(e) if real == "epub" && e.to_string().contains(book::TEXT_EPUB) => Ok((meta::epub_cover(path)?, 0)),
            Err(e) => Err(e),
        },
    }
}

pub fn write_thumbnail(bytes: &[u8], dest: &Path) -> Result<()> {
    let img = image::load_from_memory(bytes)?;
    let thumb = img.thumbnail(THUMB_W, THUMB_H).to_rgb8();
    let mut out = Cursor::new(Vec::new());
    thumb.write_to(&mut out, ImageFormat::Jpeg)?;
    std::fs::write(dest, out.into_inner())?;
    Ok(())
}

pub fn run(app: AppHandle, state: Arc<AppState>, wake: Receiver<()>) {
    while wake.recv().is_ok() {
        while wake.try_recv().is_ok() {}
        let mut done = 0usize;
        loop {
            let next: Option<(String, String, String, bool, bool)> = {
                let conn = state.db.lock().unwrap();
                conn.query_row(
                    "SELECT id, path, kind, thumb = 0 AND kind != 'pdf', meta = 0 FROM books
                     WHERE (thumb = 0 AND kind != 'pdf') OR meta = 0 LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .ok()
            };
            let Some((id, path, kind, need_thumb, need_meta)) = next else { break };
            let thumb = need_thumb.then(|| {
                cover_and_count(&state, Path::new(&path), &kind, &id).and_then(|(bytes, count)| {
                    write_thumbnail(&bytes, &state.thumb_dir.join(format!("{id}.jpg")))?;
                    Ok(count)
                })
            });
            let metadata = need_meta.then(|| meta::read(Path::new(&path), &kind));
            let conn = state.db.lock().unwrap();
            match thumb {
                Some(Ok(count)) => {
                    let _ = db::set_page_count(&conn, &id, count);
                    let _ = db::set_thumb(&conn, &id, 1);
                }
                Some(Err(e)) => {
                    eprintln!("thumbnail failed for {path}: {e:#}");
                    let _ = db::set_thumb(&conn, &id, 2);
                }
                None => {}
            }
            match metadata {
                Some(Ok(m)) => {
                    let _ = db::set_meta(&conn, &id, &m);
                }
                Some(Err(e)) => {
                    // Unreadable metadata is not fatal: record "none" so it is not retried.
                    eprintln!("metadata failed for {path}: {e:#}");
                    let _ = db::set_meta(&conn, &id, &meta::Meta::default());
                }
                None => {}
            }
            done += 1;
            if done % 8 == 0 {
                let _ = app.emit("library-changed", ());
            }
        }
        if done > 0 {
            let _ = app.emit("library-changed", ());
        }
    }
}
