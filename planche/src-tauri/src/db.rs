use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Creates or upgrades the schema of the (in-memory, see vault.rs) database.
pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS roots (
           id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, added_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS shelves (
           id TEXT PRIMARY KEY,
           root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
           parent_id TEXT,
           path TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS books (
           id TEXT PRIMARY KEY,
           root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
           shelf_id TEXT,
           path TEXT NOT NULL UNIQUE,
           name TEXT NOT NULL,
           kind TEXT NOT NULL,
           size INTEGER NOT NULL DEFAULT 0,
           mtime INTEGER NOT NULL DEFAULT 0,
           added_at INTEGER NOT NULL,
           page_count INTEGER NOT NULL DEFAULT 0,
           current_page INTEGER NOT NULL DEFAULT 0,
           last_read INTEGER,
           finished INTEGER NOT NULL DEFAULT 0,
           favorite INTEGER NOT NULL DEFAULT 0,
           manga INTEGER,
           thumb INTEGER NOT NULL DEFAULT 0);
         CREATE INDEX IF NOT EXISTS books_shelf ON books(shelf_id);
         CREATE INDEX IF NOT EXISTS shelves_parent ON shelves(parent_id);
         CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;
    migrate(conn)?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "BEGIN;
             -- Content fingerprint used to recognise renamed or moved books.
             ALTER TABLE books ADD COLUMN fingerprint TEXT;
             CREATE INDEX books_fingerprint ON books(fingerprint);
             CREATE TABLE bookmarks (
               id TEXT PRIMARY KEY,
               book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
               name TEXT NOT NULL,
               page INTEGER NOT NULL,
               created_at INTEGER NOT NULL);
             CREATE INDEX bookmarks_book ON bookmarks(book_id);
             -- Files opened from outside the library.
             CREATE TABLE standalone (
               id TEXT PRIMARY KEY,
               path TEXT NOT NULL UNIQUE,
               name TEXT NOT NULL,
               kind TEXT NOT NULL,
               added_at INTEGER NOT NULL,
               page_count INTEGER NOT NULL DEFAULT 0,
               current_page INTEGER NOT NULL DEFAULT 0,
               last_read INTEGER,
               finished INTEGER NOT NULL DEFAULT 0,
               manga INTEGER);
             PRAGMA user_version = 1;
             COMMIT;",
        )?;
    }
    if version < 2 {
        conn.execute_batch(
            "BEGIN;
             -- Metadata from ComicInfo.xml / EPUB OPF. `meta`: 0 = to read, 1 = read.
             ALTER TABLE books ADD COLUMN title TEXT;
             ALTER TABLE books ADD COLUMN series TEXT;
             ALTER TABLE books ADD COLUMN number TEXT;
             ALTER TABLE books ADD COLUMN volume INTEGER;
             ALTER TABLE books ADD COLUMN year INTEGER;
             ALTER TABLE books ADD COLUMN authors TEXT;
             ALTER TABLE books ADD COLUMN meta INTEGER NOT NULL DEFAULT 0;
             CREATE INDEX books_series ON books(series);
             PRAGMA user_version = 2;
             COMMIT;",
        )?;
    }
    if version < 3 {
        conn.execute_batch(
            "BEGIN;
             -- Text EPUBs locate the reading position with an EPUB CFI, not a page index.
             ALTER TABLE books ADD COLUMN position TEXT;
             ALTER TABLE standalone ADD COLUMN position TEXT;
             -- Bookmarks and annotations also serve standalone files: no foreign key,
             -- orphans are purged with `purge_orphans`.
             CREATE TABLE bookmarks_v3 (
               id TEXT PRIMARY KEY,
               book_id TEXT NOT NULL,
               name TEXT NOT NULL,
               page INTEGER NOT NULL,
               position TEXT,
               created_at INTEGER NOT NULL);
             INSERT INTO bookmarks_v3(id, book_id, name, page, created_at)
               SELECT id, book_id, name, page, created_at FROM bookmarks;
             DROP TABLE bookmarks;
             ALTER TABLE bookmarks_v3 RENAME TO bookmarks;
             CREATE INDEX bookmarks_book ON bookmarks(book_id);
             -- Highlights on text (position = CFI range, text = quote) or notes on a
             -- page of an image book (position NULL).
             CREATE TABLE annotations (
               id TEXT PRIMARY KEY,
               book_id TEXT NOT NULL,
               page INTEGER NOT NULL,
               position TEXT,
               text TEXT,
               note TEXT NOT NULL DEFAULT '',
               color TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL);
             CREATE INDEX annotations_book ON annotations(book_id);
             PRAGMA user_version = 3;
             COMMIT;",
        )?;
    }
    Ok(())
}

/// Drops bookmarks and annotations whose book is gone from both the library
/// and the standalone files.
pub fn purge_orphans(conn: &Connection) -> Result<()> {
    for table in ["bookmarks", "annotations"] {
        conn.execute(
            &format!(
                "DELETE FROM {table} WHERE book_id NOT IN (SELECT id FROM books UNION SELECT id FROM standalone)"
            ),
            [],
        )?;
    }
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct Root {
    pub id: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
pub struct Shelf {
    pub id: String,
    pub root_id: String,
    pub parent_id: Option<String>,
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Clone)]
pub struct Book {
    pub id: String,
    pub root_id: String,
    pub shelf_id: Option<String>,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: i64,
    pub added_at: i64,
    pub page_count: i64,
    pub current_page: i64,
    pub last_read: Option<i64>,
    pub finished: bool,
    pub favorite: bool,
    pub manga: Option<bool>,
    pub thumb: i64,
    pub title: Option<String>,
    pub series: Option<String>,
    pub number: Option<String>,
    pub volume: Option<i64>,
    pub year: Option<i64>,
    pub authors: Option<String>,
    /// Reading position of text EPUBs (CFI); `current_page` holds its approximate location index.
    pub position: Option<String>,
}

#[derive(Serialize)]
pub struct Library {
    pub roots: Vec<Root>,
    pub shelves: Vec<Shelf>,
    pub books: Vec<Book>,
}

const BOOK_COLS: &str = "id, root_id, shelf_id, path, name, kind, size, added_at, page_count, \
     current_page, last_read, finished, favorite, manga, thumb, title, series, number, volume, year, authors, position";

fn row_to_book(r: &rusqlite::Row) -> rusqlite::Result<Book> {
    Ok(Book {
        id: r.get(0)?,
        root_id: r.get(1)?,
        shelf_id: r.get(2)?,
        path: r.get(3)?,
        name: r.get(4)?,
        kind: r.get(5)?,
        size: r.get(6)?,
        added_at: r.get(7)?,
        page_count: r.get(8)?,
        current_page: r.get(9)?,
        last_read: r.get(10)?,
        finished: r.get::<_, i64>(11)? != 0,
        favorite: r.get::<_, i64>(12)? != 0,
        manga: r.get::<_, Option<i64>>(13)?.map(|v| v != 0),
        thumb: r.get(14)?,
        title: r.get(15)?,
        series: r.get(16)?,
        number: r.get(17)?,
        volume: r.get(18)?,
        year: r.get(19)?,
        authors: r.get(20)?,
        position: r.get(21)?,
    })
}

/// Stores metadata read from the book (all fields None when it has none).
pub fn set_meta(conn: &Connection, id: &str, m: &crate::meta::Meta) -> Result<()> {
    conn.execute(
        "UPDATE books SET title = ?2, series = ?3, number = ?4, volume = ?5, year = ?6, authors = ?7, meta = 1
         WHERE id = ?1",
        params![id, m.title, m.series, m.number, m.volume, m.year, m.authors],
    )?;
    Ok(())
}

pub fn library(conn: &Connection) -> Result<Library> {
    let roots = conn
        .prepare("SELECT id, path FROM roots ORDER BY path")?
        .query_map([], |r| Ok(Root { id: r.get(0)?, path: r.get(1)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let shelves = conn
        .prepare("SELECT id, root_id, parent_id, path, name FROM shelves")?
        .query_map([], |r| {
            Ok(Shelf {
                id: r.get(0)?,
                root_id: r.get(1)?,
                parent_id: r.get(2)?,
                path: r.get(3)?,
                name: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let books = conn
        .prepare(&format!("SELECT {BOOK_COLS} FROM books"))?
        .query_map([], row_to_book)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Library { roots, shelves, books })
}

/// Standalone files map onto `Book` with an empty `root_id`.
const STANDALONE_COLS: &str = "id, '' AS root_id, NULL AS shelf_id, path, name, kind, 0 AS size, added_at, \
     page_count, current_page, last_read, finished, 0 AS favorite, manga, 0 AS thumb, \
     NULL, NULL, NULL, NULL, NULL, NULL, position";

pub fn book(conn: &Connection, id: &str) -> Result<Option<Book>> {
    let found = conn
        .query_row(&format!("SELECT {BOOK_COLS} FROM books WHERE id = ?1"), [id], row_to_book)
        .optional()?;
    if found.is_some() {
        return Ok(found);
    }
    Ok(conn
        .query_row(&format!("SELECT {STANDALONE_COLS} FROM standalone WHERE id = ?1"), [id], row_to_book)
        .optional()?)
}

/// Runs an UPDATE (with `{table}` placeholder) against the library, falling
/// back to standalone files when the id is not a library book.
fn update_any(conn: &Connection, sql: &str, p: &[&dyn rusqlite::ToSql]) -> Result<()> {
    for table in ["books", "standalone"] {
        if conn.execute(&sql.replace("{table}", table), p)? > 0 {
            break;
        }
    }
    Ok(())
}

pub fn set_progress(conn: &Connection, id: &str, page: i64, position: Option<&str>) -> Result<()> {
    update_any(
        conn,
        "UPDATE {table} SET current_page = ?2, last_read = ?3, position = ?4,
           finished = CASE WHEN page_count > 0 AND ?2 >= page_count - 1 THEN 1 ELSE finished END
         WHERE id = ?1",
        params![id, page, now(), position],
    )
}

pub fn set_page_count(conn: &Connection, id: &str, count: i64) -> Result<()> {
    update_any(conn, "UPDATE {table} SET page_count = ?2 WHERE id = ?1", params![id, count])
}

pub fn set_manga(conn: &Connection, id: &str, value: Option<bool>) -> Result<()> {
    update_any(conn, "UPDATE {table} SET manga = ?2 WHERE id = ?1", params![id, value])
}

/// Id of the book at `path`: the library entry if there is one, otherwise a
/// standalone record (created on first open).
pub fn open_path(conn: &Connection, path: &str, kind: &str, name: &str) -> Result<String> {
    for table in ["books", "standalone"] {
        let id: Option<String> = conn
            .query_row(&format!("SELECT id FROM {table} WHERE path = ?1"), [path], |r| r.get(0))
            .optional()?;
        if let Some(id) = id {
            return Ok(id);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO standalone(id, path, name, kind, added_at) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![id, path, name, kind, now()],
    )?;
    Ok(id)
}

/// Library books and standalone files, for joins that must cover both.
const ALL_BOOKS: &str = "(SELECT id, name, path FROM books UNION ALL SELECT id, name, path FROM standalone)";

#[derive(Serialize)]
pub struct Bookmark {
    pub id: String,
    pub book_id: String,
    pub book_name: String,
    pub name: String,
    pub page: i64,
    pub position: Option<String>,
    pub created_at: i64,
}

pub fn bookmarks(conn: &Connection, book_id: Option<&str>) -> Result<Vec<Bookmark>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT bm.id, bm.book_id, b.name, bm.name, bm.page, bm.position, bm.created_at
         FROM bookmarks bm JOIN {ALL_BOOKS} b ON b.id = bm.book_id
         WHERE ?1 IS NULL OR bm.book_id = ?1
         ORDER BY b.name, bm.page"
    ))?;
    let rows = stmt
        .query_map([book_id], |r| {
            Ok(Bookmark {
                id: r.get(0)?,
                book_id: r.get(1)?,
                book_name: r.get(2)?,
                name: r.get(3)?,
                page: r.get(4)?,
                position: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

#[derive(Serialize, serde::Deserialize, Clone)]
pub struct Annotation {
    #[serde(default)]
    pub id: String,
    pub book_id: String,
    #[serde(default)]
    pub book_name: String,
    #[serde(default)]
    pub book_path: String,
    pub page: i64,
    pub position: Option<String>,
    pub text: Option<String>,
    pub note: String,
    pub color: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

pub fn annotations(conn: &Connection, book_id: Option<&str>) -> Result<Vec<Annotation>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT a.id, a.book_id, b.name, b.path, a.page, a.position, a.text, a.note, a.color, a.created_at, a.updated_at
         FROM annotations a JOIN {ALL_BOOKS} b ON b.id = a.book_id
         WHERE ?1 IS NULL OR a.book_id = ?1
         ORDER BY b.name, a.page, a.created_at"
    ))?;
    let rows = stmt
        .query_map([book_id], |r| {
            Ok(Annotation {
                id: r.get(0)?,
                book_id: r.get(1)?,
                book_name: r.get(2)?,
                book_path: r.get(3)?,
                page: r.get(4)?,
                position: r.get(5)?,
                text: r.get(6)?,
                note: r.get(7)?,
                color: r.get(8)?,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Inserts (empty id) or updates an annotation; returns its id.
pub fn save_annotation(conn: &Connection, a: &Annotation) -> Result<String> {
    let t = now();
    if a.id.is_empty() {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO annotations(id, book_id, page, position, text, note, color, created_at, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![id, a.book_id, a.page, a.position, a.text, a.note, a.color, t],
        )?;
        Ok(id)
    } else {
        conn.execute(
            "UPDATE annotations SET note = ?2, color = ?3, updated_at = ?4 WHERE id = ?1",
            params![a.id, a.note, a.color, t],
        )?;
        Ok(a.id.clone())
    }
}

pub fn set_thumb(conn: &Connection, id: &str, state: i64) -> Result<()> {
    conn.execute("UPDATE books SET thumb = ?2 WHERE id = ?1", params![id, state])?;
    Ok(())
}

pub fn kv_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn kv_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO kv(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}
