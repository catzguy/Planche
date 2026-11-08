//! Background worker filling in page counts and cover thumbnails for books
//! discovered by a scan. PDFs are handled by the front-end (pdf.js).

use crate::scan::is_image;
use crate::{book, db, meta, storage, AppState};
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
            let file = storage::open(path)?;
            let path = &storage::native_path(path, &file);
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
            let mut reader = sevenz_rust2::ArchiveReader::new(storage::open(path)?, sevenz_rust2::Password::empty())
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

/// Decoding limits for cover images: a tiny PNG can declare 100 000 × 100 000
/// pixels, and the default limits would let it allocate 512 MiB.
const MAX_IMAGE_SIDE: u32 = 10_000;
const MAX_IMAGE_ALLOC: u64 = 192 * 1024 * 1024;

/// Decodes an image within [`MAX_IMAGE_SIDE`] and [`MAX_IMAGE_ALLOC`]: the
/// dimensions are checked before any pixel buffer is allocated.
pub fn decode_image(bytes: &[u8]) -> Result<image::DynamicImage> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    limits.max_alloc = Some(MAX_IMAGE_ALLOC);
    reader.limits(limits);
    Ok(reader.decode()?)
}

pub fn write_thumbnail(bytes: &[u8], dest: &Path) -> Result<()> {
    let img = decode_image(bytes)?;
    let thumb = img.thumbnail(THUMB_W, THUMB_H).to_rgb8();
    let mut out = Cursor::new(Vec::new());
    thumb.write_to(&mut out, ImageFormat::Jpeg)?;
    std::fs::write(dest, out.into_inner())?;
    Ok(())
}

pub fn run(app: AppHandle, state: Arc<AppState>, wake: Receiver<()>) {
    db::reset_interrupted(&state.db.lock().unwrap());
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
            // Marked "in progress" first: if decoding this file kills the
            // process, the next start records a failure instead of retrying
            // the same file forever (see `reset_interrupted`).
            {
                let conn = state.db.lock().unwrap();
                if need_thumb {
                    let _ = db::set_thumb(&conn, &id, db::IN_PROGRESS);
                }
                if need_meta {
                    let _ = db::set_meta_state(&conn, &id, db::IN_PROGRESS);
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// IHDR declaring `side` × `side` pixels, with no image data.
    fn png_header(side: u32) -> Vec<u8> {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(b"IHDR");
        ihdr.extend_from_slice(&side.to_be_bytes());
        ihdr.extend_from_slice(&side.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]); // 8-bit RGB
        let crc = {
            // CRC-32 as PNG wants it; the decoder checks it before the dimensions.
            let mut c = 0xFFFF_FFFFu32;
            for b in &ihdr {
                c ^= *b as u32;
                for _ in 0..8 {
                    c = if c & 1 == 1 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
                }
            }
            !c
        };
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(&ihdr);
        png.extend_from_slice(&crc.to_be_bytes());
        png
    }

    #[test]
    fn oversized_images_are_refused_before_decoding() {
        let huge = png_header(100_000);
        let err = decode_image(&huge).unwrap_err().to_string().to_lowercase();
        assert!(err.contains("limit") || err.contains("dimension"), "{err}");
        // A plausible page still decodes (header only here: the error must
        // then be about the missing data, not about the limits).
        let err = decode_image(&png_header(4_000)).unwrap_err().to_string().to_lowercase();
        assert!(!err.contains("limit"), "{err}");
    }

    #[test]
    fn small_image_makes_a_thumbnail() {
        let mut png = Cursor::new(Vec::new());
        image::RgbImage::from_pixel(600, 900, image::Rgb([200, 30, 30])).write_to(&mut png, ImageFormat::Png).unwrap();
        let dest = std::env::temp_dir().join(format!("planche-thumb-{}.jpg", std::process::id()));
        write_thumbnail(&png.into_inner(), &dest).unwrap();
        let thumb = decode_image(&std::fs::read(&dest).unwrap()).unwrap();
        assert!(thumb.width() <= THUMB_W && thumb.height() <= THUMB_H);
        let _ = std::fs::remove_file(&dest);
    }
}
