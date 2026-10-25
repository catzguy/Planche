// Interface translations. French is the source language: every key exists in
// locales/fr.json; other locales may lag behind and fall back to French.
// Keys are flat ("reader.next"); values use {name} placeholders. Plural forms
// are separate keys suffixed with an Intl.PluralRules category ("_one", "_other").

const files = import.meta.glob<Record<string, string>>("./locales/*.json", { eager: true, import: "default" });

const dictionaries: Record<string, Record<string, string>> = {};
for (const [path, dict] of Object.entries(files)) dictionaries[path.match(/([\w-]+)\.json$/)![1]] = dict;

/** The 27 interface languages, in their own names. */
export const LANGUAGES: Record<string, string> = {
  ar: "العربية",
  ca: "Català",
  cs: "Čeština",
  da: "Dansk",
  de: "Deutsch",
  el: "Ελληνικά",
  en: "English",
  es: "Español",
  et: "Eesti",
  eu: "Euskara",
  fi: "Suomi",
  fr: "Français",
  gl: "Galego",
  it: "Italiano",
  ja: "日本語",
  lt: "Lietuvių",
  nl: "Nederlands",
  pl: "Polski",
  "pt-BR": "Português (Brasil)",
  "pt-PT": "Português (Portugal)",
  ru: "Русский",
  sl: "Slovenščina",
  sv: "Svenska",
  ta: "தமிழ்",
  tr: "Türkçe",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
};

const RTL = new Set(["ar"]);
const SOURCE = "fr";

let current = SOURCE;
let plural = new Intl.PluralRules(SOURCE);

/** Best supported language for a BCP 47 tag ("fr-CA" → "fr", "pt" → "pt-PT", "zh-HK" → "zh-TW"). */
export function matchLanguage(tag: string): string {
  if (LANGUAGES[tag]) return tag;
  const [base, region] = tag.split("-");
  if (base === "pt") return region === "BR" ? "pt-BR" : "pt-PT";
  if (base === "zh") return ["TW", "HK", "MO", "Hant"].includes(region ?? "") ? "zh-TW" : "zh-CN";
  return LANGUAGES[base] ? base : "en";
}

export function setLanguage(lang: string) {
  current = LANGUAGES[lang] ? lang : SOURCE;
  plural = new Intl.PluralRules(current);
  document.documentElement.lang = current;
  document.documentElement.dir = RTL.has(current) ? "rtl" : "ltr";
}

export const currentLanguage = () => current;

/** Keeps a numeric run such as "3 / 12" or "1–2" in left-to-right order inside right-to-left text. */
export const ltr = (s: string) => `⁦${s}⁩`;

function lookup(key: string): string {
  return dictionaries[current]?.[key] ?? dictionaries[SOURCE]?.[key] ?? key;
}

function fill(text: string, vars?: Record<string, string | number>) {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text;
}

/** Translated text for `key`. */
export function t(key: string, vars?: Record<string, string | number>): string {
  return fill(lookup(key), vars);
}

/** Plural-aware translation: picks `key_one`, `key_other`… from `count`, which is also available as {count}. */
export function tn(key: string, count: number, vars?: Record<string, string | number>): string {
  const cat = plural.select(count);
  const dict = dictionaries[current] ?? {};
  const k = `${key}_${cat}` in dict || `${key}_${cat}` in (dictionaries[SOURCE] ?? {}) ? `${key}_${cat}` : `${key}_other`;
  return fill(lookup(k), { count, ...vars });
}
