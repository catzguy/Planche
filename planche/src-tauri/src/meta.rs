//! Book metadata: `ComicInfo.xml` (the de-facto comic standard, found at the
//! root of CBZ/CBR/CB7/CBT archives or image folders) and, for EPUBs, the OPF
//! package document (Dublin Core + EPUB 3 collections / Calibre series).

use crate::book;
use anyhow::{anyhow, Result};
use regex::Regex;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

/// Larger files are not metadata; refuse to load them.
const MAX_XML: u64 = 1024 * 1024;

#[derive(Default, Debug)]
pub struct Meta {
    pub title: Option<String>,
    pub series: Option<String>,
    pub number: Option<String>,
    pub volume: Option<i64>,
    pub year: Option<i64>,
    /// Distinct creators, comma separated, in role order.
    pub authors: Option<String>,
}

const COMICINFO: &str = "comicinfo.xml";
/// ComicInfo creator roles, most significant first.
const ROLES: [&str; 6] = ["Writer", "Penciller", "Inker", "Colorist", "Letterer", "CoverArtist"];

fn is_comicinfo(name: &str) -> bool {
    let lower = name.to_ascii_lowercase().replace('\\', "/");
    lower == COMICINFO || lower.ends_with("/comicinfo.xml")
}

pub fn read(path: &Path, kind: &str) -> Result<Meta> {
    let xml = match book::sniff(path, kind).as_str() {
        "epub" => return read_epub(path),
        "pdf" => return Ok(Meta::default()),
        "folder" => fs::read_dir(path)?
            .flatten()
            .find(|e| is_comicinfo(&e.file_name().to_string_lossy()))
            .map(|e| fs::read_to_string(e.path()))
            .transpose()?,
        "zip" => {
            let mut zip = zip::ZipArchive::new(File::open(path)?)?;
            let name = shallowest(zip.file_names().filter_map(|n| n.ok().map(|n| n.into_owned())));
            match name {
                Some(n) => Some(read_limited(zip.by_name(&n)?)?),
                None => None,
            }
        }
        "rar" => {
            let mut archive = unrar::Archive::new(path).open_for_processing().map_err(|e| anyhow!("rar: {e}"))?;
            let mut found = None;
            while let Some(header) = archive.read_header().map_err(|e| anyhow!("rar: {e}"))? {
                if header.entry().is_file()
                    && header.entry().unpacked_size <= MAX_XML
                    && is_comicinfo(&header.entry().filename.to_string_lossy())
                {
                    let (bytes, _) = header.read().map_err(|e| anyhow!("rar: {e}"))?;
                    found = Some(String::from_utf8_lossy(&bytes).into_owned());
                    break;
                }
                archive = header.skip().map_err(|e| anyhow!("rar: {e}"))?;
            }
            found
        }
        "7z" => {
            let mut reader = sevenz_rust2::ArchiveReader::open(path, sevenz_rust2::Password::empty())
                .map_err(|e| anyhow!("7z: {e}"))?;
            let name = shallowest(
                reader.archive().files.iter().filter(|f| !f.is_directory() && f.size() <= MAX_XML).map(|f| f.name().to_owned()),
            );
            match name {
                Some(n) => Some(String::from_utf8_lossy(&reader.read_file(&n).map_err(|e| anyhow!("7z: {e}"))?).into_owned()),
                None => None,
            }
        }
        "tar" => {
            let mut found = None;
            for entry in tar::Archive::new(File::open(path)?).entries()? {
                let entry = entry?;
                if entry.size() <= MAX_XML && is_comicinfo(&entry.path()?.to_string_lossy()) {
                    found = Some(read_limited(entry)?);
                    break;
                }
            }
            found
        }
        _ => None,
    };
    Ok(xml.map(|x| parse_comicinfo(&x)).unwrap_or_default())
}

/// The ComicInfo.xml closest to the archive root.
fn shallowest(names: impl Iterator<Item = String>) -> Option<String> {
    names.filter(|n| is_comicinfo(n)).min_by_key(|n| n.matches('/').count())
}

fn read_limited(r: impl Read) -> Result<String> {
    let mut buf = Vec::new();
    r.take(MAX_XML).read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn decode_entities(s: &str) -> String {
    let re = Regex::new(r"&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);").unwrap();
    re.replace_all(s, |c: &regex::Captures| match &c[1] {
        "amp" => "&".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        "quot" => "\"".into(),
        "apos" => "'".into(),
        n => {
            let code = if let Some(hex) = n.strip_prefix("#x") {
                u32::from_str_radix(hex, 16).ok()
            } else {
                n[1..].parse().ok()
            };
            code.and_then(char::from_u32).map(String::from).unwrap_or_default()
        }
    })
    .into_owned()
}

/// Text of every `<tag>` element (namespace prefixes allowed), cleaned up.
fn elements(xml: &str, tag: &str) -> Vec<String> {
    let re = Regex::new(&format!(r"(?is)<(?:\w+:)?{tag}\b[^>]*>(.*?)</(?:\w+:)?{tag}>")).unwrap();
    re.captures_iter(xml)
        .map(|c| {
            let text = c[1].trim();
            let text = text.strip_prefix("<![CDATA[").and_then(|t| t.strip_suffix("]]>")).unwrap_or(text);
            decode_entities(text).split_whitespace().collect::<Vec<_>>().join(" ")
        })
        .filter(|s| !s.is_empty())
        .collect()
}

fn first(xml: &str, tag: &str) -> Option<String> {
    elements(xml, tag).into_iter().next()
}

fn join_authors(names: impl IntoIterator<Item = String>) -> Option<String> {
    let mut seen: Vec<String> = Vec::new();
    for name in names {
        for part in name.split([',', ';']).map(str::trim).filter(|p| !p.is_empty()) {
            if !seen.iter().any(|s| s.eq_ignore_ascii_case(part)) {
                seen.push(part.to_owned());
            }
        }
    }
    (!seen.is_empty()).then(|| seen.join(", "))
}

pub fn parse_comicinfo(xml: &str) -> Meta {
    Meta {
        title: first(xml, "Title"),
        series: first(xml, "Series"),
        number: first(xml, "Number"),
        volume: first(xml, "Volume").and_then(|v| v.parse().ok()),
        year: first(xml, "Year").and_then(|v| v.parse().ok()).filter(|y: &i64| *y > 0),
        authors: join_authors(ROLES.iter().flat_map(|r| elements(xml, r))),
    }
}

/// Dublin Core title/creators/date, plus the series from either an EPUB 3
/// `belongs-to-collection` or Calibre's `calibre:series` meta.
fn read_epub(path: &Path) -> Result<Meta> {
    let mut zip = zip::ZipArchive::new(File::open(path)?)?;
    let container = read_limited(zip.by_name("META-INF/container.xml")?)?;
    let opf_path = Regex::new(r#"full-path\s*=\s*"([^"]+)""#)?
        .captures(&container)
        .map(|c| c[1].to_string())
        .ok_or_else(|| anyhow!("no OPF"))?;
    let opf = read_limited(zip.by_name(&opf_path)?)?;
    Ok(parse_opf(&opf))
}

/// Cover image of an EPUB (EPUB 3 `cover-image` item or EPUB 2
/// `<meta name="cover">`), used as thumbnail for text EPUBs.
pub fn epub_cover(path: &Path) -> Result<Vec<u8>> {
    let mut zip = zip::ZipArchive::new(File::open(path)?)?;
    let container = read_limited(zip.by_name("META-INF/container.xml")?)?;
    let opf_path = Regex::new(r#"full-path\s*=\s*"([^"]+)""#)?
        .captures(&container)
        .map(|c| c[1].to_string())
        .ok_or_else(|| anyhow!("no OPF"))?;
    let opf = read_limited(zip.by_name(&opf_path)?)?;
    let attr = |tag: &str, a: &str| {
        Regex::new(&format!(r#"\b{a}\s*=\s*"([^"]*)""#)).unwrap().captures(tag).map(|c| decode_entities(&c[1]))
    };
    let items: Vec<String> = Regex::new(r"(?is)<(?:\w+:)?item\b[^>]*>")?.find_iter(&opf).map(|m| m.as_str().to_owned()).collect();
    let cover_id = meta_content(&opf, "cover");
    let href = items
        .iter()
        .find(|i| attr(i, "properties").is_some_and(|p| p.split_whitespace().any(|p| p == "cover-image")))
        .or_else(|| items.iter().find(|i| cover_id.is_some() && attr(i, "id") == cover_id))
        .and_then(|i| attr(i, "href"))
        .ok_or_else(|| anyhow!("no cover"))?;
    let dir = opf_path.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
    let mut buf = Vec::new();
    zip.by_name(&format!("{dir}{href}"))?.take(32 * 1024 * 1024).read_to_end(&mut buf)?;
    Ok(buf)
}

fn meta_content(opf: &str, name: &str) -> Option<String> {
    // <meta name="calibre:series" content="..."/>, attributes in any order.
    let re = Regex::new(r"(?is)<(?:\w+:)?meta\b[^>]*>").unwrap();
    let attr = |tag: &str, a: &str| {
        Regex::new(&format!(r#"\b{a}\s*=\s*"([^"]*)""#)).unwrap().captures(tag).map(|c| decode_entities(&c[1]))
    };
    re.find_iter(opf)
        .find(|m| attr(m.as_str(), "name").as_deref() == Some(name))
        .and_then(|m| attr(m.as_str(), "content"))
        .filter(|s| !s.trim().is_empty())
}

pub fn parse_opf(opf: &str) -> Meta {
    // EPUB 3: <meta property="belongs-to-collection" id="c1">Series</meta>
    //         <meta refines="#c1" property="group-position">3</meta>
    let collection = Regex::new(r#"(?is)<(?:\w+:)?meta\b([^>]*property\s*=\s*"belongs-to-collection"[^>]*)>(.*?)</"#)
        .unwrap()
        .captures(opf)
        .map(|c| {
            let id = Regex::new(r#"\bid\s*=\s*"([^"]+)""#).unwrap().captures(&c[1]).map(|i| i[1].to_string());
            (decode_entities(c[2].trim()), id)
        });
    let (series, number) = match collection {
        Some((name, id)) => {
            let position = id.and_then(|id| {
                Regex::new(&format!(
                    r##"(?is)<(?:\w+:)?meta\b[^>]*refines\s*=\s*"#{}"[^>]*property\s*=\s*"group-position"[^>]*>(.*?)</"##,
                    regex::escape(&id)
                ))
                .unwrap()
                .captures(opf)
                .map(|c| c[1].trim().to_string())
            });
            (Some(name), position)
        }
        None => (meta_content(opf, "calibre:series"), meta_content(opf, "calibre:series_index")),
    };
    // Calibre writes "3.0" for whole numbers.
    let number = number.map(|n| n.strip_suffix(".0").map(str::to_owned).unwrap_or(n));
    Meta {
        title: first(opf, "title"),
        series: series.filter(|s| !s.is_empty()),
        number,
        volume: None,
        year: first(opf, "date").and_then(|d| d.get(..4)?.parse().ok()),
        authors: join_authors(elements(opf, "creator")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comicinfo_fields() {
        let m = parse_comicinfo(
            "<?xml version=\"1.0\"?><ComicInfo><Title>L&apos;île noire</Title><Series>Tintin</Series>\
             <Number>7</Number><Volume>1938</Volume><Year>1938</Year>\
             <Writer>Hergé</Writer><Penciller>Hergé, Bob De Moor</Penciller><Colorist></Colorist></ComicInfo>",
        );
        assert_eq!(m.title.as_deref(), Some("L'île noire"));
        assert_eq!(m.series.as_deref(), Some("Tintin"));
        assert_eq!(m.number.as_deref(), Some("7"));
        assert_eq!(m.volume, Some(1938));
        assert_eq!(m.year, Some(1938));
        assert_eq!(m.authors.as_deref(), Some("Hergé, Bob De Moor"));
    }

    #[test]
    fn opf_epub3_collection_and_calibre() {
        let e3 = parse_opf(
            r##"<package><metadata><dc:title>Vol 2</dc:title><dc:creator>A. Author</dc:creator>
               <dc:date>2021-05-01</dc:date>
               <meta property="belongs-to-collection" id="c01">Saga</meta>
               <meta refines="#c01" property="group-position">2</meta></metadata></package>"##,
        );
        assert_eq!((e3.series.as_deref(), e3.number.as_deref(), e3.year), (Some("Saga"), Some("2"), Some(2021)));
        let cal = parse_opf(
            r#"<metadata><dc:title>T</dc:title><meta content="3.0" name="calibre:series_index"/>
               <meta name="calibre:series" content="One &amp; Two"/></metadata>"#,
        );
        assert_eq!((cal.series.as_deref(), cal.number.as_deref()), (Some("One & Two"), Some("3")));
    }
}
