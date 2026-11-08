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
                // Reserve at most a few MiB up front: a forged size must not
                // cost memory before any byte is read.
                let mut buf = Vec::with_capacity(entry.size().min(PREALLOC_BYTES) as usize);
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

/// Largest XML/XHTML document read from an EPUB (container, OPF, spine
/// documents): a bigger one is read up to this limit only, so a
/// decompression bomb cannot exhaust memory.
pub const MAX_XML_BYTES: u64 = 4 * 1024 * 1024;
/// Memory reserved before reading an archive entry whose declared size is untrusted.
const PREALLOC_BYTES: u64 = 8 * 1024 * 1024;

fn read_entry(zip: &mut zip::ZipArchive<File>, name: &str) -> Option<String> {
    let mut buf = Vec::new();
    zip.by_name(name).ok()?.take(MAX_XML_BYTES).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
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
pub const MAX_EXTRACT_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 100_000;
/// RAR dictionaries above this size are refused before anything is unpacked:
/// UnRAR allocates the whole window up front, and a window larger than the
/// largest accepted entry only serves solid streams.
pub const MAX_RAR_DICT_KIB: u32 = 256 * 1024;

/// Refuses a RAR entry whose declared dictionary would make UnRAR allocate
/// gigabytes (checked before `read` and `skip`: in a solid archive skipping
/// unpacks too).
pub fn check_rar_dict(entry: &unrar::FileHeader) -> Result<()> {
    if entry.dict_size_kib > MAX_RAR_DICT_KIB {
        bail!("rar: dictionary too large ({} MiB)", entry.dict_size_kib / 1024);
    }
    Ok(())
}

/// Running total of what skipping entries of a solid archive costs: they are
/// unpacked all the same (UnRAR in test mode, 7z decoded to a sink).
#[derive(Default)]
pub struct SolidBudget(u64);

impl SolidBudget {
    pub fn spend(&mut self, size: u64) -> Result<()> {
        self.0 = self.0.saturating_add(size);
        if self.0 > MAX_EXTRACT_BYTES {
            bail!("archive too large once decompressed");
        }
        Ok(())
    }
}

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

    /// Accounts for an entry that is not written but has to be decoded all the
    /// same (solid stream): it costs its declared size.
    fn skip(&mut self, size: u64) -> Result<()> {
        self.total = self.total.saturating_add(size);
        if self.total > MAX_EXTRACT_BYTES {
            bail!("archive too large once decompressed");
        }
        Ok(())
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
    // Skipping an entry of a solid archive unpacks it (to nowhere): it counts.
    let solid = archive.is_solid();
    let mut count = 0;
    while let Some(header) = archive.read_header().map_err(|e| anyhow!("rar: {e}"))? {
        count += 1;
        if count > MAX_ENTRIES {
            bail!("too many entries");
        }
        let entry = header.entry();
        check_rar_dict(entry)?;
        let target = if entry.is_file() {
            sink.accept(&entry.filename.to_string_lossy(), entry.unpacked_size)?
        } else {
            None
        };
        if solid && target.is_none() {
            sink.skip(entry.unpacked_size)?;
        }
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
    // The reader is driven directly: the library's own path check would fail
    // the whole book on a name that `safe_relative` simply ignores.
    let mut reader = sevenz_rust2::ArchiveReader::new(storage::open(path)?, sevenz_rust2::Password::empty())
        .map_err(|e| anyhow!("7z: {e}"))?;
    let solid = reader.archive().is_solid;
    let mut count = 0;
    let mut failure: Option<anyhow::Error> = None;
    reader
        .for_each_entries(|entry, data| {
            if failure.is_some() {
                return Ok(false);
            }
            count += 1;
            let step = (|| -> Result<()> {
                if count > MAX_ENTRIES {
                    bail!("too many entries");
                }
                match (!entry.is_directory()).then(|| sink.accept(entry.name(), entry.size())).transpose()?.flatten() {
                    Some(target) => sink.write(&target, data),
                    // A solid stream has to be decoded through skipped entries
                    // to stay aligned, which costs their declared size; other
                    // archives move to the next block for free.
                    None if solid => {
                        sink.skip(entry.size())?;
                        std::io::copy(data, &mut std::io::sink())?;
                        Ok(())
                    }
                    None => Ok(()),
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

/// Bytes of the 7z entry `name`, within MAX_ENTRY_BYTES. In a solid archive
/// `ArchiveReader::read_file` would read every entry stored before it into
/// memory: those are decoded into a sink instead, within MAX_EXTRACT_BYTES.
pub fn read_7z_entry(reader: &mut sevenz_rust2::ArchiveReader<File>, name: &str) -> Result<Vec<u8>> {
    read_7z_entry_within(reader, name, MAX_EXTRACT_BYTES)
}

fn read_7z_entry_within<R: Read + std::io::Seek>(
    reader: &mut sevenz_rust2::ArchiveReader<R>,
    name: &str,
    budget: u64,
) -> Result<Vec<u8>> {
    let size = reader.archive().files.iter().find(|f| f.name() == name).map_or(0, |f| f.size());
    if size > MAX_ENTRY_BYTES {
        bail!("page too large");
    }
    if !reader.archive().is_solid {
        return reader.read_file(name).map_err(|e| anyhow!("7z: {e}"));
    }
    let (mut found, mut drained, mut failure) = (None, 0u64, None);
    reader
        .for_each_entries(|entry, data| {
            if entry.name() == name {
                let mut bytes = Vec::with_capacity(size.min(PREALLOC_BYTES) as usize);
                data.take(MAX_ENTRY_BYTES + 1).read_to_end(&mut bytes)?;
                found = Some(bytes);
                return Ok(false);
            }
            drained = drained.saturating_add(entry.size());
            if drained > budget {
                failure = Some(anyhow!("archive too large once decompressed"));
                return Ok(false);
            }
            std::io::copy(data, &mut std::io::sink())?;
            Ok(true)
        })
        .map_err(|e| anyhow!("7z: {e}"))?;
    match (failure, found) {
        (Some(e), _) => Err(e),
        (None, Some(bytes)) if bytes.len() as u64 > MAX_ENTRY_BYTES => bail!("page too large"),
        (None, Some(bytes)) => Ok(bytes),
        (None, None) => bail!("7z: entry not found"),
    }
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

    /// The patched UnRAR (iterative header reading) and crate (no panic on
    /// unknown codes, dictionary size exposed) still read real archives; a
    /// password-protected one fails cleanly. Fixtures from the unrar crate.
    #[test]
    fn patched_unrar_reads_archives() {
        let data = Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor/unrar/data");
        let version = data.join("version.rar");
        let names: Vec<_> = unrar::Archive::new(&version).open_for_listing().unwrap().map(|e| e.unwrap().filename).collect();
        assert_eq!(names, vec![PathBuf::from("VERSION")]);
        let header = unrar::Archive::new(&version).open_for_processing().unwrap().read_header().unwrap().unwrap();
        check_rar_dict(header.entry()).unwrap();
        assert!(header.entry().dict_size_kib > 0 && header.entry().dict_size_kib <= MAX_RAR_DICT_KIB);
        assert_eq!(header.read().unwrap().0, b"unrar-0.4.0");

        let solid = unrar::Archive::new(&data.join("solid.rar")).open_for_processing().unwrap();
        assert!(solid.is_solid());
        let mut archive = solid;
        let mut count = 0;
        while let Some(header) = archive.read_header().unwrap() {
            count += 1;
            archive = header.skip().unwrap();
        }
        assert!(count > 0);

        let crypted = unrar::Archive::new(&data.join("crypted.rar")).open_for_processing();
        let failed = match crypted {
            Err(_) => true,
            Ok(a) => match a.read_header() {
                Err(_) => true,
                Ok(None) => false,
                Ok(Some(h)) => h.read().is_err(),
            },
        };
        assert!(failed, "an encrypted archive without password is an error, not a panic");
    }

    /// Solid 7z: a name the library would reject (`..`) is skipped instead of
    /// failing the book, skipped entries are decoded within the budget, and
    /// reading one entry never buffers the ones stored before it.
    #[test]
    fn solid_7z_is_read_within_bounds() {
        use sevenz_rust2::{ArchiveEntry, ArchiveWriter, SourceReader};
        let dir = std::env::temp_dir().join(format!("planche-7z-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("solid.cb7");
        let junk = vec![0u8; 3 * 1024 * 1024];
        {
            let mut w = ArchiveWriter::create(&path).unwrap();
            let entries = vec![ArchiveEntry::new_file("../junk.bin"), ArchiveEntry::new_file("p1.jpg")];
            let data: Vec<SourceReader<&[u8]>> = vec![junk.as_slice().into(), (&b"\xFF\xD8\xFF"[..]).into()];
            w.push_archive_entries(entries, data).unwrap();
            w.finish().unwrap();
        }
        let open = || sevenz_rust2::ArchiveReader::new(File::open(&path).unwrap(), sevenz_rust2::Password::empty()).unwrap();
        assert!(open().archive().is_solid);
        assert_eq!(read_7z_entry(&mut open(), "p1.jpg").unwrap(), b"\xFF\xD8\xFF");
        // The 3 MiB stored before the page exceed a 1 MiB budget: refused, not buffered.
        assert!(read_7z_entry_within(&mut open(), "p1.jpg", 1024 * 1024).is_err());
        let dest = dir.join("out");
        fs::create_dir_all(&dest).unwrap();
        let mut sink = Extractor { dest: &dest, total: 0 };
        extract_7z(&path, &mut sink).unwrap();
        assert_eq!(fs::read(dest.join("p1.jpg")).unwrap(), b"\xFF\xD8\xFF");
        assert!(!dir.join("junk.bin").exists());
        assert_eq!(sink.total, junk.len() as u64 + 3, "skipped entries count");
        let _ = fs::remove_dir_all(&dir);
    }

    /// An EPUB whose OPF or XHTML inflates to gigabytes must not be read whole.
    #[test]
    fn epub_documents_are_read_up_to_the_limit() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("planche-bomb-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bomb.epub");
        {
            let mut w = zip::ZipWriter::new(File::create(&path).unwrap());
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            w.start_file("OEBPS/big.xhtml", opts).unwrap();
            // Highly compressible: tens of MiB stored in a few KiB.
            let chunk = vec![b'a'; 1024 * 1024];
            for _ in 0..(MAX_XML_BYTES / chunk.len() as u64 + 8) {
                w.write_all(&chunk).unwrap();
            }
            w.start_file("page.jpg", opts).unwrap();
            w.write_all(b"\xFF\xD8\xFF").unwrap();
            w.finish().unwrap();
        }
        let mut zip = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let doc = read_entry(&mut zip, "OEBPS/big.xhtml").unwrap();
        assert_eq!(doc.len() as u64, MAX_XML_BYTES);
        // Page reads stay bounded by MAX_ENTRY_BYTES whatever the header says.
        let book = open_zip(&path, false).unwrap();
        assert_eq!(book.pages, vec!["page.jpg".to_string()]);
        assert_eq!(book.page_bytes(0).unwrap(), b"\xFF\xD8\xFF");
        let _ = fs::remove_dir_all(&dir);
    }
}
