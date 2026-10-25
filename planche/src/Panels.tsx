// Side panels and small dialogs shared by the comic/PDF reader and the text reader.
import { useEffect, useRef, useState } from "react";
import { Bookmark } from "./api";
import { Annotation, ANNOTATION_COLORS, exportAnnotations } from "./annotations";
import { t, tn } from "./i18n";
import { parsePageRanges } from "./print";
import { capture, modals } from "./shortcuts";
import { TtsState } from "./tts";

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Moves focus into `ref` on mount (unless something inside already has it)
 * and gives it back to the previously focused element on unmount.
 */
function useFocusReturn(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>("input, textarea, select") ?? el.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? el).focus();
    }
    return () => previous?.focus?.();
  }, []);
}

export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useFocusReturn(ref);
  return (
    <aside ref={ref} className="side-panel" aria-label={title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
      <div className="panel-head">
        <strong>{title}</strong>
        <button className="ghost" onClick={onClose} aria-label={t("common.close")}>
          ✕
        </button>
      </div>
      {children}
    </aside>
  );
}

export function BookmarksPanel(props: {
  marks: Bookmark[];
  currentPage: number;
  pageLabel: (b: Bookmark) => string;
  defaultName: string;
  isCurrent: (b: Bookmark) => boolean;
  onGo: (b: Bookmark) => void;
  onAdd: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const saveRename = () => {
    if (editing?.name.trim()) props.onRename(editing.id, editing.name.trim());
    setEditing(null);
  };
  return (
    <Panel title={t("bookmarks.title")} aria-label={t("bookmarks.title")} onClose={props.onClose}>
      <form
        className="panel-row"
        onSubmit={(e) => {
          e.preventDefault();
          props.onAdd(name.trim() || props.defaultName);
          setName("");
        }}
      >
        <input value={name} placeholder={props.defaultName} onChange={(e) => setName(e.target.value)} />
        <button className="primary" type="submit">
          {t("common.add")}
        </button>
      </form>
      {props.marks.length === 0 && <div className="meta">{t("bookmarks.empty")}</div>}
      <ul className="panel-list">
        {props.marks.map((m) => (
          <li key={m.id} className={props.isCurrent(m) ? "current" : ""}>
            {editing?.id === m.id ? (
              <input
                autoFocus
                value={editing.name}
                onChange={(e) => setEditing({ id: m.id, name: e.target.value })}
                onBlur={saveRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveRename();
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <button
                className="row-main"
                onClick={() => props.onGo(m)}
                onDoubleClick={() => setEditing({ id: m.id, name: m.name })}
                title={t("bookmarks.renameHint")} aria-label={t("bookmarks.renameHint")}
              >
                <span>{m.name}</span>
                <span className="meta">{props.pageLabel(m)}</span>
              </button>
            )}
            <button className="ghost" title={t("common.delete")} aria-label={t("common.delete")} onClick={() => props.onDelete(m.id)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="colors" role="radiogroup" aria-label={t("annotations.color")}>
      {ANNOTATION_COLORS.map((c) => (
        <button
          key={c}
          role="radio"
          aria-checked={c === value}
          className={`swatch ${c === value ? "on" : ""}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

/** Note editor used for new page notes and for editing any annotation. */
export function NoteEditor(props: {
  quote?: string | null;
  initialNote?: string;
  initialColor?: string;
  onSave: (note: string, color: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [note, setNote] = useState(props.initialNote ?? "");
  const [color, setColor] = useState(props.initialColor ?? ANNOTATION_COLORS[0]);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="note-editor" onClick={(e) => e.stopPropagation()}>
      {props.quote && <blockquote style={{ borderColor: color }}>{props.quote}</blockquote>}
      <textarea
        ref={ref}
        value={note}
        placeholder={t("annotations.notePlaceholder")}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) props.onSave(note, color);
          if (e.key === "Escape") props.onCancel();
        }}
      />
      <ColorPicker value={color} onChange={setColor} />
      <div className="panel-row end">
        {props.onDelete && (
          <button className="danger" onClick={props.onDelete}>
            {t("common.delete")}
          </button>
        )}
        <button onClick={props.onCancel}>{t("common.cancel")}</button>
        <button className="primary" onClick={() => props.onSave(note, color)}>
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}

export function AnnotationsPanel(props: {
  list: Annotation[];
  bookName: string;
  pageLabel: (a: Annotation) => string;
  isCurrent: (a: Annotation) => boolean;
  addLabel: string;
  onAdd: () => void;
  onGo: (a: Annotation) => void;
  onSave: (a: Annotation, note: string, color: string) => void;
  onDelete: (a: Annotation) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const shown = filter ? props.list.filter((a) => a.color === filter) : props.list;
  return (
    <Panel title={t("annotations.title")} aria-label={t("annotations.title")} onClose={props.onClose}>
      <div className="panel-row">
        <button className="primary" onClick={props.onAdd}>
          {props.addLabel}
        </button>
        <button
          disabled={props.list.length === 0}
          onClick={async () => setExported(await exportAnnotations(props.list, props.bookName))}
        >
          {t("annotations.export")}
        </button>
      </div>
      {exported && <div className="meta">{t("annotations.exported", { path: exported })}</div>}
      {props.list.length > 0 && (
        <div className="colors small">
          <button className={`chip ${filter === null ? "on" : ""}`} onClick={() => setFilter(null)}>
            {t("common.all")}
          </button>
          {[...new Set(props.list.map((a) => a.color))].map((c) => (
            <button
              key={c}
              className={`swatch ${filter === c ? "on" : ""}`}
              style={{ background: c }}
              onClick={() => setFilter(filter === c ? null : c)}
              aria-label={t("annotations.filterColor")}
            />
          ))}
        </div>
      )}
      {props.list.length === 0 && <div className="meta">{t("annotations.empty")}</div>}
      <ul className="panel-list annotations">
        {shown.map((a) =>
          editing === a.id ? (
            <li key={a.id}>
              <NoteEditor
                quote={a.text}
                initialNote={a.note}
                initialColor={a.color}
                onCancel={() => setEditing(null)}
                onSave={(note, color) => {
                  props.onSave(a, note, color);
                  setEditing(null);
                }}
                onDelete={() => {
                  props.onDelete(a);
                  setEditing(null);
                }}
              />
            </li>
          ) : (
            <li key={a.id} className={props.isCurrent(a) ? "current" : ""}>
              <button className="row-main column" onClick={() => props.onGo(a)} onDoubleClick={() => setEditing(a.id)}>
                <span className="meta">
                  <span className="dot" style={{ background: a.color }} /> {props.pageLabel(a)}
                </span>
                {a.text && <q>{a.text.length > 160 ? `${a.text.slice(0, 160)}…` : a.text}</q>}
                {a.note && <span className="note-text">{a.note}</span>}
              </button>
              <button className="ghost" title={t("common.edit")} aria-label={t("common.edit")} onClick={() => setEditing(a.id)}>
                ✎
              </button>
            </li>
          ),
        )}
      </ul>
    </Panel>
  );
}

export interface SearchHit {
  key: string;
  label: string;
  /** Escaped HTML (see markExcerpt): rendered as markup to show <mark>. */
  excerpt: string;
  onGo: () => void;
}

export function SearchPanel(props: {
  hits: SearchHit[];
  running: boolean;
  unavailable?: string;
  current: number;
  onSearch: (q: string) => void;
  onClose: () => void;
  initialQuery: string;
}) {
  const [q, setQ] = useState(props.initialQuery);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Panel title={t("search.title")} aria-label={t("search.title")} onClose={props.onClose}>
      {props.unavailable ? (
        <div className="meta">{props.unavailable}</div>
      ) : (
        <>
          <form
            className="panel-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) props.onSearch(q.trim());
            }}
          >
            <input ref={ref} value={q} placeholder={t("search.placeholder")} onChange={(e) => setQ(e.target.value)} />
            <button className="primary" type="submit">
              {t("search.submit")}
            </button>
          </form>
          <div className="meta">
            {props.running ? t("search.running") : props.hits.length || q ? tn("search.results", props.hits.length) : ""}
          </div>
          <ul className="panel-list">
            {props.hits.map((h, i) => (
              <li key={h.key} className={i === props.current ? "current" : ""}>
                <button className="row-main column" onClick={h.onGo}>
                  <span className="meta">{h.label}</span>
                  <span dangerouslySetInnerHTML={{ __html: h.excerpt }} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

/** Escapes text and wraps occurrences of `q` in <mark>. */
export function markExcerpt(text: string, q: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let out = "";
  let i = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    out += esc(text.slice(i, at)) + "<mark>" + esc(text.slice(at, at + needle.length)) + "</mark>";
    i = at + needle.length;
  }
  return out + esc(text.slice(i));
}

/** Text around each occurrence of `q` in `text`, for search results. */
export function findExcerpts(text: string, q: string, max = 50): { index: number; excerpt: string }[] {
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out = [];
  for (let at = lower.indexOf(needle); at >= 0 && out.length < max; at = lower.indexOf(needle, at + needle.length)) {
    const from = Math.max(0, at - 50);
    const to = Math.min(text.length, at + needle.length + 70);
    out.push({
      index: at,
      excerpt: (from > 0 ? "…" : "") + markExcerpt(text.slice(from, to), q) + (to < text.length ? "…" : ""),
    });
  }
  return out;
}

export function TtsBar(props: {
  state: TtsState;
  rate: number;
  onToggle: () => void;
  onStop: () => void;
  onSkip: (delta: number) => void;
  onRate: (rate: number) => void;
}) {
  if (props.state === "idle") return null;
  return (
    <div className="tts-bar" onClick={(e) => e.stopPropagation()} role="toolbar" aria-label={t("tts.title")}>
      <button onClick={() => props.onSkip(-1)} title={t("tts.previous")} aria-label={t("tts.previous")}>
        ⏮
      </button>
      <button className="primary" onClick={props.onToggle} title={t(props.state === "playing" ? "tts.pause" : "tts.play")}>
        {props.state === "playing" ? "⏸" : "▶"}
      </button>
      <button onClick={() => props.onSkip(1)} title={t("tts.next")} aria-label={t("tts.next")}>
        ⏭
      </button>
      <button onClick={props.onStop} title={t("tts.stop")} aria-label={t("tts.stop")}>
        ⏹
      </button>
      <label className="meta">
        {t("tts.rate")}
        <input
          type="range"
          min={0.5}
          max={2.5}
          step={0.1}
          value={props.rate}
          onChange={(e) => props.onRate(Number(e.target.value))}
        />
        ×{props.rate.toFixed(1)}
      </label>
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const close = useRef(onClose);
  close.current = onClose;
  const ref = useRef<HTMLDivElement>(null);
  useFocusReturn(ref);
  useEffect(() => {
    modals.open++;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !capture.active) {
        e.preventDefault();
        close.current();
      }
      // Keep Tab inside the dialog.
      if (e.key === "Tab" && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      modals.open--;
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <strong>{title}</strong>
          <button className="ghost" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function GoToPageDialog({ count, onGo, onClose }: { count: number; onGo: (p: number) => void; onClose: () => void }) {
  const [v, setV] = useState("");
  const n = parseInt(v, 10);
  const valid = n >= 1 && n <= count;
  return (
    <Modal title={t("reader.goToPage")} aria-label={t("reader.goToPage")} onClose={onClose}>
      <form
        className="panel-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onGo(n - 1);
        }}
      >
        <input autoFocus type="number" min={1} max={count} value={v} onChange={(e) => setV(e.target.value)} placeholder={`1 – ${count}`} />
        <button className="primary" type="submit" disabled={!valid}>
          {t("common.go")}
        </button>
      </form>
    </Modal>
  );
}

export function PrintDialog(props: {
  count: number;
  current: number[];
  onPrint: (pages: number[]) => void;
  onClose: () => void;
  /** Text books print the current chapter instead of page ranges. */
  chapterOnly?: boolean;
}) {
  const [which, setWhich] = useState<"current" | "all" | "range">("current");
  const [range, setRange] = useState("");
  const pages =
    which === "current"
      ? props.current
      : which === "all"
        ? Array.from({ length: props.count }, (_, i) => i)
        : parsePageRanges(range, props.count);
  return (
    <Modal title={t("print.title")} aria-label={t("print.title")} onClose={props.onClose}>
      {props.chapterOnly ? (
        <p className="meta">{t("print.chapterOnly")}</p>
      ) : (
        <div className="form-grid">
          <label>
            <input type="radio" checked={which === "current"} onChange={() => setWhich("current")} />
            {t("print.current")}
          </label>
          <label>
            <input type="radio" checked={which === "all"} onChange={() => setWhich("all")} />
            {tn("print.all", props.count)}
          </label>
          <label>
            <input type="radio" checked={which === "range"} onChange={() => setWhich("range")} />
            {t("print.range")}
            <input
              value={range}
              placeholder={t("print.rangeExample")}
              onFocus={() => setWhich("range")}
              onChange={(e) => setRange(e.target.value)}
            />
          </label>
          <div className="meta">{tn("print.selected", pages.length)}</div>
        </div>
      )}
      <div className="panel-row end">
        <button onClick={props.onClose}>{t("common.cancel")}</button>
        <button className="primary" disabled={!props.chapterOnly && pages.length === 0} onClick={() => props.onPrint(pages)}>
          {t("print.print")}
        </button>
      </div>
    </Modal>
  );
}

export interface TocItem {
  label: string;
  href: string;
  subitems?: TocItem[];
}

export function TocPanel({ toc, current, onGo, onClose }: { toc: TocItem[]; current?: string; onGo: (href: string) => void; onClose: () => void }) {
  const render = (items: TocItem[], depth: number): React.ReactNode =>
    items.map((it) => (
      <li key={`${it.href}-${it.label}`}>
        <button
          className={`row-main ${current && it.href.split("#")[0] === current ? "current" : ""}`}
          style={{ paddingInlineStart: 8 + depth * 14 }}
          onClick={() => onGo(it.href)}
        >
          {it.label.trim()}
        </button>
        {it.subitems?.length ? <ul className="panel-list">{render(it.subitems, depth + 1)}</ul> : null}
      </li>
    ));
  return (
    <Panel title={t("toc.title")} aria-label={t("toc.title")} onClose={onClose}>
      {toc.length === 0 ? <div className="meta">{t("toc.empty")}</div> : <ul className="panel-list">{render(toc, 0)}</ul>}
    </Panel>
  );
}
