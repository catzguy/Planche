// Lists every translation key the UI uses (literal t()/tn() calls plus the
// dynamic families below) and reports keys missing from or unused in a locale.
// Usage: node scripts/i18n-keys.mjs [locale]   (default: fr)
import fs from "node:fs";
import path from "node:path";

const src = path.resolve("src");
const files = fs.readdirSync(src).filter((f) => /\.(tsx?|ts)$/.test(f));
const keys = new Set();
for (const f of files) {
  const text = fs.readFileSync(path.join(src, f), "utf8");
  for (const m of text.matchAll(/\btn?\(\s*"([\w.-]+)"/g)) keys.add(m[1]);
}
const shortcuts = fs.readFileSync(path.join(src, "shortcuts.ts"), "utf8");
for (const m of shortcuts.matchAll(/id: "([\w.]+)", scope/g)) keys.add(`action.${m[1]}`);
const families = {
  view: ["library", "series", "inProgress", "unread", "favorites", "recentlyRead", "recentlyAdded", "bookmarks", "annotations", "opds"],
  sort: ["nameAsc", "nameDesc", "series", "dateAsc", "dateDesc"],
  pageMode: ["single", "double", "doubleCover", "scroll"],
  fitMode: ["both", "width", "height"],
  "prefs.tab": ["general", "reading", "text", "voice", "shortcuts"],
  "typo.fonts": ["publisher", "serif", "sans", "humanist", "book", "mono", "dyslexic", "custom"],
  "typo.themes": ["light", "sepia", "dark", "black", "custom"],
  "shortcuts.scope": ["global", "library", "reader", "image", "text"],
  tts: ["play", "pause"],
};
for (const [prefix, list] of Object.entries(families)) for (const k of list) keys.add(`${prefix}.${k}`);

// Plural keys are used through tn(): require _one and _other.
const plural = new Set();
for (const f of files) {
  const text = fs.readFileSync(path.join(src, f), "utf8");
  for (const m of text.matchAll(/\btn\(\s*"([\w.-]+)"/g)) plural.add(m[1]);
}
const expected = new Set([...keys].flatMap((k) => (plural.has(k) ? [`${k}_one`, `${k}_other`] : [k])));

const locale = process.argv[2] ?? "fr";
const file = path.join(src, "locales", `${locale}.json`);
const dict = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const missing = [...expected].filter((k) => !(k in dict)).sort();
const unused = Object.keys(dict).filter((k) => !expected.has(k) && !/_(zero|two|few|many)$/.test(k)).sort();
console.log(`${expected.size} keys expected, ${missing.length} missing, ${unused.length} unused in ${locale}.json`);
if (missing.length) console.log("MISSING:\n" + missing.join("\n"));
if (unused.length) console.log("UNUSED:\n" + unused.join("\n"));
process.exitCode = missing.length ? 1 : 0;
