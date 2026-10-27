// Reader for reflowable (text) EPUBs, rendered by epub.js in a sandboxed
// iframe. Positions are EPUB CFIs; "pages" are epub.js locations (~1000
// characters each) so progress, bookmarks and the library share one scale.
import { useCallback, useEffect, useRef, useState } from "react";
import ePub, { EpubCFI } from "epubjs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, Book, Bookmark, bookTitle, rawUrl } from "./api";
import { Annotation, ANNOTATION_COLORS, annotationsApi } from "./annotations";
import { t } from "./i18n";
import {
  AnnotationsPanel,
  BookmarksPanel,
  findExcerpts,
  markExcerpt,
  GoToPageDialog,
  Modal,
  NoteEditor,
  Panel,
  PrintDialog,
  SearchHit,
  SearchPanel,
  TocItem,
  TocPanel,
  TtsBar,
} from "./Panels";
import { TypographyForm } from "./Preferences";
import { isAndroid } from "./platform";
import { printHtml } from "./print";
import { defaultTypography, Settings, themeColors, Typography } from "./settings";
import { useShortcuts } from "./shortcuts";
import { Segment, sentences, Speaker, TtsState } from "./tts";

interface Props {
  book: Book;
  startPosition?: string | null;
  settings: Settings;
  onSettings: (s: Partial<Settings>) => void;
  siblings: Book[];
  onOpenBook: (b: Book) => void;
  onClose: () => void;
  onPreferences: () => void;
  onHelp: () => void;
}

type PanelKind = "toc" | "bookmarks" | "annotations" | "search" | "settings" | null;

interface Loc {
  start: string;
  end: string;
  href: string;
  page: number;
  atStart: boolean;
  atEnd: boolean;
}

const CHARS_PER_LOCATION = 1024;
const cfi = new EpubCFI();
const BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, figcaption, td, th, pre, div";

/** CSS injected in every chapter for the user's typography and theme. */
function typographyCss(ty: Typography): string {
  const { bg, fg } = themeColors(ty);
  const imp = " !important";
  const rules: string[] = [
    `html, body { background: ${bg}${imp}; color: ${fg}${imp}; }`,
    `body { font-size: ${ty.fontSize}%${imp}; }`,
    `img, svg, video { max-width: 100%${imp}; height: auto; }`,
    `.planche-tts { background: rgba(232, 163, 61, 0.35)${imp}; border-radius: 3px; }`,
    `::selection { background: rgba(232, 163, 61, 0.45); }`,
  ];
  if (ty.theme !== "light" || ty.overridePublisher)
    rules.push(`body * { color: inherit${imp}; background-color: transparent${imp}; border-color: currentColor; }`, `a { text-decoration: underline; }`);
  if (ty.fontFamily) rules.push(`body, body *:not(code):not(pre):not(kbd) { font-family: ${ty.fontFamily}${imp}; }`);
  if (ty.overridePublisher) rules.push(`body * { font-size: inherit${imp}; }`, `h1 { font-size: 1.6em${imp}; } h2 { font-size: 1.35em${imp}; } h3 { font-size: 1.15em${imp}; }`);
  if (ty.lineHeight > 0) rules.push(`body, body * { line-height: ${ty.lineHeight}${imp}; }`);
  if (ty.letterSpacing > 0) rules.push(`body * { letter-spacing: ${ty.letterSpacing}em${imp}; }`);
  if (ty.wordSpacing > 0) rules.push(`body * { word-spacing: ${ty.wordSpacing}em${imp}; }`);
  if (ty.paragraphSpacing >= 0) rules.push(`p { margin-top: 0${imp}; margin-bottom: ${ty.paragraphSpacing}em${imp}; }`);
  if (ty.paragraphIndent >= 0) rules.push(`p { text-indent: ${ty.paragraphIndent}em${imp}; }`);
  if (ty.textAlign !== "publisher") rules.push(`p, li, div, blockquote { text-align: ${ty.textAlign}${imp}; }`);
  if (ty.hyphenate) rules.push(`body { hyphens: auto${imp}; -webkit-hyphens: auto${imp}; }`);
  return rules.join("\n");
}

function applyCss(doc: Document, css: string) {
  let el = doc.getElementById("planche-typography");
  if (!el) {
    el = doc.createElement("style");
    el.id = "planche-typography";
    doc.head.appendChild(el);
  }
  el.textContent = css;
}

export function TextReader({ book, startPosition, settings, onSettings, siblings, onOpenBook, onClose, onPreferences, onHelp }: Props) {
  const viewer = useRef<HTMLDivElement>(null);
  const epub = useRef<any>(null);
  const rendition = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loc, setLoc] = useState<Loc | null>(null);
  const [total, setTotal] = useState(book.page_count);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [panel, setPanel] = useState<PanelKind>(null);
  const [controls, setControls] = useState(false);
  const [marks, setMarks] = useState<Bookmark[]>([]);
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [selection, setSelection] = useState<{ cfi: string; text: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ cfi: string; text: string } | null>(null);
  const [hits, setHits] = useState<(SearchHit & { cfi: string })[]>([]);
  const [hitIndex, setHitIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [lastQuery, setLastQuery] = useState("");
  const [goTo, setGoTo] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [ttsState, setTtsState] = useState<TtsState>("idle");
  const speaker = useRef(new Speaker());
  const ty = settings.typography;
  const tyRef = useRef(ty);
  tyRef.current = ty;
  const searchMark = useRef<string | null>(null);
  const ttsEl = useRef<Element | null>(null);

  const lang = () => epub.current?.packaging?.metadata?.language || settings.language;
  const rtl = () => epub.current?.packaging?.metadata?.direction === "rtl";

  const reloadMarks = useCallback(() => api.bookmarks(book.id).then(setMarks), [book.id]);
  const reloadNotes = useCallback(() => annotationsApi.list(book.id).then(setNotes), [book.id]);

  // Open the book once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetch(rawUrl(book.id)).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        });
        if (cancelled) return;
        const b = ePub(data as any);
        epub.current = b;
        await b.ready;
        const r = b.renderTo(viewer.current!, {
          width: "100%",
          height: "100%",
          flow: tyRef.current.flow === "scrolled" ? "scrolled-doc" : "paginated",
          spread: tyRef.current.columns === "1" ? "none" : "auto",
          minSpreadWidth: tyRef.current.columns === "2" ? 0 : 900,
          allowScriptedContent: false,
        } as any);
        rendition.current = r;
        r.hooks.content.register((contents: any) => {
          applyCss(contents.document, typographyCss(tyRef.current));
          contents.document.documentElement.lang ||= lang();
          const frame = contents.document.defaultView?.frameElement as HTMLIFrameElement | null;
          if (frame) frame.title = bookTitle(book);
          // Keys pressed inside the book iframe drive the same shortcuts.
          contents.document.addEventListener("keydown", (e: KeyboardEvent) => {
            const forwarded = new KeyboardEvent("keydown", {
              key: e.key,
              code: e.code,
              ctrlKey: e.ctrlKey,
              shiftKey: e.shiftKey,
              altKey: e.altKey,
              metaKey: e.metaKey,
              cancelable: true,
            });
            if (!window.dispatchEvent(forwarded)) e.preventDefault();
          });
        });
        r.on("relocated", (l: any) => {
          const page = b.locations.length() ? (b.locations.locationFromCfi(l.start.cfi) as unknown as number) : null;
          setLoc({
            start: l.start.cfi,
            end: l.end.cfi,
            href: l.start.href,
            page: page ?? -1,
            atStart: !!l.atStart,
            atEnd: !!l.atEnd,
          });
        });
        r.on("selected", (range: string, contents: any) => {
          const sel = contents.window.getSelection();
          const text = sel?.toString().trim();
          if (!text) return;
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          const frame = (contents.document.defaultView.frameElement as HTMLElement).getBoundingClientRect();
          setSelection({ cfi: range, text, x: frame.left + rect.left + rect.width / 2, y: frame.top + rect.top });
        });
        r.on("click", (e: MouseEvent) => {
          const doc = (e.target as Node)?.ownerDocument;
          if (doc?.getSelection()?.toString()) return;
          setSelection(null);
          if ((e.target as Element)?.closest?.("a")) return;
          const frame = (doc?.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect();
          const x = (e.clientX + (frame?.left ?? 0)) / window.innerWidth;
          if (tyRef.current.flow === "paginated" && x < 0.2) (rtl() ? r.next() : r.prev());
          else if (tyRef.current.flow === "paginated" && x > 0.8) (rtl() ? r.prev() : r.next());
          else setControls((c) => !c);
        });
        b.loaded.navigation.then((nav: any) => !cancelled && setToc(nav.toc));
        await r.display(startPosition || book.position || undefined);
        if (cancelled) return;
        setReady(true);
        // Locations: cached per book, generated in the background otherwise.
        const key = `planche:locations:${book.id}:${book.size}`;
        let cached: string | null = null;
        try {
          cached = localStorage.getItem(key);
        } catch {}
        if (cached) b.locations.load(cached);
        else {
          await b.locations.generate(CHARS_PER_LOCATION);
          try {
            localStorage.setItem(key, b.locations.save());
          } catch {}
        }
        if (cancelled) return;
        const n = b.locations.length();
        setTotal(n);
        api.setPageCount(book.id, n);
        r.reportLocation();
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    reloadMarks();
    reloadNotes();
    return () => {
      cancelled = true;
      speaker.current.stop();
      rendition.current?.destroy();
      epub.current?.destroy();
    };
  }, [book.id]);

  // Persist the position (debounced).
  useEffect(() => {
    if (!loc || !ready) return;
    const tm = setTimeout(() => api.setProgress(book.id, Math.max(0, loc.page), loc.start), 500);
    return () => clearTimeout(tm);
  }, [loc?.start, loc?.page, ready]);

  // Re-apply typography / layout when settings change.
  useEffect(() => {
    const r = rendition.current;
    if (!r || !ready) return;
    const css = typographyCss(ty);
    for (const c of r.getContents() as any[]) applyCss(c.document, css);
    const at = r.currentLocation()?.start?.cfi;
    r.flow(ty.flow === "scrolled" ? "scrolled-doc" : "paginated");
    r.spread(ty.columns === "1" ? "none" : "auto", ty.columns === "2" ? 0 : 900);
    const tm = setTimeout(() => {
      r.resize();
      if (at) r.display(at);
    }, 60);
    return () => clearTimeout(tm);
  }, [ty, ready]);

  // Draw saved highlights.
  useEffect(() => {
    const r = rendition.current;
    if (!r || !ready) return;
    const drawn = notes.filter((a) => a.position);
    for (const a of drawn)
      r.annotations.highlight(
        a.position,
        { id: a.id },
        () => {
          setPanel("annotations");
        },
        "planche-hl",
        // Multiply keeps light pages readable; on dark themes it would turn muddy.
        { fill: a.color, "fill-opacity": "0.35", "mix-blend-mode": ty.theme === "light" || ty.theme === "sepia" ? "multiply" : "normal" },
      );
    return () => {
      for (const a of drawn) r.annotations.remove(a.position, "highlight");
    };
  }, [notes, ready, ty.theme]);

  const page = loc?.page ?? -1;
  const pageLabel = page >= 0 && total > 0 ? t("text.location", { page: page + 1, total }) : "…";
  const percent = page >= 0 && total > 0 ? Math.round(((page + 1) / total) * 100) : null;
  const chapter = (() => {
    const flat: TocItem[] = [];
    const walk = (items: TocItem[]) => items.forEach((i) => (flat.push(i), i.subitems && walk(i.subitems)));
    walk(toc);
    return flat.find((i) => loc && i.href.split("#")[0].endsWith(loc.href.split("#")[0]))?.label.trim();
  })();

  const display = (target: string) => rendition.current?.display(target);
  const goToLocation = (n: number) => {
    const b = epub.current;
    if (b?.locations.length()) display(b.locations.cfiFromLocation(Math.max(0, Math.min(n, total - 1))));
  };
  const next = () => rendition.current?.next();
  const prev = () => rendition.current?.prev();
  const bookIndex = siblings.findIndex((b) => b.id === book.id);
  const nextBook = bookIndex >= 0 ? siblings[bookIndex + 1] : undefined;
  const prevBook = bookIndex > 0 ? siblings[bookIndex - 1] : undefined;

  const between = (c: string) => !!loc && cfi.compare(c, loc.start) >= 0 && cfi.compare(c, loc.end) <= 0;
  const marked = marks.some((m) => m.position && between(m.position));

  const addBookmark = (name?: string) => {
    if (!loc) return;
    api
      .addBookmark(book.id, Math.max(0, loc.page), name || chapter || pageLabel, loc.start)
      .then(reloadMarks);
  };

  const saveHighlight = async (range: string, text: string, color: string, note = "") => {
    await annotationsApi.save({ book_id: book.id, page: Math.max(0, page), position: range, text, color, note });
    rendition.current?.getContents().forEach((c: any) => c.window.getSelection()?.removeAllRanges());
    setSelection(null);
    reloadNotes();
  };

  // --- Search ---------------------------------------------------------------
  const runSearch = async (q: string) => {
    const b = epub.current;
    if (!b) return;
    setLastQuery(q);
    setSearching(true);
    const found: (SearchHit & { cfi: string })[] = [];
    const items: any[] = [];
    b.spine.each((s: any) => items.push(s));
    for (const item of items) {
      await item.load(b.load.bind(b));
      const results: { cfi: string; excerpt: string }[] = item.find(q);
      item.unload();
      const label = chapterFor(item.href) ?? t("text.section", { n: item.index + 1 });
      for (const r of results) {
        const ex = findExcerpts(r.excerpt, q, 1)[0];
        // Book text is untrusted: excerpts are always escaped (markExcerpt) before display.
        const excerpt = ex?.excerpt ?? markExcerpt(r.excerpt, q);
        found.push({ key: r.cfi, cfi: r.cfi, label, excerpt, onGo: () => showHit(r.cfi) });
        if (found.length >= 500) break;
      }
      if (found.length >= 500) break;
    }
    setHits(found);
    setHitIndex(found.length ? 0 : -1);
    setSearching(false);
    if (found.length) showHit(found[0].cfi);
  };
  const chapterFor = (href: string) => {
    let label: string | undefined;
    const walk = (items: TocItem[]) =>
      items.forEach((i) => {
        if (!label && i.href.split("#")[0].endsWith(href.split("#")[0])) label = i.label.trim();
        if (i.subitems) walk(i.subitems);
      });
    walk(toc);
    return label;
  };
  const showHit = async (c: string) => {
    const r = rendition.current;
    if (!r) return;
    if (searchMark.current) r.annotations.remove(searchMark.current, "highlight");
    await r.display(c);
    r.annotations.highlight(c, {}, () => {}, "planche-search", { fill: "#e8a33d", "fill-opacity": "0.55" });
    searchMark.current = c;
    setHitIndex(hits.findIndex((h) => h.cfi === c));
  };
  const stepHit = (d: number) => {
    if (!hits.length) return setPanel("search");
    const i = (hitIndex + d + hits.length) % hits.length;
    setHitIndex(i);
    showHit(hits[i].cfi);
  };

  // --- Read aloud -----------------------------------------------------------
  const markReading = (el: Element | null) => {
    ttsEl.current?.classList.remove("planche-tts");
    ttsEl.current = el;
    if (el && settings.speech.highlight) el.classList.add("planche-tts");
  };
  const blocksFrom = async (startCfi: string | null): Promise<Segment[]> => {
    const r = rendition.current;
    const contents = (r?.getContents() as any[])?.[0];
    if (!contents) return [];
    const doc: Document = contents.document;
    const blocks = [...doc.body.querySelectorAll(BLOCKS)].filter(
      (el) => !el.querySelector(BLOCKS) && el.textContent?.trim(),
    );
    let first = 0;
    if (startCfi) {
      try {
        const range: Range = await epub.current.getRange(startCfi);
        const i = blocks.findIndex(
          (el) =>
            el.contains(range.startContainer) ||
            !!(range.startContainer.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
        if (i >= 0) first = i;
      } catch {}
    }
    return blocks.slice(first).flatMap((el) => sentences(el.textContent ?? "", lang()).map((text) => ({ text, ref: el })));
  };
  const startReading = async (fromCfi?: string) => {
    const r = rendition.current;
    if (!r) return;
    const segs = await blocksFrom(fromCfi ?? r.currentLocation()?.start?.cfi ?? null);
    let lastEl: Element | null = null;
    speaker.current.start(segs, {
      voice: settings.speech.voice,
      rate: settings.speech.rate,
      pitch: settings.speech.pitch,
      lang: lang(),
      onStateChange: (s) => {
        setTtsState(s);
        if (s === "idle") markReading(null);
      },
      onSegment: (_i, seg) => {
        const el = seg.ref as Element;
        markReading(el);
        if (el !== lastEl) {
          lastEl = el;
          const contents = (r.getContents() as any[])[0];
          // Follow the voice: turn the page when the paragraph is not visible.
          try {
            const c = contents.cfiFromNode(el);
            if (!between(c)) r.display(c);
          } catch {}
        }
      },
      onEnd: async () => {
        const current = epub.current.spine.get(r.currentLocation()?.start?.href);
        const following = current?.next();
        if (!following) return null;
        await r.display(following.href);
        return blocksFrom(null);
      },
    });
  };
  const toggleTts = () => (ttsState === "idle" ? startReading() : speaker.current.toggle());
  const setRate = (rate: number) => {
    onSettings({ speech: { ...settings.speech, rate } });
    speaker.current.update({ rate });
  };

  const toggleFullscreen = async () => {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  };
  const setTy = (patch: Partial<Typography>) => onSettings({ typography: { ...ty, ...patch } });
  const cycle = <T,>(list: T[], v: T) => list[(list.indexOf(v) + 1) % list.length];

  useShortcuts(["global", "reader", "text"], settings.shortcuts, {
    "app.preferences": onPreferences,
    "app.fullscreen": () => void toggleFullscreen(),
    "app.shortcutsHelp": onHelp,
    "reader.close": onClose,
    "reader.toggleControls": () => {
      if (panel || selection || editing) {
        setPanel(null);
        setSelection(null);
        setEditing(null);
      } else setControls((c) => !c);
    },
    "reader.next": () => void next(),
    "reader.previous": () => void prev(),
    "reader.forward": () => void (rtl() ? prev() : next()),
    "reader.backward": () => void (rtl() ? next() : prev()),
    "reader.first": () => void display(epub.current?.spine.first().href),
    "reader.last": () => void display(epub.current?.spine.last().href),
    "reader.nextBook": () => void (nextBook && onOpenBook(nextBook)),
    "reader.previousBook": () => void (prevBook && onOpenBook(prevBook)),
    "reader.goToPage": () => setGoTo(true),
    "reader.bookmarks": () => setPanel((p) => (p === "bookmarks" ? null : "bookmarks")),
    "reader.addBookmark": () => addBookmark(),
    "reader.annotations": () => setPanel((p) => (p === "annotations" ? null : "annotations")),
    "reader.annotate": () => {
      if (selection) setEditing({ cfi: selection.cfi, text: selection.text });
      else setPanel("annotations");
    },
    "reader.search": () => setPanel("search"),
    "reader.searchNext": () => stepHit(1),
    "reader.searchPrevious": () => stepHit(-1),
    "reader.toc": () => setPanel((p) => (p === "toc" ? null : "toc")),
    "reader.print": () => setPrinting(true),
    "reader.night": () => setTy({ theme: ty.theme === "dark" || ty.theme === "black" ? "light" : "dark" }),
    "reader.settings": () => setPanel((p) => (p === "settings" ? null : "settings")),
    "reader.zoomIn": () => setTy({ fontSize: Math.min(300, ty.fontSize + 10) }),
    "reader.zoomOut": () => setTy({ fontSize: Math.max(60, ty.fontSize - 10) }),
    "reader.zoomReset": () => setTy({ fontSize: 100 }),
    "tts.playPause": () => void toggleTts(),
    "tts.stop": () => speaker.current.stop(),
    "tts.next": () => speaker.current.skip(1),
    "tts.previous": () => speaker.current.skip(-1),
    "tts.faster": () => setRate(Math.min(2.5, +(settings.speech.rate + 0.1).toFixed(1))),
    "tts.slower": () => setRate(Math.max(0.5, +(settings.speech.rate - 0.1).toFixed(1))),
    "text.flow": () => setTy({ flow: ty.flow === "paginated" ? "scrolled" : "paginated" }),
    "text.theme": () => setTy({ theme: cycle(["light", "sepia", "dark", "black"] as Typography["theme"][], ty.theme) }),
    "text.columns": () => setTy({ columns: cycle(["auto", "1", "2"] as Typography["columns"][], ty.columns) }),
    "text.align": () => setTy({ textAlign: cycle(["publisher", "left", "justify"] as Typography["textAlign"][], ty.textAlign) }),
    "text.lineHeightUp": () => setTy({ lineHeight: Math.min(2.6, +((ty.lineHeight || 1.3) + 0.1).toFixed(1)) }),
    "text.lineHeightDown": () => setTy({ lineHeight: ty.lineHeight <= 1 ? 0 : +(ty.lineHeight - 0.1).toFixed(1) }),
    "text.marginUp": () => setTy({ margin: Math.min(25, ty.margin + 1) }),
    "text.marginDown": () => setTy({ margin: Math.max(0, ty.margin - 1) }),
    "text.resetTypography": () => onSettings({ typography: { ...defaultTypography, flow: ty.flow } }),
  });

  const printChapter = async () => {
    setPrinting(false);
    const contents = (rendition.current?.getContents() as any[])?.[0];
    if (!contents) return;
    const font = ty.fontFamily || "Georgia, serif";
    await printHtml(
      contents.document.body.innerHTML,
      `.print-text { font-family: ${font}; font-size: 11pt; line-height: ${ty.lineHeight || 1.45}; color: #000; }
       .print-text img { max-width: 100%; page-break-inside: avoid; }
       .print-text p { text-align: ${ty.textAlign === "publisher" ? "justify" : ty.textAlign}; }`,
    );
  };

  const { bg, fg } = themeColors(ty);
  const columns = ty.flow === "scrolled" || ty.columns === "1" ? 1 : ty.columns === "2" || window.innerWidth >= 900 ? 2 : 1;
  const maxWidth = ty.maxLineWidth ? `${ty.maxLineWidth * columns * (ty.fontSize / 100) + 4}em` : "none";

  if (error)
    return (
      <div className="reader" style={{ background: bg, color: fg }}>
        <div className="reader-error">
          <h2>{t("reader.openError")}</h2>
          <p>{error}</p>
          <button className="primary" onClick={onClose}>
            {t("reader.backToLibrary")}
          </button>
        </div>
      </div>
    );

  return (
    <div className="reader text-reader" style={{ background: bg, color: fg }}>
      <div className="text-stage" style={{ padding: `48px ${ty.margin}% 40px` }}>
        <div ref={viewer} className="text-viewer" style={{ maxWidth }} />
      </div>
      {!ready && <div className="loading">{t("common.loading")}</div>}

      {ty.flow === "paginated" && (
        <>
          <button className="page-arrow left" onClick={() => (rtl() ? next() : prev())} aria-label={t("action.reader.backward")}>
            ‹
          </button>
          <button className="page-arrow right" onClick={() => (rtl() ? prev() : next())} aria-label={t("action.reader.forward")}>
            ›
          </button>
        </>
      )}

      {selection && !editing && (
        <div className="selection-pop" style={{ left: selection.x, top: Math.max(8, selection.y - 52) }} onClick={(e) => e.stopPropagation()}>
          {ANNOTATION_COLORS.slice(0, 4).map((c) => (
            <button key={c} className="swatch" style={{ background: c }} title={t("annotations.highlight")} aria-label={t("annotations.highlight")} onClick={() => saveHighlight(selection.cfi, selection.text, c)} />
          ))}
          <button onClick={() => setEditing({ cfi: selection.cfi, text: selection.text })}>✎ {t("annotations.note")}</button>
          <button
            onClick={() => {
              setSelection(null);
              startReading(selection.cfi);
            }}
          >
            🔊 {t("tts.readFromHere")}
          </button>
          <button onClick={() => navigator.clipboard.writeText(selection.text).then(() => setSelection(null))}>{t("common.copy")}</button>
        </div>
      )}

      {editing && (
        <Modal title={t("annotations.newNote")} aria-label={t("annotations.newNote")} onClose={() => setEditing(null)}>
          <NoteEditor
            quote={editing.text}
            onCancel={() => setEditing(null)}
            onSave={(note, color) => {
              saveHighlight(editing.cfi, editing.text, color, note);
              setEditing(null);
            }}
          />
        </Modal>
      )}

      {panel === "toc" && <TocPanel toc={toc} current={loc?.href} onGo={(h) => display(h)} onClose={() => setPanel(null)} />}
      {panel === "bookmarks" && (
        <BookmarksPanel
          marks={marks}
          currentPage={page}
          defaultName={chapter || pageLabel}
          pageLabel={(m) => t("text.locationShort", { page: m.page + 1 })}
          isCurrent={(m) => !!m.position && between(m.position)}
          onGo={(m) => (m.position ? display(m.position) : goToLocation(m.page))}
          onAdd={addBookmark}
          onRename={(id, name) => api.renameBookmark(id, name).then(reloadMarks)}
          onDelete={(id) => api.deleteBookmark(id).then(reloadMarks)}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "annotations" && (
        <AnnotationsPanel
          list={notes}
          bookName={bookTitle(book)}
          addLabel={t("annotations.addFromSelection")}
          onAdd={() => (selection ? setEditing({ cfi: selection.cfi, text: selection.text }) : alert(t("annotations.selectFirst")))}
          pageLabel={(a) => chapterFor(epub.current?.spine.get(a.position ?? "")?.href ?? "") ?? t("text.locationShort", { page: a.page + 1 })}
          isCurrent={(a) => !!a.position && between(a.position)}
          onGo={(a) => a.position && display(a.position)}
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
          initialQuery={lastQuery}
          onSearch={runSearch}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "settings" && (
        <Panel title={t("typo.title")} aria-label={t("typo.title")} onClose={() => setPanel(null)}>
          <TypographyForm value={ty} onChange={(v) => onSettings({ typography: v })} />
        </Panel>
      )}

      {goTo && total > 0 && (
        <GoToPageDialog
          count={total}
          onClose={() => setGoTo(false)}
          onGo={(n) => {
            goToLocation(n);
            setGoTo(false);
          }}
        />
      )}
      {printing && <PrintDialog count={total} current={[]} chapterOnly onPrint={printChapter} onClose={() => setPrinting(false)} />}

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
        <div className="reader-title">
          {bookTitle(book)}
          {chapter && <span className="meta"> — {chapter}</span>}
        </div>
        <button onClick={() => setPanel(panel === "toc" ? null : "toc")} title={t("action.reader.toc")} aria-label={t("action.reader.toc")}>
          ☰
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
        <button className={ttsState !== "idle" ? "on" : ""} aria-pressed={!!(ttsState !== "idle")} onClick={toggleTts} title={t("action.tts.playPause")} aria-label={t("action.tts.playPause")}>
          🔊
        </button>
        <button className={panel === "settings" ? "on" : ""} aria-pressed={!!(panel === "settings")} onClick={() => setPanel(panel === "settings" ? null : "settings")} title={t("action.reader.settings")} aria-label={t("action.reader.settings")}>
          Aa
        </button>
        {!isAndroid && (
          <>
            <button onClick={() => setPrinting(true)} title={t("action.reader.print")} aria-label={t("action.reader.print")}>
              🖶
            </button>
            <button onClick={toggleFullscreen} title={t("action.app.fullscreen")} aria-label={t("action.app.fullscreen")}>
              ⛶
            </button>
          </>
        )}
      </div>

      <div className={`reader-bar bottom ${controls ? "visible" : ""}`}>
        <button disabled={!prevBook} onClick={() => prevBook && onOpenBook(prevBook)} title={t("action.reader.previousBook")} aria-label={t("action.reader.previousBook")}>
          ⏮
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, total - 1)}
          value={Math.max(0, page)}
          disabled={total === 0}
          style={{ direction: rtl() ? "rtl" : "ltr" }}
          onChange={(e) => goToLocation(Number(e.target.value))}
          aria-label={t("reader.progress")}
          aria-valuetext={pageLabel}
        />
        <span className="page-label">{percent !== null ? `${percent} %` : "…"}</span>
        <button disabled={!nextBook} onClick={() => nextBook && onOpenBook(nextBook)} title={t("action.reader.nextBook")} aria-label={t("action.reader.nextBook")}>
          ⏭
        </button>
      </div>

      <div className="sr-only" aria-live="polite">
        {chapter ?? ""} {pageLabel}
      </div>
      {!controls && (
        <div className="page-pill" aria-hidden="true">
          {marked ? "🔖 " : ""}
          {pageLabel}
        </div>
      )}
    </div>
  );
}
