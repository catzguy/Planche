// Reader for page-based books: comic archives, image folders, image EPUBs and PDFs.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, Book, Bookmark, bookTitle, pageUrl } from "./api";
import { Annotation, annotationsApi } from "./annotations";
import { Crop, detectCrop } from "./crop";
import { ltr, t } from "./i18n";
import {
  AnnotationsPanel,
  BookmarksPanel,
  findExcerpts,
  GoToPageDialog,
  Modal,
  NoteEditor,
  PrintDialog,
  SearchHit,
  SearchPanel,
  TtsBar,
} from "./Panels";
import { loadPdf, PdfDoc, renderPdfPage } from "./pdf";
import { printImages } from "./print";
import { DIMMER_STEPS, FIT_MODES, PAGE_MODES, Settings } from "./settings";
import { useShortcuts } from "./shortcuts";
import { sentences, Speaker, TtsState } from "./tts";

interface Props {
  bookId: string;
  /** Page to open at instead of the saved position (bookmarks, annotations). */
  startPage?: number;
  settings: Settings;
  onSettings: (s: Partial<Settings>) => void;
  siblings: Book[];
  onOpenBook: (b: Book) => void;
  onClose: () => void;
  onPreferences: () => void;
  onHelp: () => void;
}

type Dims = Record<number, [number, number]>;
type PanelKind = "bookmarks" | "annotations" | "search" | null;

const DEFAULT_ASPECT = 0.68; // typical comic page, width / height
const PDF_CACHE = 12;

/** Groups page indexes into what is shown at once. Wide pages always stand alone. */
function buildSpreads(count: number, mode: Settings["pageMode"], dims: Dims): number[][] {
  const wide = (i: number) => !!dims[i] && dims[i][0] > dims[i][1];
  if (mode === "single" || mode === "scroll") return Array.from({ length: count }, (_, i) => [i]);
  const out: number[][] = [];
  let i = 0;
  if (mode === "doubleCover" && count > 0) {
    out.push([0]);
    i = 1;
  }
  while (i < count) {
    if (wide(i) || i + 1 >= count || wide(i + 1)) {
      out.push([i]);
      i += 1;
    } else {
      out.push([i, i + 1]);
      i += 2;
    }
  }
  return out;
}

/** A page image, showing only its `crop` area when there is one. */
function PageImage({ src, crop, alt }: { src: string; crop: Crop | null | undefined; alt: string }) {
  const style: React.CSSProperties | undefined = crop
    ? {
        position: "absolute",
        width: `${100 / crop.w}%`,
        height: `${100 / crop.h}%`,
        left: `${(-crop.x / crop.w) * 100}%`,
        top: `${(-crop.y / crop.h) * 100}%`,
      }
    : undefined;
  return <img src={src} crossOrigin="anonymous" style={style} alt={alt} draggable={false} />;
}

/** Page image URLs: direct protocol URLs for archives, rendered blobs for PDFs. */
function usePageSource(bookId: string, isPdf: boolean, onCount: (n: number) => void, onError: (e: string) => void) {
  const doc = useRef<PdfDoc | null>(null);
  const [blobs, setBlobs] = useState<Record<number, string>>({});
  const pending = useRef(new Set<number>());
  const order = useRef<number[]>([]);

  useEffect(() => {
    if (!isPdf) return;
    let cancelled = false;
    loadPdf(bookId)
      .then((d) => {
        if (cancelled) return void d.loadingTask.destroy();
        doc.current = d;
        onCount(d.numPages);
      })
      .catch((e) => onError(t("reader.pdfError", { error: String(e) })));
    return () => {
      cancelled = true;
      doc.current?.loadingTask.destroy();
      doc.current = null;
      setBlobs((b) => {
        Object.values(b).forEach(URL.revokeObjectURL);
        return {};
      });
    };
  }, [bookId, isPdf]);

  const request = useCallback(
    (i: number) => {
      const d = doc.current;
      if (!isPdf || !d || i < 0 || i >= d.numPages || pending.current.has(i)) return;
      pending.current.add(i);
      const width = Math.min(2400, Math.round(window.innerWidth * window.devicePixelRatio));
      renderPdfPage(d, i, width)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          order.current = [i, ...order.current.filter((x) => x !== i)];
          const evicted = order.current.splice(PDF_CACHE);
          setBlobs((b) => {
            const next = { ...b, [i]: url };
            for (const e of evicted) {
              if (next[e]) URL.revokeObjectURL(next[e]);
              delete next[e];
              pending.current.delete(e);
            }
            return next;
          });
        })
        .catch(() => pending.current.delete(i));
    },
    [isPdf],
  );

  const src = (i: number): string | undefined => (isPdf ? blobs[i] : pageUrl(bookId, i));
  return { src, request, doc };
}

/** Text of a PDF page (empty for scanned pages). */
async function pdfPageText(doc: PdfDoc, i: number): Promise<string> {
  const page = await doc.getPage(i + 1);
  const content = await page.getTextContent();
  page.cleanup();
  return content.items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : " ") : "")).join("");
}

export function Reader({ bookId, startPage, settings, onSettings, siblings, onOpenBook, onClose, onPreferences, onHelp }: Props) {
  const [book, setBook] = useState<Book | null>(null);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [rawDims, setDims] = useState<Dims>({});
  const [crops, setCrops] = useState<Record<number, Crop | null>>({});
  const probing = useRef(new Set<string>());
  const [marks, setMarks] = useState<Bookmark[]>([]);
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [panel, setPanel] = useState<PanelKind>(null);
  const [noteFor, setNoteFor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [controls, setControls] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [endPrompt, setEndPrompt] = useState(false);
  const [goTo, setGoTo] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hitIndex, setHitIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [lastQuery, setLastQuery] = useState("");
  const [ttsState, setTtsState] = useState<TtsState>("idle");
  const speaker = useRef(new Speaker());
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  const stage = useRef<HTMLDivElement>(null);
  const scrollItems = useRef<(HTMLDivElement | null)[]>([]);
  const [nearPages, setNearPages] = useState<Set<number>>(new Set());
  const lastWheel = useRef(0);

  const isPdf = book?.kind === "pdf";
  const manga = book?.manga ?? settings.mangaByDefault;
  const mode = settings.pageMode;

  const startAt = (b: Book, n: number) =>
    Math.max(
      0,
      startPage !== undefined
        ? Math.min(startPage, n - 1)
        : b.finished && b.current_page >= n - 1
          ? 0
          : Math.min(b.current_page, n - 1),
    );

  const reloadMarks = useCallback(() => api.bookmarks(bookId).then(setMarks), [bookId]);
  const reloadNotes = useCallback(() => annotationsApi.list(bookId).then(setNotes), [bookId]);

  useEffect(() => {
    api
      .openBook(bookId)
      .then(({ book, page_count }) => {
        setBook(book);
        if (book.kind !== "pdf") {
          setCount(page_count);
          setPage(startAt(book, page_count));
        }
      })
      .catch((e) => {
        setError(String(e));
        // Keep the record (path, kind) so the error screen can offer another app.
        api.getBook(bookId).then((b) => b && setBook(b));
      });
    reloadMarks();
    reloadNotes();
    return () => speaker.current.stop();
  }, [bookId]);

  // Sizes as displayed: cropped when auto-crop is on.
  const dims = useMemo(() => {
    if (!settings.autoCrop) return rawDims;
    const out: Dims = {};
    for (const [k, [w, h]] of Object.entries(rawDims)) {
      const c = crops[Number(k)];
      out[Number(k)] = c ? [w * c.w, h * c.h] : [w, h];
    }
    return out;
  }, [rawDims, crops, settings.autoCrop]);
  const cropOf = (i: number) => (settings.autoCrop ? crops[i] : null);

  const bookRef = useRef<Book | null>(null);
  bookRef.current = book;
  const onPdfCount = useCallback(
    (n: number) => {
      setCount(n);
      api.setPageCount(bookId, n);
      if (bookRef.current) setPage(startAt(bookRef.current, n));
    },
    [bookId],
  );
  const { src, request, doc } = usePageSource(bookId, isPdf, onPdfCount, setError);

  useEffect(() => {
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Persist progress shortly after the page settles.
  useEffect(() => {
    if (!book || count === 0) return;
    const tm = setTimeout(() => api.setProgress(bookId, page), 400);
    return () => clearTimeout(tm);
  }, [page, book, count, bookId]);

  const spreads = useMemo(() => buildSpreads(count, mode, dims), [count, mode, dims]);
  const spreadIndex = Math.max(0, spreads.findIndex((s) => s.includes(page)));
  const spread = spreads[spreadIndex] ?? [];

  // Preload neighbours so their size is known (smart spreads) and they display instantly.
  const window_ = mode === "scroll" ? [...nearPages] : Array.from({ length: 8 }, (_, k) => page - 2 + k);
  useEffect(() => {
    for (const i of window_) {
      if (i < 0 || i >= count) continue;
      request(i);
      const url = src(i);
      const needCrop = settings.autoCrop && !(i in crops);
      if (!url || (rawDims[i] && !needCrop) || probing.current.has(url)) continue;
      probing.current.add(url);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        setDims((d) => (d[i] ? d : { ...d, [i]: [img.naturalWidth, img.naturalHeight] }));
        if (settings.autoCrop) setCrops((c) => (i in c ? c : { ...c, [i]: detectCrop(img) }));
        probing.current.delete(url);
      };
      img.onerror = () => probing.current.delete(url);
      img.src = url;
    }
  });

  const goToPage = useCallback(
    (p: number) => {
      const target = Math.max(0, Math.min(count - 1, p));
      setEndPrompt(false);
      setPage(target);
      if (mode === "scroll") scrollItems.current[target]?.scrollIntoView({ block: "start" });
    },
    [count, mode],
  );

  const bookIndex = siblings.findIndex((b) => b.id === bookId);
  const nextBook = bookIndex >= 0 ? siblings[bookIndex + 1] : undefined;
  const prevBook = bookIndex > 0 ? siblings[bookIndex - 1] : undefined;

  const next = useCallback(() => {
    if (mode === "scroll") return goToPage(page + 1);
    if (spreadIndex < spreads.length - 1) return goToPage(spreads[spreadIndex + 1][0]);
    if (endPrompt && nextBook) return onOpenBook(nextBook);
    setEndPrompt(true);
  }, [mode, page, spreadIndex, spreads, endPrompt, nextBook, goToPage, onOpenBook]);

  const prev = useCallback(() => {
    if (mode === "scroll") return goToPage(page - 1);
    if (spreadIndex > 0) goToPage(spreads[spreadIndex - 1][0]);
  }, [mode, page, spreadIndex, spreads, goToPage]);

  const toggleFullscreen = async () => {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  };

  const toggleManga = () => {
    const value = !manga;
    setBook((b) => (b ? { ...b, manga: value } : b));
    api.setManga([bookId], value);
  };

  const cycle = <T,>(list: T[], current: T) => list[(list.indexOf(current) + 1) % list.length];

  // Reset scroll position on page turn, aligned with the reading direction.
  useLayoutEffect(() => {
    if (mode === "scroll" || !stage.current) return;
    stage.current.scrollTop = 0;
    stage.current.scrollLeft = manga ? stage.current.scrollWidth : 0;
  }, [spreadIndex, mode, manga]);

  // Jump to the saved position when entering continuous scroll.
  useLayoutEffect(() => {
    if (mode === "scroll" && count > 0) scrollItems.current[page]?.scrollIntoView({ block: "start" });
  }, [mode, count]);

  const shownPages = mode === "scroll" ? [page] : spread;

  // --- Search and read-aloud need text: PDFs only ----------------------------
  const noText = !isPdf ? t("reader.noTextInImages") : undefined;

  const runSearch = async (q: string) => {
    const d = doc.current;
    if (!d) return;
    setLastQuery(q);
    setSearching(true);
    const found: SearchHit[] = [];
    for (let i = 0; i < d.numPages && found.length < 500; i++) {
      const text = await pdfPageText(d, i);
      for (const m of findExcerpts(text, q, 20))
        found.push({ key: `${i}:${m.index}`, label: t("reader.pageN", { page: i + 1 }), excerpt: m.excerpt, onGo: () => goToPage(i) });
    }
    setHits(found);
    setHitIndex(found.length ? 0 : -1);
    setSearching(false);
    found[0]?.onGo();
  };
  const stepHit = (delta: number) => {
    if (!hits.length) return setPanel("search");
    const i = (hitIndex + delta + hits.length) % hits.length;
    setHitIndex(i);
    hits[i].onGo();
  };

  const readPdf = async (from: number) => {
    const d = doc.current;
    if (!d) return;
    const segmentsOf = async (p: number) =>
      sentences(await pdfPageText(d, p), settings.language).map((text) => ({ text, ref: p }));
    let p = from;
    let segs = await segmentsOf(p);
    while (!segs.length && p < d.numPages - 1) segs = await segmentsOf(++p);
    if (!segs.length) return alert(t("reader.noTextToRead"));
    speaker.current.start(segs, {
      voice: settings.speech.voice,
      rate: settings.speech.rate,
      pitch: settings.speech.pitch,
      lang: settings.language,
      onStateChange: setTtsState,
      onSegment: (_i, seg) => {
        const pg = seg.ref as number;
        if (!shownPagesRef.current.includes(pg)) goToPage(pg);
      },
      onEnd: async () => {
        while (p < d.numPages - 1) {
          const more = await segmentsOf(++p);
          if (more.length) return more;
        }
        return null;
      },
    });
  };
  const shownPagesRef = useRef(shownPages);
  shownPagesRef.current = shownPages;
  const toggleTts = () => {
    if (!isPdf) return alert(t("reader.noTextInImages"));
    if (ttsState === "idle") readPdf(page);
    else speaker.current.toggle();
  };
  const setRate = (rate: number) => {
    onSettings({ speech: { ...settings.speech, rate } });
    speaker.current.update({ rate });
  };

  // --- Print -----------------------------------------------------------------
  const print = async (pages: number[]) => {
    setPrinting(false);
    const urls: string[] = [];
    for (const p of pages) {
      if (isPdf && doc.current) urls.push(URL.createObjectURL(await renderPdfPage(doc.current, p, 1600)));
      else urls.push(pageUrl(bookId, p));
    }
    await printImages(urls);
    if (isPdf) urls.forEach(URL.revokeObjectURL);
  };

  // --- Bookmarks and notes ---------------------------------------------------
  const addBookmark = (name?: string) => api.addBookmark(bookId, page, name || t("reader.pageN", { page: page + 1 })).then(reloadMarks);
  const marked = marks.some((m) => shownPages.includes(m.page));
  const noted = notes.some((n) => shownPages.includes(n.page));

  useShortcuts(["global", "reader", "image"], settings.shortcuts, {
    "app.preferences": onPreferences,
    "app.fullscreen": () => void toggleFullscreen(),
    "app.shortcutsHelp": onHelp,
    "reader.close": onClose,
    "reader.toggleControls": () => {
      if (panel || noteFor !== null || goTo || printing) {
        setPanel(null);
        setNoteFor(null);
        setGoTo(false);
        setPrinting(false);
      } else setControls((c) => !c);
    },
    "reader.next": () => next(),
    "reader.previous": () => prev(),
    "reader.forward": () => (manga ? prev() : next()),
    "reader.backward": () => (manga ? next() : prev()),
    "reader.first": () => goToPage(0),
    "reader.last": () => goToPage(count - 1),
    "reader.nextBook": () => void (nextBook && onOpenBook(nextBook)),
    "reader.previousBook": () => void (prevBook && onOpenBook(prevBook)),
    "reader.goToPage": () => setGoTo(true),
    "reader.bookmarks": () => setPanel((p) => (p === "bookmarks" ? null : "bookmarks")),
    "reader.addBookmark": () => void addBookmark(),
    "reader.annotations": () => setPanel((p) => (p === "annotations" ? null : "annotations")),
    "reader.annotate": () => setNoteFor(page),
    "reader.search": () => setPanel("search"),
    "reader.searchNext": () => stepHit(1),
    "reader.searchPrevious": () => stepHit(-1),
    "reader.print": () => setPrinting(true),
    "reader.night": () => onSettings({ dimmer: cycle(DIMMER_STEPS, settings.dimmer) }),
    "reader.settings": onPreferences,
    "reader.zoomIn": () => setZoom((z) => Math.min(4, z * 1.2)),
    "reader.zoomOut": () => setZoom((z) => Math.max(0.3, z / 1.2)),
    "reader.zoomReset": () => setZoom(1),
    "tts.playPause": toggleTts,
    "tts.stop": () => speaker.current.stop(),
    "tts.next": () => speaker.current.skip(1),
    "tts.previous": () => speaker.current.skip(-1),
    "tts.faster": () => setRate(Math.min(2.5, +(settings.speech.rate + 0.1).toFixed(1))),
    "tts.slower": () => setRate(Math.max(0.5, +(settings.speech.rate - 0.1).toFixed(1))),
    "image.manga": toggleManga,
    "image.pageMode": () => onSettings({ pageMode: cycle(PAGE_MODES, mode) }),
    "image.fitMode": () => onSettings({ fitMode: cycle(FIT_MODES, settings.fitMode) }),
    "image.autoCrop": () => onSettings({ autoCrop: !settings.autoCrop }),
  });

  // Space scrolls a tall page before turning it (not a remappable action).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " || e.ctrlKey || e.altKey || mode === "scroll" || e.defaultPrevented) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const s = stage.current;
      e.preventDefault();
      if (s && s.scrollTop + s.clientHeight < s.scrollHeight - 2) s.scrollBy({ top: s.clientHeight * 0.85 });
      else e.shiftKey ? prev() : next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) {
      if (mode === "scroll")
        onSettings({ scrollWidth: Math.max(0.2, Math.min(1, settings.scrollWidth * (e.deltaY < 0 ? 1.1 : 0.9))) });
      else setZoom((z) => Math.max(0.3, Math.min(4, z * (e.deltaY < 0 ? 1.1 : 0.9))));
      return;
    }
    const s = stage.current;
    if (mode === "scroll" || !s || s.scrollHeight > s.clientHeight + 1) return;
    const now = Date.now();
    if (now - lastWheel.current < 300) return;
    lastWheel.current = now;
    e.deltaY > 0 ? next() : prev();
  };

  const onStageClick = (e: React.MouseEvent) => {
    const x = e.clientX / window.innerWidth;
    if (mode !== "scroll" && x < 0.3) (manga ? next : prev)();
    else if (mode !== "scroll" && x > 0.7) (manga ? prev : next)();
    else setControls((c) => !c);
  };

  // Continuous scroll: track the page at the top of the viewport and which pages are near.
  useEffect(() => {
    if (mode !== "scroll" || !stage.current) return;
    const io = new IntersectionObserver(
      (entries) =>
        setNearPages((prevSet) => {
          const s = new Set(prevSet);
          for (const en of entries) {
            const i = Number((en.target as HTMLElement).dataset.index);
            en.isIntersecting ? s.add(i) : s.delete(i);
          }
          return s;
        }),
      { root: stage.current, rootMargin: "150% 0px" },
    );
    scrollItems.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [mode, count]);

  const onScroll = () => {
    if (mode !== "scroll" || !stage.current) return;
    const mid = stage.current.scrollTop + stage.current.clientHeight / 3;
    let current = 0;
    for (let i = 0; i < scrollItems.current.length; i++) {
      const el = scrollItems.current[i];
      if (el && el.offsetTop <= mid) current = i;
      else break;
    }
    if (current !== page) setPage(current);
  };

  const aspect = (i: number) => (dims[i] ? dims[i][0] / dims[i][1] : DEFAULT_ASPECT);

  let content: React.ReactNode;
  if (error) {
    content = (
      <div className="reader-error">
        <h2>{t("reader.openError")}</h2>
        <p>{error}</p>
        {book?.kind === "epub" && (
          <p>
            <button className="primary" onClick={() => api.openWithOtherApp(book.path).catch(() => revealItemInDir(book.path))}>
              {t("reader.openWith")}
            </button>
          </p>
        )}
        <button onClick={onClose}>{t("reader.backToLibrary")}</button>
      </div>
    );
  } else if (mode === "scroll") {
    const width = view.w * settings.scrollWidth;
    content = (
      <div className="scroll-column" style={{ width }}>
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            data-index={i}
            ref={(el) => {
              scrollItems.current[i] = el;
            }}
            className="scroll-page"
            style={{ height: width / aspect(i) }}
          >
            {nearPages.has(i) && src(i) && <PageImage src={src(i)!} crop={cropOf(i)} alt={t("reader.pageN", { page: i + 1 })} />}
          </div>
        ))}
      </div>
    );
  } else {
    const aspects = spread.map(aspect);
    const total = aspects.reduce((a, b) => a + b, 0) || DEFAULT_ASPECT;
    const fit = settings.fitMode;
    const height = (fit === "height" ? view.h : fit === "width" ? view.w / total : Math.min(view.h, view.w / total)) * zoom;
    const ordered = manga ? [...spread].reverse() : spread;
    content = (
      <div className="spread">
        {ordered.map((i) => (
          <div key={i} className="page" style={{ height, width: aspect(i) * height }}>
            {src(i) && <PageImage src={src(i)!} crop={cropOf(i)} alt={t("reader.pageN", { page: i + 1 })} />}
          </div>
        ))}
      </div>
    );
  }

  const pageLabel = count === 0 ? "…" : ltr(`${shownPages.map((i) => i + 1).join("–")} / ${count}`);

  return (
    <div className="reader" style={{ background: settings.background }}>
      <div
        ref={stage}
        className={`stage ${mode === "scroll" ? "scrolling" : ""}`}
        onClick={onStageClick}
        onWheel={onWheel}
        onScroll={onScroll}
      >
        {content}
      </div>
      {settings.dimmer > 0 && <div className="dimmer" style={{ opacity: settings.dimmer }} />}

      {endPrompt && (
        <div className="end-prompt">
          <div>{t("reader.endOf", { title: book ? bookTitle(book) : "" })}</div>
          {nextBook ? (
            <button className="primary" onClick={() => onOpenBook(nextBook)}>
              {t("reader.nextBookNamed", { title: bookTitle(nextBook) })}
            </button>
          ) : (
            <div className="meta">{t("reader.lastInList")}</div>
          )}
          <button onClick={onClose}>{t("reader.backToLibrary")}</button>
        </div>
      )}

      {panel === "bookmarks" && (
        <BookmarksPanel
          marks={marks}
          currentPage={page}
          defaultName={t("reader.pageN", { page: page + 1 })}
          pageLabel={(m) => t("reader.pageShort", { page: m.page + 1 })}
          isCurrent={(m) => shownPages.includes(m.page)}
          onGo={(m) => goToPage(m.page)}
          onAdd={(name) => void addBookmark(name)}
          onRename={(id, name) => api.renameBookmark(id, name).then(reloadMarks)}
          onDelete={(id) => api.deleteBookmark(id).then(reloadMarks)}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "annotations" && (
        <AnnotationsPanel
          list={notes}
          bookName={book ? bookTitle(book) : ""}
          addLabel={t("annotations.addPageNote", { page: page + 1 })}
          onAdd={() => setNoteFor(page)}
          pageLabel={(a) => t("reader.pageShort", { page: a.page + 1 })}
          isCurrent={(a) => shownPages.includes(a.page)}
          onGo={(a) => goToPage(a.page)}
          onSave={(a, note, color) => annotationsApi.save({ ...a, note, color }).then(reloadNotes)}
          onDelete={(a) => annotationsApi.remove(a.id).then(reloadNotes)}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "search" && (
        <SearchPanel
          hits={hits}
          running={searching}
          current={hitIndex}
          unavailable={noText}
          initialQuery={lastQuery}
          onSearch={runSearch}
          onClose={() => setPanel(null)}
        />
      )}
      {noteFor !== null && (
        <Modal title={t("annotations.pageNoteTitle", { page: noteFor + 1 })} aria-label={t("annotations.pageNoteTitle", { page: noteFor + 1 })} onClose={() => setNoteFor(null)}>
          <NoteEditor
            onCancel={() => setNoteFor(null)}
            onSave={(note, color) => {
              annotationsApi.save({ book_id: bookId, page: noteFor, note, color }).then(reloadNotes);
              setNoteFor(null);
            }}
          />
        </Modal>
      )}
      {goTo && count > 0 && (
        <GoToPageDialog
          count={count}
          onClose={() => setGoTo(false)}
          onGo={(p) => {
            goToPage(p);
            setGoTo(false);
          }}
        />
      )}
      {printing && count > 0 && <PrintDialog count={count} current={shownPages} onPrint={print} onClose={() => setPrinting(false)} />}

      <TtsBar
        state={ttsState}
        rate={settings.speech.rate}
        onToggle={() => speaker.current.toggle()}
        onStop={() => speaker.current.stop()}
        onSkip={(d) => speaker.current.skip(d)}
        onRate={setRate}
      />

      <div className={`reader-bar top ${controls ? "visible" : ""}`}>
        <button onClick={onClose} title={t("action.reader.close")} aria-label={t("action.reader.close")}>
          ←
        </button>
        <div className="reader-title">{book && bookTitle(book)}</div>
        <select value={mode} onChange={(e) => onSettings({ pageMode: e.target.value as Settings["pageMode"] })} title={t("action.image.pageMode")} aria-label={t("action.image.pageMode")}>
          {PAGE_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`pageMode.${m}`)}
            </option>
          ))}
        </select>
        {mode !== "scroll" && (
          <select value={settings.fitMode} onChange={(e) => onSettings({ fitMode: e.target.value as Settings["fitMode"] })} title={t("action.image.fitMode")} aria-label={t("action.image.fitMode")}>
            {FIT_MODES.map((m) => (
              <option key={m} value={m}>
                {t(`fitMode.${m}`)}
              </option>
            ))}
          </select>
        )}
        <button className={manga ? "on" : ""} aria-pressed={!!(manga)} onClick={toggleManga} title={t("action.image.manga")} aria-label={t("action.image.manga")}>
          漫
        </button>
        <button className={settings.dimmer > 0 ? "on" : ""} aria-pressed={!!(settings.dimmer > 0)} onClick={() => onSettings({ dimmer: cycle(DIMMER_STEPS, settings.dimmer) })} title={t("action.reader.night")} aria-label={t("action.reader.night")}>
          ☾
        </button>
        <button className={settings.autoCrop ? "on" : ""} aria-pressed={!!(settings.autoCrop)} onClick={() => onSettings({ autoCrop: !settings.autoCrop })} title={t("action.image.autoCrop")} aria-label={t("action.image.autoCrop")}>
          ✂
        </button>
        <button onClick={() => setPanel(panel === "search" ? null : "search")} title={t("action.reader.search")} aria-label={t("action.reader.search")}>
          🔍
        </button>
        <button className={panel === "bookmarks" ? "on" : ""} aria-pressed={!!(panel === "bookmarks")} onClick={() => setPanel(panel === "bookmarks" ? null : "bookmarks")} title={t("action.reader.bookmarks")} aria-label={t("action.reader.bookmarks")}>
          🔖
        </button>
        <button className={panel === "annotations" ? "on" : ""} aria-pressed={!!(panel === "annotations")} onClick={() => setPanel(panel === "annotations" ? null : "annotations")} title={t("action.reader.annotations")} aria-label={t("action.reader.annotations")}>
          ✎
        </button>
        <button className={ttsState !== "idle" ? "on" : ""} aria-pressed={!!(ttsState !== "idle")} onClick={toggleTts} disabled={!isPdf} title={isPdf ? t("action.tts.playPause") : t("reader.noTextInImages")} aria-label={t("action.tts.playPause")}>
          🔊
        </button>
        <button onClick={() => setPrinting(true)} title={t("action.reader.print")} aria-label={t("action.reader.print")}>
          🖶
        </button>
        <input type="color" value={settings.background} onChange={(e) => onSettings({ background: e.target.value })} title={t("prefs.background")} aria-label={t("prefs.background")} />
        <button onClick={toggleFullscreen} title={t("action.app.fullscreen")} aria-label={t("action.app.fullscreen")}>
          ⛶
        </button>
      </div>

      <div className={`reader-bar bottom ${controls ? "visible" : ""}`}>
        <button disabled={!prevBook} onClick={() => prevBook && onOpenBook(prevBook)} title={t("action.reader.previousBook")} aria-label={t("action.reader.previousBook")}>
          ⏮
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, count - 1)}
          value={page}
          style={{ direction: manga ? "rtl" : "ltr" }}
          onChange={(e) => goToPage(Number(e.target.value))}
          aria-label={t("reader.progress")}
          aria-valuetext={pageLabel}
        />
        <button className="page-label ghost" onClick={() => setGoTo(true)} title={t("action.reader.goToPage")} aria-label={t("action.reader.goToPage")}>
          {(marked ? "🔖 " : "") + (noted ? "✎ " : "") + pageLabel}
        </button>
        <button disabled={!nextBook} onClick={() => nextBook && onOpenBook(nextBook)} title={t("action.reader.nextBook")} aria-label={t("action.reader.nextBook")}>
          ⏭
        </button>
      </div>

      <div className="sr-only" aria-live="polite">
        {count > 0 ? pageLabel : ""}
      </div>
      {!controls && count > 0 && <div className="page-pill" aria-hidden="true">{(marked ? "🔖 " : "") + (noted ? "✎ " : "") + pageLabel}</div>}
    </div>
  );
}
