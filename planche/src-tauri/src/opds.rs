//! OPDS catalogs (Komga, Kavita, Calibre-web, public libraries…): saved
//! catalogs, authenticated fetches for the front-end (which parses the Atom or
//! JSON feeds), cover images and downloads into the library.
//!
//! Passwords live in the OS credential store (Windows Credential Manager,
//! macOS Keychain, Secret Service), never in the database; Android has none
//! reachable from here, so they go to the (encrypted) database there. They
//! are only sent to the catalog's own origin.

use crate::db;
use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use url::Url;

const KEYRING_SERVICE: &str = "Planche OPDS";
const MAX_FEED_BYTES: usize = 20 * 1024 * 1024;
const ACCEPT_FEED: &str =
    "application/opds+json, application/atom+xml;profile=opds-catalog, application/atom+xml, application/json;q=0.9, */*;q=0.5";

pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS opds_catalogs (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           url TEXT NOT NULL,
           username TEXT,
           added_at INTEGER NOT NULL);",
    )?;
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct Catalog {
    pub id: String,
    pub name: String,
    pub url: String,
    pub username: Option<String>,
    pub has_password: bool,
    /// Never sent to the front-end.
    #[serde(skip)]
    password: Option<String>,
}

#[cfg(not(target_os = "android"))]
mod secret {
    use super::KEYRING_SERVICE;
    use anyhow::{anyhow, Result};
    use rusqlite::Connection;

    fn entry(id: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| anyhow!("credential store: {e}"))
    }

    pub fn get(_: &Connection, id: &str) -> Option<String> {
        entry(id).ok()?.get_password().ok()
    }

    pub fn set(_: &Connection, id: &str, password: &str) -> Result<()> {
        entry(id)?.set_password(password).map_err(|e| anyhow!("credential store: {e}"))
    }

    pub fn delete(_: &Connection, id: &str) {
        if let Ok(e) = entry(id) {
            let _ = e.delete_credential();
        }
    }
}

#[cfg(target_os = "android")]
mod secret {
    use crate::db;
    use anyhow::Result;
    use rusqlite::Connection;

    fn key(id: &str) -> String {
        format!("opds-password:{id}")
    }

    pub fn get(conn: &Connection, id: &str) -> Option<String> {
        db::kv_get(conn, &key(id)).ok().flatten()
    }

    pub fn set(conn: &Connection, id: &str, password: &str) -> Result<()> {
        db::kv_set(conn, &key(id), password)
    }

    pub fn delete(conn: &Connection, id: &str) {
        let _ = conn.execute("DELETE FROM kv WHERE key = ?1", [key(id)]);
    }
}

pub fn list(conn: &Connection) -> Result<Vec<Catalog>> {
    let mut stmt = conn.prepare("SELECT id, name, url, username FROM opds_catalogs ORDER BY name COLLATE NOCASE")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<Vec<(String, String, String, Option<String>)>>>()?;
    Ok(rows
        .into_iter()
        .map(|(id, name, url, username)| {
            let password = secret::get(conn, &id);
            Catalog { has_password: password.is_some(), password, id, name, url, username }
        })
        .collect())
}

pub fn get(conn: &Connection, id: &str) -> Result<Catalog> {
    list(conn)?.into_iter().find(|c| c.id == id).ok_or_else(|| anyhow!("catalog not found"))
}

fn check_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw.trim()).context("adresse invalide")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("only http and https catalogs are supported");
    }
    Ok(url)
}

/// Creates (empty id) or updates a catalog. `password`: None keeps the stored
/// one, Some("") removes it.
pub fn save(
    conn: &Connection,
    id: &str,
    name: &str,
    url: &str,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<String> {
    let url = check_url(url)?;
    let username = username.map(str::trim).filter(|u| !u.is_empty());
    let id = if id.is_empty() {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO opds_catalogs(id, name, url, username, added_at) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![id, name.trim(), url.as_str(), username, db::now()],
        )?;
        id
    } else {
        conn.execute(
            "UPDATE opds_catalogs SET name = ?2, url = ?3, username = ?4 WHERE id = ?1",
            params![id, name.trim(), url.as_str(), username],
        )?;
        id.to_owned()
    };
    match password {
        Some("") => secret::delete(conn, &id),
        Some(p) => secret::set(conn, &id, p)?,
        None => {}
    }
    Ok(id)
}

pub fn remove(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM opds_catalogs WHERE id = ?1", [id])?;
    secret::delete(conn, id);
    Ok(())
}

fn client() -> Result<reqwest::Client> {
    let builder = reqwest::Client::builder()
        .user_agent(concat!("Planche/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60 * 30));
    // Android: rustls (ring) with Mozilla's root certificates.
    #[cfg(target_os = "android")]
    let builder = {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let roots = webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().filter_map(|c| reqwest::Certificate::from_der(c).ok());
        builder.tls_certs_only(roots)
    };
    Ok(builder.build()?)
}

/// GET with the catalog's credentials when (and only when) the target has the
/// same origin as the catalog. Redirects are followed by reqwest, which drops
/// the Authorization header when the host changes.
async fn request(catalog: &Catalog, raw_url: &str, accept: &str) -> Result<reqwest::Response> {
    let url = check_url(raw_url)?;
    let base = check_url(&catalog.url)?;
    let mut req = client()?.get(url.clone()).header(reqwest::header::ACCEPT, accept);
    if url.origin() == base.origin() {
        if let Some(user) = &catalog.username {
            req = req.basic_auth(user, catalog.password.as_deref());
        }
    }
    let resp = req.send().await?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        bail!("401");
    }
    if !resp.status().is_success() {
        bail!("HTTP {}", resp.status());
    }
    Ok(resp)
}

#[derive(Serialize)]
pub struct Fetched {
    /// Final URL after redirects: base for resolving relative links.
    pub url: String,
    pub content_type: String,
    pub body: String,
}

pub async fn fetch(catalog: &Catalog, url: &str) -> Result<Fetched> {
    let resp = request(catalog, url, ACCEPT_FEED).await?;
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let bytes = resp.bytes().await?;
    if bytes.len() > MAX_FEED_BYTES {
        bail!("feed too large");
    }
    Ok(Fetched { url: final_url, content_type, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Cover images, through the catalog's credentials.
pub async fn image(catalog: &Catalog, url: &str) -> Result<(Vec<u8>, String)> {
    let resp = request(catalog, url, "image/*").await?;
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_owned();
    Ok((resp.bytes().await?.to_vec(), ct))
}

/// File extension for a download, from its media type or the URL.
fn extension_for(content_type: &str, url: &Url) -> Option<&'static str> {
    let ct = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let by_type = match ct.as_str() {
        "application/epub+zip" => Some("epub"),
        "application/pdf" => Some("pdf"),
        "application/vnd.comicbook+zip" | "application/x-cbz" => Some("cbz"),
        "application/vnd.comicbook-rar" | "application/x-cbr" => Some("cbr"),
        "application/x-cb7" | "application/x-7z-compressed" => Some("cb7"),
        "application/x-cbt" | "application/x-tar" => Some("cbt"),
        "application/zip" => Some("cbz"),
        "application/x-rar-compressed" | "application/vnd.rar" => Some("cbr"),
        _ => None,
    };
    by_type.or_else(|| {
        let p = url.path().to_ascii_lowercase();
        ["cbz", "cbr", "cb7", "cbt", "epub", "pdf", "zip", "rar", "7z"].into_iter().find(|e| p.ends_with(&format!(".{e}")))
    })
}

fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    let short: String = trimmed.chars().take(150).collect();
    if short.is_empty() { "livre".into() } else { short }
}

/// Filename from Content-Disposition, if the server sent one.
fn disposition_name(resp: &reqwest::Response) -> Option<String> {
    let v = resp.headers().get(reqwest::header::CONTENT_DISPOSITION)?.to_str().ok()?;
    if let Some(star) = v.split(';').map(str::trim).find_map(|p| p.strip_prefix("filename*=")) {
        let enc = star.split("''").nth(1).unwrap_or(star);
        return Some(percent_encoding::percent_decode_str(enc.trim_matches('"')).decode_utf8_lossy().into_owned());
    }
    v.split(';').map(str::trim).find_map(|p| p.strip_prefix("filename=")).map(|f| f.trim_matches('"').to_owned())
}

fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    p
}

/// Downloads `url` into `dir`, reporting progress, and returns the file path.
pub async fn download(
    catalog: &Catalog,
    url: &str,
    title: &str,
    dir: &Path,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let resp = request(catalog, url, "*/*").await?;
    let final_url = resp.url().clone();
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let from_header = disposition_name(&resp);
    let ext = from_header
        .as_deref()
        .and_then(|n| n.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()))
        .filter(|e| ["cbz", "cbr", "cb7", "cbt", "epub", "pdf", "zip", "rar", "7z", "tar"].contains(&e.as_str()))
        .or_else(|| extension_for(&ct, &final_url).map(str::to_owned))
        .ok_or_else(|| anyhow!("format non pris en charge ({ct})"))?;
    let stem = from_header
        .as_deref()
        .and_then(|n| n.rsplit_once('.').map(|(s, _)| s.to_owned()))
        .unwrap_or_else(|| title.to_owned());
    let path = unique_path(dir, &sanitize(&stem), &ext);
    let partial = path.with_extension(format!("{ext}.part"));
    let total = resp.content_length();
    let mut file = std::fs::File::create(&partial)?;
    let mut received = 0u64;
    let mut stream = resp.bytes_stream();
    let mut last = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk)?;
        received += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(200) {
            progress(received, total);
            last = std::time::Instant::now();
        }
    }
    file.flush()?;
    drop(file);
    std::fs::rename(&partial, &path)?;
    progress(received, total.or(Some(received)));
    Ok(path)
}
