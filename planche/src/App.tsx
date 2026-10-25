import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, Book, Library as Lib } from "./api";
import { setLanguage, t } from "./i18n";
import { BOOK_EXTENSIONS, Library, SmartView, sortBooks } from "./Library";
import { Preferences, ShortcutsHelp } from "./Preferences";
import { Reader } from "./Reader";
import { TextReader } from "./TextReader";
import { defaultSettings, loadSettings, saveSettings, Settings } from "./settings";
import { Scope, useShortcuts } from "./shortcuts";
import { queuePdfThumbnail } from "./pdf";
import "./App.css";

type Back = { view: SmartView; shelfId: string | null };
type Start = { page?: number; position?: string | null };
type Route = ({ name: "library" } & Back) | { name: "reader"; bookId: string; start?: Start; siblings: Book[]; back: Back };

const isBookFile = (path: string) => BOOK_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "");

interface ReaderProps {
  bookId: string;
  start?: Start;
  settings: Settings;
  onSettings: (s: Partial<Settings>) => void;
  siblings: Book[];
  onOpenBook: (b: Book) => void;
  onClose: () => void;
  onPreferences: () => void;
  onHelp: (scopes: Scope[]) => void;
}

/** Picks the reader: text EPUBs get the reflowable reader, everything else the page reader. */
function BookView(props: ReaderProps) {
  const [kind, setKind] = useState<{ reflowable: boolean; book: Book } | null>(null);
  useEffect(() => {
    api
      .openBook(props.bookId)
      .then(({ reflowable, book }) => setKind({ reflowable, book }))
      .catch(() => setKind({ reflowable: false, book: null as unknown as Book }));
  }, [props.bookId]);
  if (!kind) return <div className="reader loading-screen">{t("common.loading")}</div>;
  if (kind.reflowable)
    return (
      <TextReader
        book={kind.book}
        startPosition={props.start?.position}
        settings={props.settings}
        onSettings={props.onSettings}
        siblings={props.siblings}
        onOpenBook={props.onOpenBook}
        onClose={props.onClose}
        onPreferences={props.onPreferences}
        onHelp={() => props.onHelp(["global", "reader", "text"])}
      />
    );
  return (
    <Reader
      bookId={props.bookId}
      startPage={props.start?.page}
      settings={props.settings}
      onSettings={props.onSettings}
      siblings={props.siblings}
      onOpenBook={props.onOpenBook}
      onClose={props.onClose}
      onPreferences={props.onPreferences}
      onHelp={() => props.onHelp(["global", "reader", "image"])}
    />
  );
}

export default function App() {
  const [lib, setLib] = useState<Lib>({ roots: [], shelves: [], books: [] });
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [route, setRoute] = useState<Route>({ name: "library", view: "library", shelfId: null });
  const [dropping, setDropping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [help, setHelp] = useState<Scope[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Latest values for event handlers registered once.
  const latest = useRef({ lib, settings, route });
  latest.current = { lib, settings, route };

  setLanguage(settings.language);
  useEffect(() => {
    const root = document.documentElement;
    if (settings.appTheme === "system") delete root.dataset.theme;
    else root.dataset.theme = settings.appTheme;
    root.style.setProperty("--ui-zoom", String(settings.uiScale / 100));
    root.classList.toggle("reduce-motion", settings.reduceMotion);
  }, [settings.appTheme, settings.uiScale, settings.reduceMotion]);

  const refresh = useCallback(() => {
    return api.library().then(setLib).catch(console.error);
  }, []);

  const currentBack = (): Back => {
    const r = latest.current.route;
    return r.name === "reader" ? r.back : { view: r.view, shelfId: r.shelfId };
  };

  /** Neighbouring books (same shelf, current sort) for next/previous book navigation. */
  const shelfSiblings = (b: Book, l: Lib) =>
    sortBooks(
      l.books.filter((x) => x.root_id === b.root_id && x.shelf_id === b.shelf_id),
      latest.current.settings.sort,
    );

  const openBook = (b: Book, siblings: Book[], start?: Start) =>
    setRoute({
      name: "reader",
      bookId: b.id,
      start,
      siblings: siblings.length ? siblings : shelfSiblings(b, latest.current.lib),
      back: currentBack(),
    });

  /** Reads a file from anywhere: library entry if known, standalone otherwise. */
  const openPath = useCallback(async (path: string) => {
    try {
      const id = await api.openFile(path);
      const l = await api.library();
      setLib(l);
      const inLib = l.books.find((b) => b.id === id);
      setRoute({ name: "reader", bookId: id, siblings: inLib ? shelfSiblings(inLib, l) : [], back: currentBack() });
    } catch (e) {
      setNotice(String(e));
    }
  }, []);

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
    refresh();
    api.takeInitialFile().then((p) => {
      if (p) openPath(p);
    });
    const unlisteners = [
      listen("library-changed", refresh),
      listen<string>("open-file", (e) => openPath(e.payload)),
      // Dropped files are read; dropped folders are added to the library.
      getCurrentWebview().onDragDropEvent(async (e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") setDropping(true);
        else setDropping(false);
        if (p.type !== "drop") return;
        const file = p.paths.find(isBookFile);
        if (file) return openPath(file);
        for (const dir of p.paths) {
          try {
            await api.addRoot(dir);
          } catch (err) {
            setNotice(String(err));
          }
        }
        refresh();
      }),
    ];
    return () => {
      unlisteners.forEach((u) => u.then((f) => f()));
    };
  }, [refresh, openPath]);

  // PDF covers are rendered here with pdf.js; other formats are handled by the backend.
  useEffect(() => {
    for (const b of lib.books) if (b.kind === "pdf" && b.thumb === 0) queuePdfThumbnail(b.id, refresh);
  }, [lib.books, refresh]);

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      setSettings((s) => {
        const next = { ...s, ...patch };
        if (loaded) saveSettings(next);
        return next;
      });
    },
    [loaded],
  );

  // Global shortcuts while a modal is open (readers and library register their own).
  useShortcuts(prefsOpen || help ? ["global"] : [], settings.shortcuts, {
    "app.fullscreen": () => {
      const w = getCurrentWindow();
      void w.isFullscreen().then((f) => w.setFullscreen(!f));
    },
  });

  const overlays = (
    <>
      {dropping && (
        <div className="drop-hint" role="status">
          {t("app.dropHint")}
        </div>
      )}
      {notice && (
        <div className="toast" role="alert" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      {prefsOpen && <Preferences settings={settings} onSettings={updateSettings} onClose={() => setPrefsOpen(false)} />}
      {help && <ShortcutsHelp settings={settings} scopes={help} onClose={() => setHelp(null)} />}
    </>
  );

  if (route.name === "reader") {
    return (
      <>
        <BookView
          key={`${route.bookId}:${route.start?.page ?? ""}:${route.start?.position ?? ""}`}
          bookId={route.bookId}
          start={route.start}
          settings={settings}
          onSettings={updateSettings}
          siblings={route.siblings}
          onOpenBook={(b) => setRoute({ ...route, bookId: b.id, start: undefined })}
          onClose={() => {
            refresh();
            setRoute({ name: "library", ...route.back });
          }}
          onPreferences={() => setPrefsOpen(true)}
          onHelp={setHelp}
        />
        {overlays}
      </>
    );
  }

  return (
    <>
      <Library
        lib={lib}
        settings={settings}
        onSettings={updateSettings}
        view={route.view}
        shelfId={route.shelfId}
        onNavigate={(view, shelfId) => setRoute({ name: "library", view, shelfId })}
        onOpenBook={openBook}
        onOpenFile={openPath}
        onOpenBookId={async (id) => {
          const l = await api.library();
          setLib(l);
          const b = l.books.find((x) => x.id === id);
          if (b) openBook(b, shelfSiblings(b, l));
        }}
        onChanged={refresh}
        onPreferences={() => setPrefsOpen(true)}
        onHelp={() => setHelp(["global", "library"])}
      />
      {overlays}
    </>
  );
}
