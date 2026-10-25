// Browsing OPDS catalogs: navigation feeds, publications, search, pagination
// and downloads into the library.
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { t, tn } from "./i18n";
import { bestAcquisition, Catalog, coverUrl, Entry, Feed, formatLabel, loadFeed, opdsApi, searchUrl } from "./opds";
import { Modal } from "./Panels";

/** Add/edit form. Passwords go to the OS credential store, never to the database. */
export function CatalogDialog({ catalog, onClose, onSaved }: { catalog: Catalog | null; onClose: () => void; onSaved: (id: string) => void }) {
  const [name, setName] = useState(catalog?.name ?? "");
  const [url, setUrl] = useState(catalog?.url ?? "");
  const [username, setUsername] = useState(catalog?.username ?? "");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // A new catalog is stored on its first test (the backend needs it to fetch);
  // later attempts update that record, and cancelling removes it.
  const savedId = useRef<string | null>(null);
  const cancel = () => {
    if (!catalog && savedId.current) opdsApi.remove(savedId.current);
    onClose();
  };

  // Basic auth over plain HTTP to another machine exposes the password on the network.
  const insecure = (() => {
    try {
      const u = new URL(url);
      return u.protocol === "http:" && !!username.trim() && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    } catch {
      return false;
    }
  })();

  const submit = async (test: boolean) => {
    setBusy(true);
    setStatus(null);
    try {
      const id = await opdsApi.save({
        id: catalog?.id ?? savedId.current ?? "",
        name: name.trim() || new URL(url).host,
        url,
        username: username.trim() || null,
        // Empty field while editing keeps the stored password.
        password: password ? password : catalog || savedId.current ? null : "",
      });
      savedId.current = id;
      if (test) {
        const feed = await loadFeed(id, url);
        setStatus({ ok: true, text: t("opds.testOk", { title: feed.title || url, count: feed.entries.length }) });
        if (!catalog) onSaved(id);
      } else onSaved(id);
    } catch (e) {
      setStatus({ ok: false, text: describeError(String(e)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={catalog ? t("opds.editCatalog") : t("opds.addCatalog")} onClose={cancel}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        <label>
          {t("opds.url")}
          <input type="url" required value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
        </label>
        <p className="meta">{t("opds.urlHelp")}</p>
        <label>
          {t("opds.name")}
          <input value={name} placeholder={t("opds.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t("opds.username")}
          <input value={username} autoComplete="username" onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          {t("opds.password")}
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            placeholder={catalog?.has_password ? t("opds.passwordKept") : ""}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <p className="meta">{t("opds.passwordHelp")}</p>
        {insecure && (
          <div className="notice error" role="alert">
            {t("opds.insecureHttp")}
          </div>
        )}
        {status && (
          <div className={`notice ${status.ok ? "" : "error"}`} role={status.ok ? "status" : "alert"}>
            {status.text}
          </div>
        )}
        <div className="panel-row end">
          <button type="button" onClick={cancel}>
            {t("common.cancel")}
          </button>
          <button type="button" disabled={!url || busy} onClick={() => submit(true)}>
            {t("opds.test")}
          </button>
          <button className="primary" type="submit" disabled={!url || busy}>
            {t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function describeError(e: string): string {
  if (e.includes("401")) return t("opds.errorAuth");
  if (/dns|connect|resolve|timed out|error sending request/i.test(e)) return t("opds.errorNetwork", { error: e });
  return t("opds.error", { error: e });
}

interface Props {
  catalog: Catalog;
  onEdit: () => void;
  onOpenBook: (bookId: string) => void;
}

type Download = { state: "running"; received: number; total: number | null } | { state: "done"; bookId: string } | { state: "error"; message: string };

export function CatalogBrowser({ catalog, onEdit, onOpenBook }: Props) {
  // Visited feeds; the last one is shown. Back pops it.
  const [stack, setStack] = useState<string[]>([catalog.url]);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<Entry | null>(null);
  const [downloads, setDownloads] = useState<Record<string, Download>>({});
  const mainRef = useRef<HTMLDivElement>(null);
  const current = stack[stack.length - 1];

  useEffect(() => {
    setStack([catalog.url]);
  }, [catalog.id, catalog.url]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadFeed(catalog.id, current)
      .then((f) => {
        if (cancelled) return;
        setFeed(f);
        setTitles((t0) => ({ ...t0, [current]: f.title }));
        mainRef.current?.scrollTo({ top: 0 });
      })
      .catch((e) => !cancelled && setError(describeError(String(e))))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [catalog.id, current]);

  useEffect(() => {
    const un = listen<{ url: string; received: number; total: number | null }>("opds-progress", (e) =>
      setDownloads((d) =>
        d[e.payload.url]?.state === "running" ? { ...d, [e.payload.url]: { state: "running", received: e.payload.received, total: e.payload.total } } : d,
      ),
    );
    return () => {
      un.then((f) => f());
    };
  }, []);

  const open = (url: string) => setStack((s) => [...s, url]);
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feed?.search || !query.trim()) return;
    try {
      open(await searchUrl(catalog.id, feed.search, query.trim()));
    } catch (err) {
      setError(describeError(String(err)));
    }
  };

  const download = async (entry: Entry) => {
    const acq = bestAcquisition(entry);
    if (!acq) return;
    setDownloads((d) => ({ ...d, [acq.href]: { state: "running", received: 0, total: null } }));
    try {
      const bookId = await opdsApi.download(catalog.id, acq.href, entry.title);
      setDownloads((d) => ({ ...d, [acq.href]: { state: "done", bookId } }));
    } catch (e) {
      setDownloads((d) => ({ ...d, [acq.href]: { state: "error", message: describeError(String(e)) } }));
    }
  };

  const action = (entry: Entry) => {
    const acq = bestAcquisition(entry);
    if (!acq) return entry.acquisitions.length ? <span className="meta">{t("opds.unsupported")}</span> : null;
    const d = downloads[acq.href];
    if (d?.state === "running")
      return (
        <div className="dl-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.total ? Math.round((d.received / d.total) * 100) : undefined}>
          <div style={{ width: d.total ? `${(d.received / d.total) * 100}%` : "30%" }} className={d.total ? "" : "indeterminate"} />
          <span>{d.total ? `${Math.round((d.received / d.total) * 100)} %` : `${(d.received / 1048576).toFixed(1)} Mo`}</span>
        </div>
      );
    if (d?.state === "done")
      return (
        <button className="primary" onClick={() => onOpenBook(d.bookId)}>
          {t("opds.read")}
        </button>
      );
    return (
      <>
        <button className="primary" onClick={() => download(entry)} title={acq.type}>
          ⤓ {t("opds.download")} · {formatLabel(acq.type)}
        </button>
        {d?.state === "error" && (
          <span className="meta error-text" role="alert">
            {d.message}
          </span>
        )}
      </>
    );
  };

  return (
    <div className="catalog" ref={mainRef}>
      <div className="catalog-bar">
        <button onClick={back} disabled={stack.length < 2} aria-label={t("opds.back")} title={t("opds.back")}>
          ←
        </button>
        <nav className="crumbs small" aria-label={t("opds.path")}>
          {stack.map((u, i) => (
            <span key={`${u}-${i}`}>
              {i > 0 && <span className="sep">›</span>}
              <button className="ghost" onClick={() => setStack(stack.slice(0, i + 1))} aria-current={i === stack.length - 1 ? "page" : undefined}>
                {i === 0 ? catalog.name : titles[u] || "…"}
              </button>
            </span>
          ))}
        </nav>
        {feed?.search && (
          <form onSubmit={search} role="search">
            <input className="search" value={query} placeholder={t("opds.search")} aria-label={t("opds.search")} onChange={(e) => setQuery(e.target.value)} />
          </form>
        )}
        <button onClick={onEdit}>{t("opds.settings")}</button>
      </div>

      {loading && (
        <div className="notice" role="status">
          {t("common.loading")}
        </div>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}{" "}
          {error === t("opds.errorAuth") && (
            <button className="primary" onClick={onEdit}>
              {t("opds.signIn")}
            </button>
          )}
        </div>
      )}

      {feed && !error && (
        <>
          {feed.entries.length === 0 && !loading && <p className="meta">{t("opds.empty")}</p>}
          <div className="grid catalog-grid">
            {feed.entries.map((e) =>
              e.navHref ? (
                <button key={e.id} className="card shelf" onClick={() => open(e.navHref!)} title={e.summary || e.title}>
                  <div className="cover stack">
                    {e.cover ? <img src={coverUrl(catalog.id, e.cover)} alt="" loading="lazy" /> : <span aria-hidden="true">📁</span>}
                  </div>
                  <div className="title">{e.title}</div>
                  {e.summary && <div className="meta clamp">{e.summary}</div>}
                </button>
              ) : (
                <div key={e.id} className="card opds-pub">
                  <button className="cover" onClick={() => setDetail(e)} aria-label={t("opds.details", { title: e.title })}>
                    {e.cover ? <img src={coverUrl(catalog.id, e.cover)} alt="" loading="lazy" /> : <span className="kind">{formatLabel(bestAcquisition(e)?.type ?? "") ?? "?"}</span>}
                  </button>
                  <div className="title" title={e.title}>
                    {e.title}
                  </div>
                  {e.authors.length > 0 && <div className="subtitle">{e.authors.join(", ")}</div>}
                  <div className="pub-actions">{action(e)}</div>
                </div>
              ),
            )}
          </div>
          {(feed.previous || feed.next) && (
            <div className="panel-row pager">
              <button disabled={!feed.previous} onClick={() => feed.previous && setStack((s) => [...s.slice(0, -1), feed.previous!])}>
                ← {t("opds.previousPage")}
              </button>
              <span className="meta">{tn("opds.entries", feed.entries.length)}</span>
              <button disabled={!feed.next} onClick={() => feed.next && setStack((s) => [...s.slice(0, -1), feed.next!])}>
                {t("opds.nextPage")} →
              </button>
            </div>
          )}
        </>
      )}

      {detail && (
        <Modal title={detail.title} onClose={() => setDetail(null)}>
          <div className="opds-detail">
            {detail.cover && <img src={coverUrl(catalog.id, detail.cover)} alt="" />}
            <div className="form-grid">
              {detail.authors.length > 0 && <div>{detail.authors.join(", ")}</div>}
              {detail.series && <div className="meta">{detail.series}</div>}
              {detail.summary && <p className="summary">{detail.summary}</p>}
              <div className="meta">
                {t("opds.formats")} : {[...new Set(detail.acquisitions.map((a) => formatLabel(a.type) ?? a.type))].join(", ")}
              </div>
              <div className="pub-actions">{action(detail)}</div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
