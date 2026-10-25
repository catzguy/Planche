// OPDS feeds: OPDS 1.x (Atom XML: Komga, Kavita, Calibre-web, most servers)
// and OPDS 2 (JSON). The backend fetches with the catalog's credentials; this
// module turns either format into one model for the UI.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export interface Catalog {
  id: string;
  name: string;
  url: string;
  username: string | null;
  has_password: boolean;
}

export interface Acquisition {
  href: string;
  type: string;
  /** open-access, borrow, buy… (last segment of the OPDS rel). */
  kind: string;
}

export interface Entry {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  cover: string | null;
  /** Sub-feed to open (navigation entries). */
  navHref: string | null;
  acquisitions: Acquisition[];
  series: string | null;
}

export interface Feed {
  url: string;
  title: string;
  entries: Entry[];
  next: string | null;
  previous: string | null;
  /** URL template with {searchTerms}, or an OpenSearch description to resolve first. */
  search: { template: string } | { description: string } | null;
}

export const opdsApi = {
  list: () => invoke<Catalog[]>("opds_list"),
  save: (c: { id: string; name: string; url: string; username: string | null; password: string | null }) =>
    invoke<string>("opds_save", c),
  remove: (id: string) => invoke<void>("opds_remove", { id }),
  fetch: (catalogId: string, url: string) =>
    invoke<{ url: string; content_type: string; body: string }>("opds_fetch", { catalogId, url }),
  download: (catalogId: string, url: string, title: string) => invoke<string>("opds_download", { catalogId, url, title }),
};

/** Covers go through the backend so that protected catalogs work. */
export const coverUrl = (catalogId: string, url: string) =>
  `${convertFileSrc("", "planche")}opds-img/${catalogId}?u=${encodeURIComponent(url)}`;

/** Formats Planche can read, best first. */
const READABLE: [RegExp, string][] = [
  [/comicbook\+zip|x-cbz/, "CBZ"],
  [/comicbook-rar|x-cbr|vnd\.rar|x-rar/, "CBR"],
  [/x-cb7|7z/, "CB7"],
  [/epub\+zip/, "EPUB"],
  [/application\/pdf/, "PDF"],
  [/application\/zip/, "ZIP"],
  [/x-cbt|x-tar/, "CBT"],
];

export function formatLabel(type: string): string | null {
  return READABLE.find(([re]) => re.test(type))?.[1] ?? null;
}

/** The acquisition link to use: open/direct ones first, readable formats in preference order. */
export function bestAcquisition(e: Entry): Acquisition | null {
  const rank = (a: Acquisition) => {
    const i = READABLE.findIndex(([re]) => re.test(a.type));
    return (i < 0 ? 100 : i) + (a.kind === "acquisition" || a.kind === "open-access" ? 0 : 50);
  };
  return [...e.acquisitions].filter((a) => formatLabel(a.type)).sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

const abs = (href: string | null | undefined, base: string) => {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
};

const isAcquisition = (rel: string) => rel.startsWith("http://opds-spec.org/acquisition");
const isImage = (rel: string) => rel.startsWith("http://opds-spec.org/image") || rel === "http://opds-spec.org/thumbnail";

// ---------------------------------------------------------------- OPDS 1 (Atom)

function text(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function parseAtom(xml: string, base: string): Feed {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("invalid feed");
  const feed = doc.documentElement;
  const links = [...feed.children].filter((c) => c.localName === "link");
  const feedLink = (rel: string) => abs(links.find((l) => l.getAttribute("rel") === rel)?.getAttribute("href"), base);
  const searchLink = links.find((l) => l.getAttribute("rel") === "search");
  let search: Feed["search"] = null;
  if (searchLink) {
    const href = abs(searchLink.getAttribute("href"), base)!;
    const type = searchLink.getAttribute("type") ?? "";
    search = type.includes("opensearchdescription") ? { description: href } : { template: decodeURI(href) };
  }
  const entries: Entry[] = [...feed.children]
    .filter((c) => c.localName === "entry")
    .map((e, i) => {
      const elinks = [...e.children].filter((c) => c.localName === "link");
      const child = (name: string) => [...e.children].find((c) => c.localName === name);
      const covers = elinks.filter((l) => isImage(l.getAttribute("rel") ?? ""));
      const thumb =
        covers.find((l) => (l.getAttribute("rel") ?? "").includes("thumbnail")) ?? covers[0];
      const acquisitions = elinks
        .filter((l) => isAcquisition(l.getAttribute("rel") ?? ""))
        .map((l) => ({
          href: abs(l.getAttribute("href"), base)!,
          type: l.getAttribute("type") ?? "",
          kind: (l.getAttribute("rel") ?? "").split("/").pop() ?? "acquisition",
        }));
      const nav = elinks.find((l) => {
        const rel = l.getAttribute("rel") ?? "";
        const type = l.getAttribute("type") ?? "";
        return type.includes("atom+xml") && !isAcquisition(rel) && !isImage(rel) && rel !== "alternate";
      });
      return {
        id: text(child("id")) || String(i),
        title: text(child("title")),
        authors: [...e.children].filter((c) => c.localName === "author").map((a) => text([...a.children].find((c) => c.localName === "name"))),
        summary: text(child("summary")) || text(child("content")),
        cover: abs(thumb?.getAttribute("href"), base),
        navHref: acquisitions.length ? null : abs(nav?.getAttribute("href"), base),
        acquisitions,
        series: null,
      };
    });
  return {
    url: base,
    title: text([...feed.children].find((c) => c.localName === "title")),
    entries,
    next: feedLink("next"),
    previous: feedLink("previous") ?? feedLink("prev"),
    search,
  };
}

// ---------------------------------------------------------------- OPDS 2 (JSON)

interface Link2 {
  href: string;
  rel?: string | string[];
  type?: string;
  title?: string;
  templated?: boolean;
}
const rels = (l: Link2) => (Array.isArray(l.rel) ? l.rel : l.rel ? [l.rel] : []);
const names = (v: unknown): string[] =>
  !v ? [] : Array.isArray(v) ? v.flatMap(names) : typeof v === "string" ? [v] : (v as { name?: string }).name ? [(v as { name: string }).name] : [];

function parseJson(body: string, base: string): Feed {
  const f = JSON.parse(body);
  const links: Link2[] = f.links ?? [];
  const link = (rel: string) => abs(links.find((l) => rels(l).includes(rel))?.href, base);
  const searchLink = links.find((l) => rels(l).includes("search"));
  const pub = (p: any, i: number): Entry => {
    const plinks: Link2[] = p.links ?? [];
    const images: Link2[] = p.images ?? [];
    return {
      id: p.metadata?.identifier ?? String(i),
      title: p.metadata?.title ?? "",
      authors: names(p.metadata?.author),
      summary: p.metadata?.description ?? "",
      cover: abs(images[0]?.href, base),
      navHref: null,
      acquisitions: plinks
        .filter((l) => rels(l).some(isAcquisition))
        .map((l) => ({ href: abs(l.href, base)!, type: l.type ?? "", kind: rels(l).find(isAcquisition)!.split("/").pop()! })),
      series: names(p.metadata?.belongsTo?.series)[0] ?? null,
    };
  };
  const navEntry = (n: Link2, i: number): Entry => ({
    id: `nav-${i}-${n.href}`,
    title: n.title ?? n.href,
    authors: [],
    summary: "",
    cover: null,
    navHref: abs(n.href, base),
    acquisitions: [],
    series: null,
  });
  const entries: Entry[] = [
    ...(f.navigation ?? []).map(navEntry),
    ...(f.publications ?? []).map(pub),
    // Groups: show their navigation and publications in order, plus a link to the full group.
    ...(f.groups ?? []).flatMap((g: any, gi: number) => [
      ...((g.links ?? []) as Link2[]).filter((l) => rels(l).includes("self")).map((l) => navEntry({ ...l, title: g.metadata?.title }, 1000 + gi)),
      ...(g.navigation ?? []).map((n: Link2, i: number) => navEntry(n, gi * 100 + i)),
      ...(g.publications ?? []).map(pub),
    ]),
  ];
  return {
    url: base,
    title: f.metadata?.title ?? "",
    entries,
    next: link("next"),
    previous: link("previous") ?? link("prev"),
    search: searchLink ? { template: abs(searchLink.href, base)!.replace(/%7B/gi, "{").replace(/%7D/gi, "}") } : null,
  };
}

export async function loadFeed(catalogId: string, url: string): Promise<Feed> {
  const r = await opdsApi.fetch(catalogId, url);
  const json = r.content_type.includes("json") || r.body.trimStart().startsWith("{");
  return json ? parseJson(r.body, r.url) : parseAtom(r.body, r.url);
}

/** Search URL for `terms`, resolving an OpenSearch description when needed. */
export async function searchUrl(catalogId: string, search: NonNullable<Feed["search"]>, terms: string): Promise<string> {
  let template: string;
  if ("template" in search) template = search.template;
  else {
    const r = await opdsApi.fetch(catalogId, search.description);
    const doc = new DOMParser().parseFromString(r.body, "application/xml");
    const urls = [...doc.getElementsByTagName("Url")];
    const u = urls.find((x) => (x.getAttribute("type") ?? "").includes("atom")) ?? urls[0];
    if (!u) throw new Error("no search template");
    template = abs(u.getAttribute("template"), r.url)!.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
  }
  const q = encodeURIComponent(terms);
  return template
    .replace(/\{\?query\}/, (template.replace("{?query}", "").includes("?") ? "&" : "?") + `query=${q}`)
    .replace(/\{(searchTerms|query)\??\}/g, q)
    .replace(/\{[^}]+\?\}/g, "");
}
