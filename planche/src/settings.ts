import { api } from "./api";
import { matchLanguage } from "./i18n";

export type PageMode = "single" | "double" | "doubleCover" | "scroll";
export type FitMode = "width" | "height" | "both";
export type SortMode = "nameAsc" | "nameDesc" | "series" | "dateAsc" | "dateDesc";

/** Reflowable (text EPUB) presentation. */
export interface Typography {
  /** "" keeps the publisher's font. */
  fontFamily: string;
  /** Percent of the publisher's size. */
  fontSize: number;
  /** Unitless line height, 0 = publisher's. */
  lineHeight: number;
  /** em. */
  letterSpacing: number;
  /** em. */
  wordSpacing: number;
  /** em between paragraphs, -1 = publisher's. */
  paragraphSpacing: number;
  /** em of first-line indent, -1 = publisher's. */
  paragraphIndent: number;
  /** Horizontal page margin, percent of the width. */
  margin: number;
  /** Maximum line length in em, 0 = unlimited. */
  maxLineWidth: number;
  textAlign: "publisher" | "left" | "justify";
  hyphenate: boolean;
  columns: "auto" | "1" | "2";
  flow: "paginated" | "scrolled";
  theme: "light" | "sepia" | "dark" | "black" | "custom";
  customBackground: string;
  customText: string;
  /** Ignore the book's own colours and fonts entirely. */
  overridePublisher: boolean;
}

export interface Speech {
  /** voiceURI, "" = system default for the book's language. */
  voice: string;
  rate: number;
  pitch: number;
  /** Highlight the sentence being read. */
  highlight: boolean;
}

export interface Settings {
  language: string;
  /** Application colours; "system" follows the OS. */
  appTheme: "system" | "light" | "dark";
  /** Interface (not page) scale in percent. */
  uiScale: number;
  /** Disable animations even if the OS does not ask for it. */
  reduceMotion: boolean;
  pageMode: PageMode;
  fitMode: FitMode;
  mangaByDefault: boolean;
  background: string;
  sort: SortMode;
  foldersFirst: boolean;
  /** Night-mode dimmer opacity, 0 = off. */
  dimmer: number;
  /** Page width in continuous scroll, as a fraction of the window width. */
  scrollWidth: number;
  /** Trim uniform margins around pages. */
  autoCrop: boolean;
  typography: Typography;
  speech: Speech;
  /** User key bindings per action id; absent = defaults (see shortcuts.ts). */
  shortcuts: Record<string, string[]>;
}

export const defaultTypography: Typography = {
  fontFamily: "",
  fontSize: 100,
  lineHeight: 0,
  letterSpacing: 0,
  wordSpacing: 0,
  paragraphSpacing: -1,
  paragraphIndent: -1,
  margin: 6,
  maxLineWidth: 40,
  textAlign: "publisher",
  hyphenate: false,
  columns: "auto",
  flow: "paginated",
  theme: "light",
  customBackground: "#20232a",
  customText: "#e6e1d6",
  overridePublisher: false,
};

export const defaultSettings: Settings = {
  language: matchLanguage(navigator.language),
  appTheme: "system",
  uiScale: 100,
  reduceMotion: false,
  pageMode: "single",
  fitMode: "both",
  mangaByDefault: false,
  background: "#000000",
  sort: "nameAsc",
  foldersFirst: true,
  dimmer: 0,
  scrollWidth: 0.6,
  autoCrop: false,
  typography: defaultTypography,
  speech: { voice: "", rate: 1, pitch: 1, highlight: true },
  shortcuts: {},
};

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await api.getSettings();
    const saved = raw ? JSON.parse(raw) : {};
    const typography = { ...defaultTypography, ...saved.typography };
    return {
      ...defaultSettings,
      ...saved,
      typography: { ...typography, fontFamily: currentFont(typography.fontFamily) },
      speech: { ...defaultSettings.speech, ...saved.speech },
    };
  } catch {
    return defaultSettings;
  }
}

export const saveSettings = (s: Settings) => api.setSettings(JSON.stringify(s));

export const PAGE_MODES: PageMode[] = ["single", "double", "doubleCover", "scroll"];
export const FIT_MODES: FitMode[] = ["both", "width", "height"];
export const DIMMER_STEPS = [0, 0.3, 0.5, 0.7];

/** Reading themes for text: page background and text colour. */
export const THEMES: Record<Exclude<Typography["theme"], "custom">, { bg: string; fg: string }> = {
  light: { bg: "#ffffff", fg: "#1b1b1b" },
  sepia: { bg: "#f4ecd8", fg: "#5b4636" },
  dark: { bg: "#20232a", fg: "#e6e1d6" },
  black: { bg: "#000000", fg: "#cfcfcf" },
};

export const themeColors = (ty: Typography) =>
  ty.theme === "custom" ? { bg: ty.customBackground, fg: ty.customText } : THEMES[ty.theme];

/** Font choices offered for text; values are CSS font-family lists, with
 * look-alike fonts common on Linux after the Windows and macOS names.
 * `legacy` is the list saved by earlier versions. */
export const FONT_FAMILIES: { key: string; value: string; legacy?: string }[] = [
  { key: "publisher", value: "" },
  {
    key: "serif",
    value: "Georgia, 'Times New Roman', Gelasio, 'Liberation Serif', 'DejaVu Serif', serif",
    legacy: "Georgia, 'Times New Roman', serif",
  },
  {
    key: "sans",
    value: "'Segoe UI', Roboto, Helvetica, Arial, 'Noto Sans', 'Liberation Sans', sans-serif",
    legacy: "'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  {
    key: "humanist",
    value: "Verdana, Tahoma, 'DejaVu Sans', 'Bitstream Vera Sans', sans-serif",
    legacy: "Verdana, Tahoma, sans-serif",
  },
  {
    key: "book",
    value: "'Palatino Linotype', Palatino, 'Book Antiqua', 'TeX Gyre Pagella', P052, 'URW Palladio L', serif",
    legacy: "'Palatino Linotype', Palatino, 'Book Antiqua', serif",
  },
  {
    key: "mono",
    value: "Consolas, 'Courier New', 'DejaVu Sans Mono', 'Liberation Mono', monospace",
    legacy: "Consolas, 'Courier New', monospace",
  },
  { key: "dyslexic", value: "'OpenDyslexic', 'Comic Sans MS', sans-serif" },
];

/** Maps a font list saved by an earlier version to the current one. */
const currentFont = (font: string) => FONT_FAMILIES.find((f) => f.legacy === font)?.value ?? font;
