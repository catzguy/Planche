//! Opens a book and serves its pages. ZIP-based books (cbz, epub) are read in
//! place; RAR, 7z and TAR are extracted once into a small on-disk cache since
//! they do not support cheap random access.

use crate::scan::is_image;
use crate::storage;
use anyhow::{anyhow, bail, Context, Result};
use regex::Regex;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_CACHED_BOOKS: usize = 4;

/// Error for EPUBs without images; the front-end matches on it to offer another app.
pub const TEXT_EPUB: &str = "EPUB texte : Planche ne lit que les EPUB composés d'images (BD, mangas)";

pub enum Source {
    Zip(Mutex<zip::ZipArchive<File>>),
    /// One file per page (image folder, extracted archive).
    Files(Vec<PathBuf>),
}

pub struct OpenBook {
    pub source: Source,
    /// Entry names (zip) or paths relative to the folder (files).
    pub pages: Vec<String>,
}

impl OpenBook {
    pub fn page_bytes(&self, index: usize) -> Result<Vec<u8>> {
        let name = self.pages.get(index).ok_or_else(|| anyhow!("page {index} out of range"))?;
        match &self.source {
            Source::Zip(zip) => {
                let mut zip = zip.lock().unwrap();
                let entry = zip.by_name(name)?;
                // The declared size is untrusted: never allocate or read past the limit.
                if entry.size() > MAX_ENTRY_BYTES {
                    bail!("page too large");
                }
                let mut buf = Vec::with_capacity(entry.size() as usize);
                entry.take(MAX_ENTRY_BYTES + 1).read_to_end(&mut buf)?;
                if buf.len() as u64 > MAX_ENTRY_BYTES {
                    bail!("page too large");
                }
                Ok(buf)
            }
            Source::Files(files) => Ok(storage::read(&files[index])?),
        }
    }
}

pub fn mime_for(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    match lower.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        _ => "image/jpeg",
    }
}

fn natural_sort(names: &mut [String]) {
    names.sort_by(|a, b| natord::compare_ignore_case(a, b));
}

/// Real container format, detected from magic bytes: comic files are often
/// mislabelled (a .cbr that is actually a zip, and the reverse).
pub fn sniff(path: &Path, declared: &str) -> String {
    let mut head = [0u8; 8];
    let n = storage::open(path).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    let head = &head[..n];
    if head.starts_with(b"PK\x03\x04") {
        if declared == "epub" { "epub" } else { "zip" }.into()
    } else if head.starts_with(b"Rar!") {
        "rar".into()
    } else if head.starts_with(b"7z\xBC\xAF\x27\x1C") {
        "7z".into()
    } else {
        declared.into()
    }
}

pub fn open(path: &Path, kind: &str, cache_dir: &Path, book_id: &str) -> Result<OpenBook> {
    match sniff(path, kind).as_str() {
        "folder" => open_dir(path),
        "zip" => open_zip(path, false),
        "epub" => open_zip(path, true),
        "rar" | "7z" | "tar" => {
            let dest = extract_cached(path, &sniff(path, kind), cache_dir, book_id)?;
            open_dir(&dest)
        }
        "pdf" => bail!("PDF books are rendered by the front-end"),
        other => bail!("unsupported book kind {other}"),
    }
}

/// Images under `dir` (recursively), as (path relative to `dir`, file).
fn images_under(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    for e in storage::list(dir)? {
        if e.name.starts_with('.') || e.name == "__MACOSX" {
            continue;
        }
        let rel = format!("{prefix}{}", e.name);
        if e.is_dir {
            images_under(&e.path, &format!("{rel}/"), out)?;
        } else if is_image(&rel) {
            out.push((rel, e.path));
        }
    }
    Ok(())
}

fn open_dir(dir: &Path) -> Result<OpenBook> {
    let mut images = Vec::new();
    images_under(dir, "", &mut images)?;
    images.sort_by(|a, b| natord::compare_ignore_case(&a.0, &b.0));
    if images.is_empty() {
        bail!("no images found");
    }
    let (pages, files) = images.into_iter().unzip();
    Ok(OpenBook { source: Source::Files(files), pages })
}

fn open_zip(path: &Path, epub: bool) -> Result<OpenBook> {
    let mut zip = zip::ZipArchive::new(storage::open(path)?).context("invalid zip archive")?;
    let spine = if epub { epub_spine_images(&mut zip) } else { None };
    if let Some(spine) = &spine {
        // A novel (even an illustrated one) has real text between its images:
        // leave it to the reflowable reader.
        if spine.pages.is_empty() || spine.text_chars > TEXT_CHARS_PER_DOC * spine.documents.max(1) {
            bail!(TEXT_EPUB);
        }
    }
    let mut pages = spine.map(|s| s.pages).unwrap_or_default();
    // Unreadable OPF or plain archive: every image, in natural order.
    if pages.is_empty() {
        pages = zip
            .file_names()
            .filter_map(|n| n.ok().map(|n| n.into_owned()))
            .filter(|n| is_image(n) && !n.split('/').any(|c| c.starts_with('.') || c == "__MACOSX"))
            .collect();
        natural_sort(&mut pages);
    }
    if pages.is_empty() {
        bail!(if epub { TEXT_EPUB } else { "no images found" });
    }
    Ok(OpenBook { source: Source::Zip(Mutex::new(zip)), pages })
}

fn read_entry(zip: &mut zip::ZipArchive<File>, name: &str) -> Option<String> {
    let mut s = String::new();
    zip.by_name(name).ok()?.read_to_string(&mut s).ok()?;
    Some(s)
}

/// Resolves `href` relative to the directory of `base` inside the archive.
fn join_zip_path(base: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or(href);
    let mut parts: Vec<&str> = base.rsplit_once('/').map(|(d, _)| d.split('/').collect()).unwrap_or_default();
    for seg in href.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// Above this many characters of text per spine document on average, an EPUB
/// reads as text rather than as a sequence of page images.
const TEXT_CHARS_PER_DOC: usize = 300;

struct Spine {
    pages: Vec<String>,
    /// Visible text characters across all spine documents.
    text_chars: usize,
    documents: usize,
}

/// Images of an EPUB in reading order: follows the OPF spine and collects
/// images referenced by each XHTML document (or the item itself if it is one).
fn epub_spine_images(zip: &mut zip::ZipArchive<File>) -> Option<Spine> {
    let container = read_entry(zip, "META-INF/container.xml")?;
    let opf_path = Regex::new(r#"full-path\s*=\s*"([^"]+)""#).ok()?.captures(&container)?[1].to_string();
    let opf = read_entry(zip, &opf_path)?;
    let attr = |tag: &str, name: &str| -> Option<String> {
        Regex::new(&format!(r#"\b{name}\s*=\s*"([^"]*)""#)).ok()?.captures(tag).map(|c| c[1].to_string())
    };
    let mut manifest = std::collections::HashMap::new();
    for m in Regex::new(r"<(?:\w+:)?item\b[^>]*>").ok()?.find_iter(&opf) {
        if let (Some(id), Some(href)) = (attr(m.as_str(), "id"), attr(m.as_str(), "href")) {
            manifest.insert(id, join_zip_path(&opf_path, &href));
        }
    }
    let img_ref = Regex::new(r#"(?i)(?:src|xlink:href|href)\s*=\s*["']([^"']+\.(?:jpe?g|png|gif|webp|bmp))["']"#).ok()?;
    let markup = Regex::new(r"(?s)<script\b.*?</script>|<style\b.*?</style>|<[^>]*>|&[#\w]+;").ok()?;
    let mut seen = HashSet::new();
    let mut pages = Vec::new();
    let (mut text_chars, mut documents) = (0, 0);
    for m in Regex::new(r"<(?:\w+:)?itemref\b[^>]*>").ok()?.find_iter(&opf) {
        let Some(doc) = attr(m.as_str(), "idref").and_then(|id| manifest.get(&id).cloned()) else { continue };
        documents += 1;
        let found: Vec<String> = if is_image(&doc) {
            vec![doc]
        } else {
            let html = read_entry(zip, &doc).unwrap_or_default();
            let body = html.split_once("<body").map(|(_, b)| b).unwrap_or(&html);
            text_chars += markup.replace_all(body, " ").chars().filter(|c| !c.is_whitespace()).count();
            img_ref.captures_iter(&html).map(|c| join_zip_path(&doc, &c[1])).collect()
        };
        for p in found {
            if zip.index_for_name(&p).is_some() && seen.insert(p.clone()) {
                pages.push(p);
            }
        }
    }
    Some(Spine { pages, text_chars, documents })
}

fn extract_cached(path: &Path, kind: &str, cache_dir: &Path, book_id: &str) -> Result<PathBuf> {
    let dest = cache_dir.join(book_id);
    let marker = dest.join(".complete");
    if marker.exists() {
        // Recreating the marker bumps the directory mtime used by `prune_cache`.
        let _ = fs::remove_file(&marker).and_then(|_| File::create(&marker).map(drop));
        return Ok(dest);
    }
    prune_cache(cache_dir);
    let _ = fs::remove_dir_all(&dest);
    fs::create_dir_all(&dest)?;
    let mut sink = Extractor { dest: &dest, total: 0 };
    match kind {
        "rar" => extract_rar(path, &mut sink)?,
        "7z" => extract_7z(path, &mut sink)?,
        "tar" => extract_tar(path, &mut sink)?,
        _ => unreachable!(),
    }
    File::create(&marker)?;
    Ok(dest)
}

/// Archives are untrusted. Extraction never relies on the format library to
/// pick output paths: only regular image files are written, under a path made
/// of plain components, by this code, within these size limits (which also
/// stop decompression bombs).
pub const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_EXTRACT_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;

/// `name` as a relative path of normal components, or None if it could
/// escape the destination (`..`, absolute, drive or stream syntax).
pub fn safe_relative(name: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in name.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => return None,
            p if p.contains(':') || p.chars().any(char::is_control) => return None,
            p => out.push(p),
        }
    }
    (!out.as_os_str().is_empty() && !name.starts_with(['/', '\\'])).then_some(out)
}

struct Extractor<'a> {
    dest: &'a Path,
    total: u64,
}

impl Extractor<'_> {
    /// Whether an entry should be written: an image with a safe name and a
    /// declared size within limits. Returns the target path.
    fn accept(&mut self, name: &str, size: u64) -> Result<Option<PathBuf>> {
        if !is_image(name) {
            return Ok(None);
        }
        let Some(rel) = safe_relative(name) else { return Ok(None) };
        if size > MAX_ENTRY_BYTES {
            return Ok(None);
        }
        self.total += size;
        if self.total > MAX_EXTRACT_BYTES {
            bail!("archive too large once decompressed");
        }
        Ok(Some(self.dest.join(rel)))
    }

    /// Writes at most MAX_ENTRY_BYTES from `data`, whatever size was declared.
    fn write(&mut self, target: &Path, data: &mut dyn Read) -> Result<()> {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(target)?;
        let written = std::io::copy(&mut data.take(MAX_ENTRY_BYTES + 1), &mut file)?;
        if written > MAX_ENTRY_BYTES {
            drop(file);
            let _ = fs::remove_file(target);
            bail!("archive entry larger than declared");
        }
        Ok(())
    }
}

fn extract_rar(path: &Path, sink: &mut Extractor) -> Result<()> {
    let file = storage::open(path)?;
    let mut archive =
        unrar::Archive::new(&storage::native_path(path, &file)).open_for_processing().map_err(|e| anyhow!("rar: {e}"))?;
    let mut count = 0;
    while let Some(header) = archive.read_header().map_err(|e| anyhow!("rar: {e}"))? {
        count += 1;
        if count > MAX_ENTRIES {
            bail!("too many entries");
        }
        let entry = header.entry();
        let target = if entry.is_file() {
            sink.accept(&entry.filename.to_string_lossy(), entry.unpacked_size)?
        } else {
            None
        };
        archive = match target {
            // The bytes are read in memory (size checked above) and written by
            // us: a link entry becomes a plain file, never a link.
            Some(target) => {
                let (bytes, next) = header.read().map_err(|e| anyhow!("rar: {e}"))?;
                sink.write(&target, &mut bytes.as_slice())?;
                next
            }
            None => header.skip().map_err(|e| anyhow!("rar: {e}"))?,
        };
    }
    Ok(())
}

fn extract_7z(path: &Path, sink: &mut Extractor) -> Result<()> {
    let mut count = 0;
    let mut failure: Option<anyhow::Error> = None;
    sevenz_rust2::decompress_with_extract_fn(storage::open(path)?, sink.dest, |entry, reader, _| {
        count += 1;
        let step = (|| -> Result<()> {
            if count > MAX_ENTRIES {
                bail!("too many entries");
            }
            match (!entry.is_directory()).then(|| sink.accept(entry.name(), entry.size())).transpose()?.flatten() {
                Some(target) => sink.write(&target, reader),
                // Skipped entries are drained so solid streams stay aligned.
                None => std::io::copy(reader, &mut std::io::sink()).map(drop).map_err(Into::into),
            }
        })();
        match step {
            Ok(()) => Ok(true),
            Err(e) => {
                failure = Some(e);
                Ok(false)
            }
        }
    })
    .map_err(|e| anyhow!("7z: {e}"))?;
    failure.map_or(Ok(()), Err)
}

fn extract_tar(path: &Path, sink: &mut Extractor) -> Result<()> {
    let mut archive = tar::Archive::new(storage::open(path)?);
    for (i, entry) in archive.entries()?.enumerate() {
        if i >= MAX_ENTRIES {
            bail!("too many entries");
        }
        let mut entry = entry?;
        // Regular files only: symlinks, hard links and devices are ignored.
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let name = entry.path()?.to_string_lossy().into_owned();
        if let Some(target) = sink.accept(&name, entry.size())? {
            sink.write(&target, &mut entry)?;
        }
    }
    Ok(())
}

fn prune_cache(cache_dir: &Path) {
    let Ok(entries) = fs::read_dir(cache_dir) else { return };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), e.path()))
        .collect();
    if dirs.len() < MAX_CACHED_BOOKS {
        return;
    }
    dirs.sort();
    for (_, d) in dirs.iter().take(dirs.len() + 1 - MAX_CACHED_BOOKS) {
        let _ = fs::remove_dir_all(d);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_names_cannot_escape() {
        assert_eq!(safe_relative("a/b/p1.jpg"), Some(PathBuf::from("a").join("b").join("p1.jpg")));
        assert_eq!(safe_relative(r"./a\p1.jpg"), Some(PathBuf::from("a").join("p1.jpg")));
        for evil in ["../p.jpg", "a/../../p.jpg", "/etc/p.jpg", r"\\server\share\p.jpg", r"C:\p.jpg", "c:p.jpg", "p.jpg:stream", "", "./", r"a\..\..\p.jpg"] {
            assert_eq!(safe_relative(evil), None, "{evil}");
        }
    }
}
