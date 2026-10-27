import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, Book, Bookmark, bookSubtitle, bookTitle, Library as Lib, Shelf, thumbUrl } from "./api";
import { Annotation, annotationsApi, exportAnnotations } from "./annotations";
import { ltr, t, tn } from "./i18n";
import { Settings, SortMode } from "./settings";
import { useShortcuts } from "./shortcuts";
import { CatalogBrowser, CatalogDialog } from "./Catalogs";
import { Catalog, opdsApi } from "./opds";
import { isAndroid, pickFile, pickFolder } from "./platform";

export type SmartView =
  | "library"
  | "series"
  | "inProgress"
  | "unread"
  | "favorites"
  | "recentlyRead"
  | "recentlyAdded"
  | "bookmarks"
  | "annotations"
  /** An OPDS catalog; shelfId carries the catalog id. */
  | "opds";

export const BOOK_EXTENSIONS = ["cbz", "cbr", "cb7", "cbt", "zip", "rar", "7z", "tar", "pdf", "epub"];

const smartViews: { id: SmartView; icon: string; action: string }[] = [
  { id: "library", icon: "📚", action: "library.viewLibrary" },
  { id: "series", icon: "▤", action: "library.viewSeries" },
  { id: "inProgress", icon: "📖", action: "library.viewInProgress" },
  { id: "unread", icon: "✨", action: "library.viewUnread" },
  { id: "favorites", icon: "★", action: "library.viewFavorites" },
  { id: "recentlyRead", icon: "🕘", action: "library.viewRecentlyRead" },
  { id: "recentlyAdded", icon: "＋", action: "library.viewRecentlyAdded" },
  { id: "bookmarks", icon: "🔖", action: "library.viewBookmarks" },
  { id: "annotations", icon: "✎", action: "library.viewAnnotations" },
];

const SORTS: SortMode[] = ["nameAsc", "nameDesc", "series", "dateAsc", "dateDesc"];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Issue numbers are free text in ComicInfo ("1", "1.5", "HS"): numeric when possible. */
function compareNumbers(a: string | null, b: string | null) {
  const na = parseFloat(a ?? ""),
    nb = parseFloat(b ?? "");
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return collator.compare(a ?? "", b ?? "");
}

/** Series, then volume, then issue number; books without series come after, by title. */
export function compareSeries(a: Book, b: Book) {
  if (a.series && b.series)
    return (
      collator.compare(a.series, b.series) ||
      (a.volume ?? 0) - (b.volume ?? 0) ||
      compareNumbers(a.number, b.number) ||
      collator.compare(a.name, b.name)
    );
  if (a.series || b.series) return a.series ? -1 : 1;
  return collator.compare(bookTitle(a), bookTitle(b));
}

/** Does the book match a lowercase search query (file name, title, series, authors)? */
const matches = (b: Book, q: string) => [b.name, b.title, b.series, b.authors].some((v) => v?.toLowerCase().includes(q));

export function sortBooks(books: Book[], sort: SortMode): Book[] {
  const s = [...books];
  switch (sort) {
    case "nameAsc":
      return s.sort((a, b) => collator.compare(bookTitle(a), bookTitle(b)));
    case "nameDesc":
      return s.sort((a, b) => collator.compare(bookTitle(b), bookTitle(a)));
    case "series":
      return s.sort(compareSeries);
    case "dateAsc":
      return s.sort((a, b) => a.added_at - b.added_at);
    case "dateDesc":
      return s.sort((a, b) => b.added_at - a.added_at);
  }
}

export const inProgress = (b: Book) => !b.finished && b.current_page > 0;

interface Props {
  lib: Lib;
  settings: Settings;
  onSettings: (s: Partial<Settings>) => void;
  shelfId: string | null;
  view: SmartView;
  onNavigate: (view: SmartView, shelfId: string | null) => void;
  onOpenBook: (book: Book, siblings: Book[], start?: { page?: number; position?: string | null }) => void;
  onOpenFile: (path: string) => void;
  onOpenBookId: (id: string) => void;
  onChanged: () => void;
  onPreferences: () => void;
  onHelp: () => void;
}

interface Menu {
  x: number;
  y: number;
  books: Book[];
}

/** Folder name of a library root: last path component, or of an Android
 * document URI (".../document/primary%3AComics%2FManga" → "Manga"). */
const folderLabel = (path: string) => {
  const last = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  if (!path.startsWith("content://")) return last;
  return decodeURIComponent(last).split(/[:/]/).filter(Boolean).pop() ?? last;
};

export function Library(props: Props) {
  const { lib, settings, onSettings, shelfId, view, onNavigate, onOpenBook, onOpenFile, onChanged } = props;
  const [query, setQuery] = useState("");
  const [marks, setMarks] = useState<Bookmark[]>([]);
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [drawer, setDrawer] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [editing, setEditing] = useState<Catalog | "new" | null>(null);
  // Bumped after a catalog is saved so its browser reloads with the new settings.
  const [catalogVersion, setCatalogVersion] = useState(0);
  const reloadCatalogs = () => opdsApi.list().then(setCatalogs).catch(console.error);
  useEffect(() => {
    reloadCatalogs();
  }, []);
  const catalog = view === "opds" ? catalogs.find((c) => c.id === shelfId) : undefined;

  useEffect(() => {
    if (view === "bookmarks") api.bookmarks().then(setMarks).catch(console.error);
    if (view === "annotations") annotationsApi.list().then(setNotes).catch(console.error);
  }, [view, lib]);

  const shelvesById = useMemo(() => new Map(lib.shelves.map((s) => [s.id, s])), [lib.shelves]);
  const booksById = useMemo(() => new Map(lib.books.map((b) => [b.id, b])), [lib.books]);

  // Books contained by each shelf, recursively — for shelf covers and counts.
  const shelfContents = useMemo(() => {
    const m = new Map<string, Book[]>();
    for (const b of lib.books) {
      let sid = b.shelf_id;
      while (sid) {
        if (!m.has(sid)) m.set(sid, []);
        m.get(sid)!.push(b);
        sid = shelvesById.get(sid)?.parent_id ?? null;
      }
    }
    return m;
  }, [lib.books, shelvesById]);

  const breadcrumb = useMemo(() => {
    const path: Shelf[] = [];
    let s = view === "library" && shelfId ? shelvesById.get(shelfId) : undefined;
    while (s) {
      path.unshift(s);
      s = s.parent_id ? shelvesById.get(s.parent_id) : undefined;
    }
    return path;
  }, [shelfId, shelvesById, view]);

  // Series name -> its books in reading order.
  const seriesMap = useMemo(() => {
    const m = new Map<string, Book[]>();
    for (const b of [...lib.books].sort(compareSeries)) {
      if (!b.series) continue;
      if (!m.has(b.series)) m.set(b.series, []);
      m.get(b.series)!.push(b);
    }
    return m;
  }, [lib.books]);

  const { shelves, books, series } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const none = { shelves: [] as Shelf[], series: [] as string[] };
    if (q) {
      return {
        shelves: lib.shelves.filter((s) => s.name.toLowerCase().includes(q)),
        series: [...seriesMap.keys()].filter((s) => s.toLowerCase().includes(q)),
        books: sortBooks(
          lib.books.filter((b) => matches(b, q)),
          settings.sort,
        ),
      };
    }
    if (view === "bookmarks" || view === "annotations" || view === "opds") return { ...none, books: [] as Book[] };
    if (view === "series") {
      // shelfId carries the selected series name in this view.
      if (shelfId) return { ...none, books: seriesMap.get(shelfId) ?? [] };
      return { ...none, series: [...seriesMap.keys()].sort(collator.compare), books: [] as Book[] };
    }
    if (view !== "library") {
      const all = lib.books;
      const pick: Record<Exclude<SmartView, "library" | "bookmarks" | "series" | "annotations" | "opds">, () => Book[]> = {
        inProgress: () => sortBooks(all.filter(inProgress), settings.sort),
        unread: () => sortBooks(all.filter((b) => !b.finished && b.current_page === 0), settings.sort),
        favorites: () => sortBooks(all.filter((b) => b.favorite), settings.sort),
        recentlyRead: () =>
          all.filter((b) => b.last_read).sort((a, b) => (b.last_read ?? 0) - (a.last_read ?? 0)).slice(0, 60),
        recentlyAdded: () => [...all].sort((a, b) => b.added_at - a.added_at).slice(0, 60),
      };
      return { ...none, books: pick[view]() };
    }
    const shelves = lib.shelves
      .filter((s) => s.parent_id === shelfId)
      .sort((a, b) => (settings.sort === "nameDesc" ? collator.compare(b.name, a.name) : collator.compare(a.name, b.name)));
    return { ...none, shelves, books: sortBooks(lib.books.filter((b) => b.shelf_id === shelfId), settings.sort) };
  }, [lib, shelfId, view, query, settings.sort, seriesMap]);

  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  const openFile = async () => {
    const path = isAndroid
      ? (await pickFile())?.path
      : await open({
          title: t("library.openFileTitle"),
          filters: [{ name: t("library.fileFilter"), extensions: BOOK_EXTENSIONS }],
        });
    if (typeof path === "string") onOpenFile(path);
  };

  const addFolder = async () => {
    const path = isAndroid
      ? (await pickFolder())?.path
      : await open({ directory: true, title: t("library.chooseFolder") });
    if (typeof path === "string") await run(t("library.scanning"), () => api.addRoot(path));
  };

  const removeRoot = (id: string, path: string) => {
    if (confirm(t("library.removeFolderConfirm", { path }))) run(t("library.removing"), () => api.removeRoot(id));
  };

  const act = async (f: () => Promise<void>) => {
    closeMenu();
    await f().catch((e) => setError(String(e)));
    onChanged();
  };

  const showMenu = (e: React.MouseEvent, menuBooks: Book[]) => {
    e.preventDefault();
    // Keyboard-opened context menus (Menu key, Shift+F10) report 0,0: anchor on the card.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX || r.left + r.width / 2;
    const y = e.clientY || r.top + r.height / 2;
    menuOpener.current = e.currentTarget as HTMLElement;
    setMenu({ x, y, books: menuBooks });
  };
  const menuOpener = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [menu]);
  const closeMenu = () => {
    setMenu(null);
    menuOpener.current?.focus();
  };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") (e.preventDefault(), closeMenu());
    else if (e.key === "ArrowDown") (e.preventDefault(), items[(i + 1) % items.length]?.focus());
    else if (e.key === "ArrowUp") (e.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus());
    else if (e.key === "Tab") closeMenu();
  };

  const goUp = () => {
    if (query) return setQuery("");
    if (view === "series" && shelfId) return onNavigate("series", null);
    if (view === "library" && shelfId) onNavigate("library", shelvesById.get(shelfId)?.parent_id ?? null);
  };

  useShortcuts(["global", "library"], settings.shortcuts, {
    "app.preferences": props.onPreferences,
    "app.shortcutsHelp": props.onHelp,
    "library.search": () => searchRef.current?.focus(),
    "library.openFile": () => void openFile(),
    "library.addFolder": () => void addFolder(),
    "library.refresh": () => void run(t("library.refreshing"), api.rescan),
    "library.up": goUp,
    ...Object.fromEntries(smartViews.map((v) => [v.action, () => (setQuery(""), onNavigate(v.id, null))])),
  });

  const shelfCards = shelves.map((s) => {
    const contents = shelfContents.get(s.id) ?? [];
    const cover = contents.find((b) => b.thumb === 1);
    return (
      <button key={s.id} className="card shelf" onClick={() => onNavigate("library", s.id)} onContextMenu={(e) => showMenu(e, contents)}>
        <div className="cover stack">
          {cover ? <img src={`${thumbUrl(cover.id)}?v=${cover.thumb}`} alt="" loading="lazy" /> : <span>📁</span>}
        </div>
        <div className="title">{s.name}</div>
        <div className="meta">{tn("library.bookCount", contents.length)}</div>
      </button>
    );
  });

  const seriesCards = series.map((name) => {
    const issues = seriesMap.get(name) ?? [];
    const cover = issues.find((b) => b.thumb === 1);
    const read = issues.filter((b) => b.finished).length;
    return (
      <button
        key={`series:${name}`}
        className="card shelf"
        onClick={() => {
          setQuery("");
          onNavigate("series", name);
        }}
        onContextMenu={(e) => showMenu(e, issues)}
      >
        <div className="cover stack">{cover ? <img src={`${thumbUrl(cover.id)}?v=1`} alt="" loading="lazy" /> : <span>▤</span>}</div>
        <div className="title">{name}</div>
        <div className="meta">
          {tn("library.issueCount", issues.length)}
          {read > 0 ? ` · ${tn("library.readCount", read)}` : ""}
        </div>
      </button>
    );
  });

  const tooltip = (b: Book) =>
    [bookTitle(b), bookSubtitle(b), b.authors, b.year ? String(b.year) : null, b.path].filter(Boolean).join("\n");

  const bookCards = books.map((b) => {
    const progress = b.page_count > 0 ? (b.finished ? 1 : (b.current_page + 1) / b.page_count) : 0;
    const subtitle = bookSubtitle(b) ?? b.authors;
    return (
      <button key={b.id} className="card" onClick={() => onOpenBook(b, books)} onContextMenu={(e) => showMenu(e, [b])} title={tooltip(b)}>
        <div className="cover">
          {b.thumb === 1 ? (
            <img src={`${thumbUrl(b.id)}?v=1`} alt="" loading="lazy" />
          ) : (
            <span className="kind">{b.thumb === 2 ? "⚠" : b.kind.toUpperCase()}</span>
          )}
          {b.favorite && <span className="badge fav">★</span>}
          {b.finished && <span className="badge done">✓</span>}
          {!b.finished && b.current_page === 0 && !b.last_read && <span className="badge new">{t("library.new")}</span>}
          {inProgress(b) && (
            <div className="progress">
              <div style={{ width: `${progress * 100}%` }} />
            </div>
          )}
        </div>
        {b.series ? (
          // Series name may be truncated, never the issue number.
          <div className="title split">
            <span>{b.series}</span>
            {b.number && <span className="num">#{b.number}</span>}
          </div>
        ) : (
          <div className="title">{bookTitle(b)}</div>
        )}
        {subtitle && <div className="subtitle">{subtitle}</div>}
        <div className="meta">
          {b.page_count > 0
            ? b.current_page > 0
              ? ltr(`${b.current_page + 1} / ${b.page_count}`)
              : tn("library.pageCount", b.page_count)
            : " "}
        </div>
      </button>
    );
  });

  const empty = lib.roots.length === 0;
  const viewTitle = t(`view.${view}`);

  const exportAll = async () => {
    const path = await exportAnnotations(notes, t("annotations.allBooks"));
    if (path) setInfo(t("annotations.exported", { path }));
  };

  const listView =
    view === "bookmarks" && !query ? (
      marks.length === 0 ? (
        <div className="empty">
          <p>{t("bookmarks.emptyLibrary")}</p>
        </div>
      ) : (
        <div className="bookmark-list">
          {marks.map((m) => {
            const b = booksById.get(m.book_id);
            return (
              <button key={m.id} className="bookmark-row" onClick={() => b && onOpenBook(b, [], { page: m.page, position: m.position })} disabled={!b}>
                {b?.thumb === 1 ? <img src={`${thumbUrl(m.book_id)}?v=1`} alt="" /> : <span className="thumb" />}
                <span className="bm-name">{m.name}</span>
                <span className="meta">{b ? bookTitle(b) : m.book_name}</span>
                <span className="meta">{t("reader.pageShort", { page: m.page + 1 })}</span>
              </button>
            );
          })}
        </div>
      )
    ) : view === "annotations" && !query ? (
      <div className="bookmark-list">
        <div className="panel-row">
          <button className="primary" disabled={!notes.length} onClick={exportAll}>
            {t("annotations.exportAll")}
          </button>
          <span className="meta">{tn("annotations.count", notes.length)}</span>
        </div>
        {notes.length === 0 && <p className="meta">{t("annotations.emptyLibrary")}</p>}
        {notes.map((a) => {
          const b = booksById.get(a.book_id);
          return (
            <button
              key={a.id}
              className="bookmark-row annotation-row"
              onClick={() => (b ? onOpenBook(b, [], { page: a.page, position: a.position }) : onOpenFile(a.book_path))}
            >
              <span className="dot big" style={{ background: a.color }} />
              <span className="column">
                {a.text && <q>{a.text.length > 200 ? `${a.text.slice(0, 200)}…` : a.text}</q>}
                {a.note && <span className="note-text">{a.note}</span>}
              </span>
              <span className="meta">{b ? bookTitle(b) : a.book_name}</span>
              <span className="meta">{t("reader.pageShort", { page: a.page + 1 })}</span>
            </button>
          );
        })}
      </div>
    ) : null;

  return (
    <div className={`library ${drawer ? "drawer-open" : ""}`} onClick={() => setMenu(null)}>
      <a className="skip-link" href="#main">
        {t("a11y.skipToContent")}
      </a>
      {drawer && <div className="drawer-backdrop" onClick={() => setDrawer(false)} />}
      {/* On narrow screens the sidebar is a drawer, closed by any of its buttons. */}
      <aside className="sidebar" onClick={(e) => (e.target as HTMLElement).closest("button") && setDrawer(false)}>
        <div className="brand">Planche</div>
        <nav aria-label={t("a11y.views")}>
          {smartViews.map((v) => (
            <button
              key={v.id}
              className={view === v.id && !query ? "active" : ""}
              aria-current={view === v.id && !query ? "page" : undefined}
              onClick={() => {
                setQuery("");
                onNavigate(v.id, null);
              }}
            >
              <span className="icon" aria-hidden="true">{v.icon}</span>
              {t(`view.${v.id}`)}
            </button>
          ))}
        </nav>
        <div className="section">{t("opds.catalogs")}</div>
        <div className="roots" role="list">
          {catalogs.map((c) => (
            <div key={c.id} className={`root ${view === "opds" && shelfId === c.id ? "active" : ""}`} role="listitem">
              <button className="ghost root-open" onClick={() => (setQuery(""), onNavigate("opds", c.id))} aria-current={view === "opds" && shelfId === c.id ? "page" : undefined} title={c.url}>
                🌐 {c.name}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  if (confirm(t("opds.removeConfirm", { name: c.name }))) opdsApi.remove(c.id).then(() => (reloadCatalogs(), shelfId === c.id && onNavigate("library", null)));
                }}
                title={t("opds.remove")}
                aria-label={t("opds.removeNamed", { name: c.name })}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="ghost add-catalog" onClick={() => setEditing("new")}>
            + {t("opds.addCatalog")}
          </button>
        </div>
        <div className="section">{t("library.folders")}</div>
        <div className="roots">
          {lib.roots.map((r) => (
            <div key={r.id} className="root" title={folderLabel(r.path)}>
              <span>{folderLabel(r.path)}</span>
              <button className="ghost" onClick={() => removeRoot(r.id, folderLabel(r.path))} title={t("library.removeFolder")} aria-label={t("library.removeFolder")}>
                ✕
              </button>
            </div>
          ))}
        </div>
        <button className="primary" onClick={addFolder} disabled={!!busy}>
          + {t("library.addFolder")}
        </button>
        <button onClick={() => run(t("library.refreshing"), api.rescan)} disabled={!!busy || empty}>
          ⟳ {t("library.refresh")}
        </button>
        <button onClick={openFile} title={t("library.openFileHint")} aria-label={t("library.openFileHint")}>
          📄 {t("library.openFile")}
        </button>
        <button onClick={props.onPreferences}>⚙ {t("prefs.title")}</button>
      </aside>

      <main id="main" tabIndex={-1}>
        <header className="toolbar">
          <button
            className="ghost menu-toggle"
            onClick={(e) => (e.stopPropagation(), setDrawer((d) => !d))}
            aria-expanded={drawer}
            aria-label={t("a11y.views")}
          >
            ☰
          </button>
          <div className="crumbs">
            {query ? (
              <span>{t("library.searchResults")}</span>
            ) : view === "series" ? (
              <>
                <button className="ghost" onClick={() => onNavigate("series", null)}>
                  {t("view.series")}
                </button>
                {shelfId && (
                  <span>
                    <span className="sep">›</span>
                    <span>{shelfId}</span>
                  </span>
                )}
              </>
            ) : view !== "library" ? (
              <span>{viewTitle}</span>
            ) : (
              <>
                <button className="ghost" onClick={() => onNavigate("library", null)}>
                  {t("view.library")}
                </button>
                {breadcrumb.map((s) => (
                  <span key={s.id}>
                    <span className="sep">›</span>
                    <button className="ghost" onClick={() => onNavigate("library", s.id)}>
                      {s.name}
                    </button>
                  </span>
                ))}
              </>
            )}
          </div>
          <input
            ref={searchRef}
            className="search"
            placeholder={t("library.searchPlaceholder")}
            aria-label={t("library.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (setQuery(""), e.currentTarget.blur())}
          />
          <select value={settings.sort} onChange={(e) => onSettings({ sort: e.target.value as SortMode })} aria-label={t("library.sort")}>
            {SORTS.map((k) => (
              <option key={k} value={k}>
                {t(`sort.${k}`)}
              </option>
            ))}
          </select>
        </header>

        {busy && (
          <div className="notice" role="status">
            {busy}
          </div>
        )}
        {error && (
          <div className="notice error" role="alert" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {info && (
          <div className="notice" role="status" onClick={() => setInfo(null)}>
            {info}
          </div>
        )}

        {view === "opds" && catalog ? (
          <CatalogBrowser key={`${catalog.id}:${catalog.url}:${catalogVersion}`} catalog={catalog} onEdit={() => setEditing(catalog)} onOpenBook={props.onOpenBookId} />
        ) : listView ??
          (empty ? (
            <div className="empty">
              <h2>{t("library.emptyTitle")}</h2>
              <p>
                {t("library.emptyText")}
                <br />
                {t("library.formats")}
              </p>
              <button className="primary" onClick={addFolder}>
                + {t("library.addFolder")}
              </button>
            </div>
          ) : shelves.length + series.length + books.length === 0 ? (
            <div className="empty">
              <p>{query ? t("library.noResults") : view === "series" ? t("library.noSeries") : t("library.emptyView")}</p>
            </div>
          ) : (
            <div className="grid">
              {settings.foldersFirst ? [...seriesCards, ...shelfCards, ...bookCards] : [...bookCards, ...seriesCards, ...shelfCards]}
            </div>
          ))}
      </main>

      {editing && (
        <CatalogDialog
          catalog={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            reloadCatalogs();
            setCatalogVersion((v) => v + 1);
            onNavigate("opds", id);
          }}
        />
      )}
      {menu && (
        <div
          ref={menuRef}
          className="menu"
          role="menu"
          aria-label={t("a11y.bookActions")}
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onMenuKey}
        >
          {menu.books.length === 1 && (
            <button role="menuitem" onClick={() => act(() => api.setFavorite(menu.books[0].id, !menu.books[0].favorite))}>
              {menu.books[0].favorite ? t("menu.unfavorite") : t("menu.favorite")}
            </button>
          )}
          <button role="menuitem" onClick={() => act(() => api.setFinished(menu.books.map((b) => b.id), true))}>{t("menu.markRead")}</button>
          <button role="menuitem" onClick={() => act(() => api.setFinished(menu.books.map((b) => b.id), false))}>{t("menu.markUnread")}</button>
          <hr role="separator" />
          <button role="menuitem" onClick={() => act(() => api.setManga(menu.books.map((b) => b.id), true))}>{t("menu.mangaOn")}</button>
          <button role="menuitem" onClick={() => act(() => api.setManga(menu.books.map((b) => b.id), false))}>{t("menu.mangaOff")}</button>
          <button role="menuitem" onClick={() => act(() => api.setManga(menu.books.map((b) => b.id), null))}>{t("menu.mangaDefault")}</button>
        </div>
      )}
    </div>
  );
}
