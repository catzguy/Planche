//! Walks library roots and reconciles shelves (directories) and books
//! (archives, PDFs, EPUBs, image folders) with the database. Books keep their
//! id, progress and bookmarks when their path is unchanged, and also when they
//! were renamed or moved: a missing book whose content fingerprint matches a
//! newly found file is taken to be that file.

use crate::storage::{self, Entry};
use crate::db;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Book format from a file name (document URIs carry no usable extension).
pub fn book_kind(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
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

/// Shown name: a folder's name, or a file name without its extension.
pub fn display_name(name: &str, is_dir: bool) -> String {
    match name.rsplit_once('.') {
        Some((stem, _)) if !is_dir && !stem.is_empty() => stem.to_owned(),
        _ => name.to_owned(),
    }
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
fn fingerprint(entry: &Entry) -> Option<String> {
    let mut h = Fnv::new();
    if entry.is_dir {
        let mut entries: Vec<(String, u64)> =
            storage::list(&entry.path).ok()?.into_iter().map(|e| (e.name, e.size)).collect();
        entries.sort();
        for (name, len) in &entries {
            h.write(name.as_bytes());
            h.write(&len.to_le_bytes());
        }
        return Some(format!("d:{}:{:016x}", entries.len(), h.0));
    }
    let mut f = storage::open(&entry.path).ok()?;
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
    fn upsert_shelf(&mut self, dir: &Entry, parent: Option<&str>) -> Result<String> {
        let path = path_str(&dir.path);
        let existing: Option<String> = self
            .conn
            .query_row("SELECT id FROM shelves WHERE path = ?1", [&path], |r| r.get(0))
            .optional()?;
        let id = match existing {
            Some(id) => {
                self.conn.execute(
                    "UPDATE shelves SET parent_id = ?2, name = ?3, root_id = ?4 WHERE id = ?1",
                    params![id, parent, dir.name, self.root_id],
                )?;
                id
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                self.conn.execute(
                    "INSERT INTO shelves(id, root_id, parent_id, path, name) VALUES(?1, ?2, ?3, ?4, ?5)",
                    params![id, self.root_id, parent, path, dir.name],
                )?;
                id
            }
        };
        self.seen_shelves.insert(id.clone());
        Ok(id)
    }

    fn upsert_book(&mut self, e: &Entry, kind: &str, shelf: Option<&str>) -> Result<()> {
        let path = path_str(&e.path);
        let name = display_name(&e.name, e.is_dir);
        let (size, mtime) = (e.size as i64, e.mtime);
        let existing: Option<(String, i64, i64, Option<String>)> = self
            .conn
            .query_row("SELECT id, size, mtime, fingerprint FROM books WHERE path = ?1", [&path], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .optional()?;
        let id = match existing {
            Some((id, old_size, old_mtime, old_fp)) => {
                let changed = old_size != size || old_mtime != mtime;
                let fp = if changed || old_fp.is_none() { fingerprint(e) } else { old_fp };
                self.conn.execute(
                    "UPDATE books SET shelf_id = ?2, name = ?3, size = ?4, mtime = ?5, fingerprint = ?7,
                       root_id = ?8,
                       thumb = CASE WHEN ?6 THEN 0 ELSE thumb END,
                       meta = CASE WHEN ?6 THEN 0 ELSE meta END,
                       page_count = CASE WHEN ?6 THEN 0 ELSE page_count END
                     WHERE id = ?1",
                    params![id, shelf, name, size, mtime, changed, fp, self.root_id],
                )?;
                id
            }
            None => {
                let fp = fingerprint(e);
                match self.moved_book(fp.as_deref(), kind)? {
                    Some(id) => {
                        self.conn.execute(
                            "UPDATE books SET root_id = ?2, shelf_id = ?3, path = ?4, name = ?5,
                               size = ?6, mtime = ?7
                             WHERE id = ?1",
                            params![id, self.root_id, shelf, path, name, size, mtime],
                        )?;
                        id
                    }
                    None => {
                        let id = uuid::Uuid::new_v4().to_string();
                        self.conn.execute(
                            "INSERT INTO books(id, root_id, shelf_id, path, name, kind, size, mtime, added_at, fingerprint)
                             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                            params![id, self.root_id, shelf, path, name, kind, size, mtime, db::now(), fp],
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
            .find(|(id, old_path)| !self.seen_books.contains(id) && !storage::exists(Path::new(old_path)))
            .map(|(id, _)| id))
    }

    /// `shelf` is the shelf id of `dir`, or None when `dir` is the root itself.
    fn walk(&mut self, dir: &Path, shelf: Option<&str>) -> Result<()> {
        let Ok(entries) = storage::list(dir) else { return Ok(()) };
        let mut subdirs = Vec::new();
        for entry in entries {
            if hidden(&entry.name) {
                continue;
            }
            if entry.is_dir {
                subdirs.push(entry);
            } else if let Some(kind) = book_kind(&entry.name) {
                self.upsert_book(&entry, kind, shelf)?;
            }
        }
        for sub in subdirs {
            if is_image_folder(&sub.path) {
                self.upsert_book(&sub, "folder", shelf)?;
            } else {
                let id = self.upsert_shelf(&sub, shelf)?;
                self.walk(&sub.path, Some(&id))?;
            }
        }
        Ok(())
    }
}

/// A directory with images, no sub-directories and no book files reads as a book.
fn is_image_folder(dir: &Path) -> bool {
    let Ok(entries) = storage::list(dir) else { return false };
    let mut has_image = false;
    for e in entries {
        if hidden(&e.name) {
            continue;
        }
        if e.is_dir || book_kind(&e.name).is_some() {
            return false;
        }
        has_image |= is_image(&e.name);
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
