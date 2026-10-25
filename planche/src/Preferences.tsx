import { useEffect, useMemo, useState } from "react";
import { LANGUAGES, t } from "./i18n";
import { Modal } from "./Panels";
import {
  defaultTypography,
  FIT_MODES,
  FONT_FAMILIES,
  PAGE_MODES,
  Settings,
  Typography,
} from "./settings";
import { ACTIONS, bindingsFor, capture, comboFromEvent, conflicts, displayCombo, Scope } from "./shortcuts";
import { voices } from "./tts";

type Tab = "general" | "reading" | "text" | "voice" | "shortcuts";

interface Props {
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  onClose: () => void;
  initialTab?: Tab;
}

export function Preferences({ settings, onSettings, onClose, initialTab = "general" }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabs: Tab[] = ["general", "reading", "text", "voice", "shortcuts"];
  return (
    <Modal title={t("prefs.title")} onClose={onClose}>
      <div className="prefs">
        <nav className="tabs" role="tablist">
          {tabs.map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
              {t(`prefs.tab.${k}`)}
            </button>
          ))}
        </nav>
        <div className="prefs-body">
          {tab === "general" && (
            <div className="form-grid">
              <label>
                {t("prefs.language")}
                <select value={settings.language} onChange={(e) => onSettings({ language: e.target.value })}>
                  {Object.entries(LANGUAGES).map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="meta">{t("prefs.languageHint")}</p>
              <label>
                {t("prefs.appTheme")}
                <select value={settings.appTheme} onChange={(e) => onSettings({ appTheme: e.target.value as Settings["appTheme"] })}>
                  <option value="system">{t("prefs.themeSystem")}</option>
                  <option value="light">{t("prefs.themeLight")}</option>
                  <option value="dark">{t("prefs.themeDark")}</option>
                </select>
              </label>
              <Range
                label={t("prefs.uiScale")}
                value={settings.uiScale}
                min={80}
                max={175}
                step={5}
                format={(v) => `${v} %`}
                onChange={(v) => onSettings({ uiScale: v })}
              />
              <label className="check">
                <input type="checkbox" checked={settings.reduceMotion} onChange={(e) => onSettings({ reduceMotion: e.target.checked })} />
                {t("prefs.reduceMotion")}
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.foldersFirst}
                  onChange={(e) => onSettings({ foldersFirst: e.target.checked })}
                />
                {t("prefs.foldersFirst")}
              </label>
            </div>
          )}
          {tab === "reading" && (
            <div className="form-grid">
              <label>
                {t("prefs.pageMode")}
                <select value={settings.pageMode} onChange={(e) => onSettings({ pageMode: e.target.value as Settings["pageMode"] })}>
                  {PAGE_MODES.map((m) => (
                    <option key={m} value={m}>
                      {t(`pageMode.${m}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("prefs.fitMode")}
                <select value={settings.fitMode} onChange={(e) => onSettings({ fitMode: e.target.value as Settings["fitMode"] })}>
                  {FIT_MODES.map((m) => (
                    <option key={m} value={m}>
                      {t(`fitMode.${m}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.mangaByDefault} onChange={(e) => onSettings({ mangaByDefault: e.target.checked })} />
                {t("prefs.mangaByDefault")}
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.autoCrop} onChange={(e) => onSettings({ autoCrop: e.target.checked })} />
                {t("prefs.autoCrop")}
              </label>
              <label>
                {t("prefs.background")}
                <input type="color" value={settings.background} onChange={(e) => onSettings({ background: e.target.value })} />
              </label>
            </div>
          )}
          {tab === "text" && (
            <TypographyForm value={settings.typography} onChange={(ty) => onSettings({ typography: ty })} />
          )}
          {tab === "voice" && <VoiceForm settings={settings} onSettings={onSettings} />}
          {tab === "shortcuts" && <ShortcutsEditor settings={settings} onSettings={onSettings} />}
        </div>
      </div>
    </Modal>
  );
}

function Range(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="range">
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="value">{props.format(props.value)}</span>
    </label>
  );
}

/** Typography settings for text EPUBs; also shown as the quick panel in the text reader. */
export function TypographyForm({ value, onChange }: { value: Typography; onChange: (t: Typography) => void }) {
  const set = (patch: Partial<Typography>) => onChange({ ...value, ...patch });
  const known = FONT_FAMILIES.some((f) => f.value === value.fontFamily);
  const publisher = (v: number) => (v < 0 || v === 0 ? t("typo.publisher") : "");
  return (
    <div className="form-grid">
      <label>
        {t("typo.font")}
        <select value={known ? value.fontFamily : "custom"} onChange={(e) => set({ fontFamily: e.target.value === "custom" ? "Arial" : e.target.value })}>
          {FONT_FAMILIES.map((f) => (
            <option key={f.key} value={f.value}>
              {t(`typo.fonts.${f.key}`)}
            </option>
          ))}
          <option value="custom">{t("typo.fonts.custom")}</option>
        </select>
      </label>
      {!known && (
        <label>
          {t("typo.customFont")}
          <input value={value.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })} />
        </label>
      )}
      <Range label={t("typo.fontSize")} value={value.fontSize} min={60} max={300} step={5} format={(v) => `${v} %`} onChange={(v) => set({ fontSize: v })} />
      <Range
        label={t("typo.lineHeight")}
        value={value.lineHeight}
        min={0}
        max={2.6}
        step={0.1}
        format={(v) => publisher(v) || v.toFixed(1)}
        onChange={(v) => set({ lineHeight: v < 1 ? 0 : v })}
      />
      <Range label={t("typo.letterSpacing")} value={value.letterSpacing} min={0} max={0.3} step={0.01} format={(v) => (v ? `${v.toFixed(2)} em` : t("typo.publisher"))} onChange={(v) => set({ letterSpacing: v })} />
      <Range label={t("typo.wordSpacing")} value={value.wordSpacing} min={0} max={1} step={0.05} format={(v) => (v ? `${v.toFixed(2)} em` : t("typo.publisher"))} onChange={(v) => set({ wordSpacing: v })} />
      <Range
        label={t("typo.paragraphSpacing")}
        value={value.paragraphSpacing}
        min={-0.25}
        max={2.5}
        step={0.25}
        format={(v) => (v < 0 ? t("typo.publisher") : `${v} em`)}
        onChange={(v) => set({ paragraphSpacing: v < 0 ? -1 : v })}
      />
      <Range
        label={t("typo.paragraphIndent")}
        value={value.paragraphIndent}
        min={-0.5}
        max={4}
        step={0.5}
        format={(v) => (v < 0 ? t("typo.publisher") : `${v} em`)}
        onChange={(v) => set({ paragraphIndent: v < 0 ? -1 : v })}
      />
      <Range label={t("typo.margin")} value={value.margin} min={0} max={25} step={1} format={(v) => `${v} %`} onChange={(v) => set({ margin: v })} />
      <Range
        label={t("typo.maxLineWidth")}
        value={value.maxLineWidth}
        min={0}
        max={80}
        step={5}
        format={(v) => (v ? `${v} em` : t("typo.unlimited"))}
        onChange={(v) => set({ maxLineWidth: v })}
      />
      <label>
        {t("typo.align")}
        <select value={value.textAlign} onChange={(e) => set({ textAlign: e.target.value as Typography["textAlign"] })}>
          <option value="publisher">{t("typo.publisher")}</option>
          <option value="left">{t("typo.alignLeft")}</option>
          <option value="justify">{t("typo.alignJustify")}</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={value.hyphenate} onChange={(e) => set({ hyphenate: e.target.checked })} />
        {t("typo.hyphenate")}
      </label>
      <label>
        {t("typo.flow")}
        <select value={value.flow} onChange={(e) => set({ flow: e.target.value as Typography["flow"] })}>
          <option value="paginated">{t("typo.paginated")}</option>
          <option value="scrolled">{t("typo.scrolled")}</option>
        </select>
      </label>
      <label>
        {t("typo.columns")}
        <select value={value.columns} onChange={(e) => set({ columns: e.target.value as Typography["columns"] })} disabled={value.flow === "scrolled"}>
          <option value="auto">{t("typo.columnsAuto")}</option>
          <option value="1">{t("typo.columnsOne")}</option>
          <option value="2">{t("typo.columnsTwo")}</option>
        </select>
      </label>
      <label>
        {t("typo.theme")}
        <select value={value.theme} onChange={(e) => set({ theme: e.target.value as Typography["theme"] })}>
          {(["light", "sepia", "dark", "black", "custom"] as const).map((k) => (
            <option key={k} value={k}>
              {t(`typo.themes.${k}`)}
            </option>
          ))}
        </select>
      </label>
      {value.theme === "custom" && (
        <div className="panel-row">
          <label>
            {t("typo.background")}
            <input type="color" value={value.customBackground} onChange={(e) => set({ customBackground: e.target.value })} />
          </label>
          <label>
            {t("typo.textColor")}
            <input type="color" value={value.customText} onChange={(e) => set({ customText: e.target.value })} />
          </label>
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={value.overridePublisher} onChange={(e) => set({ overridePublisher: e.target.checked })} />
        {t("typo.overridePublisher")}
      </label>
      <button onClick={() => onChange({ ...defaultTypography, flow: value.flow })}>{t("typo.reset")}</button>
    </div>
  );
}

function VoiceForm({ settings, onSettings }: { settings: Settings; onSettings: (p: Partial<Settings>) => void }) {
  const [list, setList] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    voices().then(setList);
  }, []);
  const sp = settings.speech;
  const set = (patch: Partial<Settings["speech"]>) => onSettings({ speech: { ...sp, ...patch } });
  const test = () => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t("tts.sample"));
    const v = list.find((x) => x.voiceURI === sp.voice);
    if (v) u.voice = v;
    u.lang = v?.lang ?? settings.language;
    u.rate = sp.rate;
    u.pitch = sp.pitch;
    speechSynthesis.speak(u);
  };
  return (
    <div className="form-grid">
      {list.length === 0 && <p className="meta">{t("tts.noVoices")}</p>}
      <label>
        {t("tts.voice")}
        <select value={sp.voice} onChange={(e) => set({ voice: e.target.value })}>
          <option value="">{t("tts.voiceAuto")}</option>
          {list.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} ({v.lang})
            </option>
          ))}
        </select>
      </label>
      <Range label={t("tts.rate")} value={sp.rate} min={0.5} max={2.5} step={0.1} format={(v) => `×${v.toFixed(1)}`} onChange={(v) => set({ rate: v })} />
      <Range label={t("tts.pitch")} value={sp.pitch} min={0.5} max={1.5} step={0.1} format={(v) => v.toFixed(1)} onChange={(v) => set({ pitch: v })} />
      <label className="check">
        <input type="checkbox" checked={sp.highlight} onChange={(e) => set({ highlight: e.target.checked })} />
        {t("tts.highlight")}
      </label>
      <button onClick={test} disabled={list.length === 0}>
        {t("tts.test")}
      </button>
      <p className="meta">{t("tts.about")}</p>
    </div>
  );
}

const SCOPES: Scope[] = ["global", "library", "reader", "image", "text"];

function ShortcutsEditor({ settings, onSettings }: { settings: Settings; onSettings: (p: Partial<Settings>) => void }) {
  const [filter, setFilter] = useState("");
  const [capturing, setCapturing] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const user = settings.shortcuts;

  const setBindings = (next: Record<string, string[]>) => onSettings({ shortcuts: next });

  useEffect(() => {
    if (!capturing) return;
    capture.active = true;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const combo = comboFromEvent(e);
      if (!combo) return;
      if (combo === "Escape") return setCapturing(null);
      const clash = conflicts(user, capturing, combo);
      const next = { ...user };
      // The new key wins: it is removed from the actions it was bound to.
      for (const id of clash) next[id] = bindingsFor(user, id).filter((c) => c !== combo);
      const mine = bindingsFor(user, capturing);
      if (!mine.includes(combo)) next[capturing] = [...mine, combo];
      setWarning(
        clash.length
          ? t("shortcuts.reassigned", { key: displayCombo(combo), actions: clash.map((id) => t(`action.${id}`)).join(", ") })
          : null,
      );
      setBindings(next);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      capture.active = false;
    };
  }, [capturing, user]);

  const q = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      ACTIONS.filter(
        (a) =>
          !q ||
          t(`action.${a.id}`).toLowerCase().includes(q) ||
          bindingsFor(user, a.id).some((c) => c.toLowerCase().includes(q)),
      ),
    [q, user, settings.language],
  );

  return (
    <div className="shortcuts">
      <div className="panel-row">
        <input placeholder={t("shortcuts.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button
          onClick={() => {
            if (confirm(t("shortcuts.resetAllConfirm"))) setBindings({});
          }}
        >
          {t("shortcuts.resetAll")}
        </button>
      </div>
      <p className="meta">{t("shortcuts.count", { actions: ACTIONS.length })}</p>
      {warning && <div className="notice">{warning}</div>}
      {SCOPES.map((scope) => {
        const rows = visible.filter((a) => a.scope === scope);
        if (!rows.length) return null;
        return (
          <section key={scope}>
            <h4>{t(`shortcuts.scope.${scope}`)}</h4>
            {rows.map((a) => {
              const combos = bindingsFor(user, a.id);
              const custom = a.id in user;
              return (
                <div key={a.id} className="shortcut-row">
                  <span className="label">{t(`action.${a.id}`)}</span>
                  <span className="keys">
                    {combos.map((c) => (
                      <span key={c} className="kbd">
                        {displayCombo(c)}
                        <button
                          className="ghost"
                          aria-label={t("shortcuts.remove", { key: displayCombo(c) })}
                          onClick={() => setBindings({ ...user, [a.id]: combos.filter((x) => x !== c) })}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {capturing === a.id ? (
                      <span className="kbd capturing">{t("shortcuts.pressKey")}</span>
                    ) : (
                      <button className="ghost" onClick={() => setCapturing(a.id)} title={t("shortcuts.add")}>
                        ＋
                      </button>
                    )}
                    {custom && (
                      <button
                        className="ghost"
                        title={t("shortcuts.reset")}
                        onClick={() => {
                          const next = { ...user };
                          delete next[a.id];
                          setBindings(next);
                        }}
                      >
                        ↺
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

/** Read-only list of the active shortcuts for the current context (F1). */
export function ShortcutsHelp({ settings, scopes, onClose }: { settings: Settings; scopes: Scope[]; onClose: () => void }) {
  return (
    <Modal title={t("shortcuts.helpTitle")} onClose={onClose}>
      <div className="shortcuts help">
        {scopes.map((scope) => (
          <section key={scope}>
            <h4>{t(`shortcuts.scope.${scope}`)}</h4>
            {ACTIONS.filter((a) => a.scope === scope && bindingsFor(settings.shortcuts, a.id).length).map((a) => (
              <div key={a.id} className="shortcut-row">
                <span className="label">{t(`action.${a.id}`)}</span>
                <span className="keys">
                  {bindingsFor(settings.shortcuts, a.id).map((c) => (
                    <span key={c} className="kbd">
                      {displayCombo(c)}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
