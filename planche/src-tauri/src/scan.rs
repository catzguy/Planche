//! Walks library roots and reconciles shelves (directories) and books
//! (archives, PDFs, EPUBs, image folders) with the database. Books keep their
//! id, progress and bookmarks when their path is unchanged, and also when they
//! were renamed or moved: a missing book whose content fingerprint matches a
//! newly found file is taken to be that file.

use crate::db;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub fn book_kind(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "cbz" | "zip" => "zip",
        "cbr" | "rar" => "rar",
        "cb7" | "7z" => "7z",
        "cbt" | "tar" => "tar",
        "pdf" => "pdf",
        "epub" => "epub",
        _ => return None,
    })
}

pub fn is_image(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]
        .iter()
        .any(|e| lower.ends_with(e))
}

fn hidden(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case("__MACOSX")
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

pub fn display_name(p: &Path) -> String {
    let stem = if p.is_dir() { p.file_name() } else { p.file_stem() };
    stem.map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// FNV-1a: tiny and stable across Rust versions, unlike `DefaultHasher`.
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf29ce484222325)
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0 ^ *b as u64).wrapping_mul(0x100000001b3);
        }
    }
}

const FINGERPRINT_CHUNK: u64 = 64 * 1024;

/// Identifies a book's content independently of its path: size plus a hash of
/// the head and tail of the file (archives keep their index at the end), or
/// the listing of an image folder.
fn fingerprint(p: &Path) -> Option<String> {
    let mut h = Fnv::new();
    if p.is_dir() {
        let mut entries: Vec<(String, u64)> = fs::read_dir(p)
            .ok()?
            .flatten()
            .filter_map(|e| Some((e.file_name().to_string_lossy().into_owned(), e.metadata().ok()?.len())))
            .collect();
        entries.sort();
        for (name, len) in &entries {
            h.write(name.as_bytes());
            h.write(&len.to_le_bytes());
        }
        return Some(format!("d:{}:{:016x}", entries.len(), h.0));
    }
    let mut f = File::open(p).ok()?;
    let size = f.metadata().ok()?.len();
    let mut buf = vec![0u8; FINGERPRINT_CHUNK.min(size) as usize];
    f.read_exact(&mut buf).ok()?;
    h.write(&buf);
    if size > FINGERPRINT_CHUNK {
        let tail = FINGERPRINT_CHUNK.min(size - FINGERPRINT_CHUNK);
        f.seek(SeekFrom::End(-(tail as i64))).ok()?;
        buf.resize(tail as usize, 0);
        f.read_exact(&mut buf).ok()?;
        h.write(&buf);
    }
    Some(format!("f:{size}:{:016x}", h.0))
}

struct Walk<'a> {
    conn: &'a Connection,
    root_id: &'a str,
    seen_shelves: HashSet<String>,
    seen_books: HashSet<String>,
}

impl Walk<'_> {
    fn upsert_shelf(&mut self, dir: &Path, parent: Option<&str>) -> Result<String> {
        let path = path_str(dir);
        let existing: Option<String> = self
            .conn
            .query_row("SELECT id FROM shelves WHERE path = ?1", [&path], |r| r.get(0))
            .optional()?;
        let id = match existing {
            Some(id) => {
                self.conn.execute(
                    "UPDATE shelves SET parent_id = ?2, name = ?3, root_id = ?4 WHERE id = ?1",
                    params![id, parent, display_name(dir), self.root_id],
                )?;
                id
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                self.conn.execute(
                    "INSERT INTO shelves(id, root_id, parent_id, path, name) VALUES(?1, ?2, ?3, ?4, ?5)",
                    params![id, self.root_id, parent, path, display_name(dir)],
                )?;
                id
            }
        };
        self.seen_shelves.insert(id.clone());
        Ok(id)
    }

    fn upsert_book(&mut self, p: &Path, kind: &str, shelf: Option<&str>) -> Result<()> {
        let path = path_str(p);
        let meta = fs::metadata(p).ok();
        let size = meta.as_ref().filter(|m| m.is_file()).map(|m| m.len() as i64).unwrap_or(0);
        let mtime = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let existing: Option<(String, i64, i64, Option<String>)> = self
            .conn
            .query_row("SELECT id, size, mtime, fingerprint FROM books WHERE path = ?1", [&path], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .optional()?;
        let id = match existing {
            Some((id, old_size, old_mtime, old_fp)) => {
                let changed = old_size != size || old_mtime != mtime;
                let fp = if changed || old_fp.is_none() { fingerprint(p) } else { old_fp };
                self.conn.execute(
                    "UPDATE books SET shelf_id = ?2, name = ?3, size = ?4, mtime = ?5, fingerprint = ?7,
                       root_id = ?8,
                       thumb = CASE WHEN ?6 THEN 0 ELSE thumb END,
                       meta = CASE WHEN ?6 THEN 0 ELSE meta END,
                       page_count = CASE WHEN ?6 THEN 0 ELSE page_count END
                     WHERE id = ?1",
                    params![id, shelf, display_name(p), size, mtime, changed, fp, self.root_id],
                )?;
                id
            }
            None => {
                let fp = fingerprint(p);
                match self.moved_book(fp.as_deref(), kind)? {
                    Some(id) => {
                        self.conn.execute(
                            "UPDATE books SET root_id = ?2, shelf_id = ?3, path = ?4, name = ?5,
                               size = ?6, mtime = ?7
                             WHERE id = ?1",
                            params![id, self.root_id, shelf, path, display_name(p), size, mtime],
                        )?;
                        id
                    }
                    None => {
                        let id = uuid::Uuid::new_v4().to_string();
                        self.conn.execute(
                            "INSERT INTO books(id, root_id, shelf_id, path, name, kind, size, mtime, added_at, fingerprint)
                             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                            params![id, self.root_id, shelf, path, display_name(p), kind, size, mtime, db::now(), fp],
                        )?;
                        id
                    }
                }
            }
        };
        self.seen_books.insert(id);
        Ok(())
    }

    /// A known book with this fingerprint whose file no longer exists at its
    /// recorded path, i.e. the file that was renamed or moved to the new path.
    fn moved_book(&self, fp: Option<&str>, kind: &str) -> Result<Option<String>> {
        let Some(fp) = fp else { return Ok(None) };
        let mut stmt = self.conn.prepare("SELECT id, path FROM books WHERE fingerprint = ?1 AND kind = ?2")?;
        let candidates: Vec<(String, String)> =
            stmt.query_map([fp, kind], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        Ok(candidates
            .into_iter()
            .find(|(id, old_path)| !self.seen_books.contains(id) && !Path::new(old_path).exists())
            .map(|(id, _)| id))
    }

    /// `shelf` is the shelf id of `dir`, or None when `dir` is the root itself.
    fn walk(&mut self, dir: &Path, shelf: Option<&str>) -> Result<()> {
        let Ok(entries) = fs::read_dir(dir) else { return Ok(()) };
        let mut subdirs = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if hidden(&name) {
                continue;
            }
            let p = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_dir() => subdirs.push(p),
                Ok(_) => {
                    if let Some(kind) = book_kind(&p) {
                        self.upsert_book(&p, kind, shelf)?;
                    }
                }
                Err(_) => {}
            }
        }
        for sub in subdirs {
            if is_image_folder(&sub) {
                self.upsert_book(&sub, "folder", shelf)?;
            } else {
                let id = self.upsert_shelf(&sub, shelf)?;
                self.walk(&sub, Some(&id))?;
            }
        }
        Ok(())
    }
}

/// A directory with images, no sub-directories and no book files reads as a book.
fn is_image_folder(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else { return false };
    let mut has_image = false;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if hidden(&name) {
            continue;
        }
        let p = e.path();
        if p.is_dir() || book_kind(&p).is_some() {
            return false;
        }
        has_image |= is_image(&name);
    }
    has_image
}

/// Scans `roots` (id, path) in one transaction, so that a book moved from one
/// root to another is recognised before the old entry is dropped.
pub fn scan_roots(conn: &mut Connection, roots: &[(String, String)]) -> Result<()> {
    let tx = conn.transaction()?;
    let (seen_shelves, seen_books) = {
        let mut w = Walk {
            conn: &tx,
            root_id: "",
            seen_shelves: HashSet::new(),
            seen_books: HashSet::new(),
        };
        for (id, path) in roots {
            w.root_id = id;
            w.walk(Path::new(path), None)?;
        }
        (w.seen_shelves, w.seen_books)
    };
    let stale = |table: &str, root_id: &str, seen: &HashSet<String>| -> Result<Vec<String>> {
        let mut stmt = tx.prepare(&format!("SELECT id FROM {table} WHERE root_id = ?1"))?;
        let ids = stmt
            .query_map([root_id], |r| r.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .filter(|id| !seen.contains(id))
            .collect();
        Ok(ids)
    };
    for (root_id, _) in roots {
        for id in stale("books", root_id, &seen_books)? {
            tx.execute("DELETE FROM books WHERE id = ?1", [id])?;
        }
        for id in stale("shelves", root_id, &seen_shelves)? {
            tx.execute("DELETE FROM shelves WHERE id = ?1", [id])?;
        }
    }
    tx.commit()?;
    Ok(())
}
