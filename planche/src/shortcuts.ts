import { useEffect, useRef } from "react";

/**
 * Keyboard shortcuts: every action has default bindings that the user can
 * replace in the preferences. A binding is a normalized combo such as
 * "Ctrl+Shift+F", "PageDown" or "+". Scopes let the same key mean different
 * things in the library and in each reader.
 */
export type Scope = "global" | "library" | "reader" | "image" | "text";

export interface Action {
  id: string;
  scope: Scope;
  defaults: string[];
}

export const ACTIONS: Action[] = [
  // Everywhere
  { id: "app.preferences", scope: "global", defaults: ["Ctrl+,"] },
  { id: "app.fullscreen", scope: "global", defaults: ["F11", "Ctrl+F"] },
  { id: "app.shortcutsHelp", scope: "global", defaults: ["F1", "?"] },
  // Library
  { id: "library.search", scope: "library", defaults: ["F3", "/"] },
  { id: "library.openFile", scope: "library", defaults: ["Ctrl+O"] },
  { id: "library.addFolder", scope: "library", defaults: ["Ctrl+Shift+O"] },
  { id: "library.refresh", scope: "library", defaults: ["F5", "Ctrl+R"] },
  { id: "library.up", scope: "library", defaults: ["Backspace", "Alt+ArrowLeft"] },
  { id: "library.viewLibrary", scope: "library", defaults: ["Alt+1"] },
  { id: "library.viewSeries", scope: "library", defaults: ["Alt+2"] },
  { id: "library.viewInProgress", scope: "library", defaults: ["Alt+3"] },
  { id: "library.viewUnread", scope: "library", defaults: ["Alt+4"] },
  { id: "library.viewFavorites", scope: "library", defaults: ["Alt+5"] },
  { id: "library.viewRecentlyRead", scope: "library", defaults: ["Alt+6"] },
  { id: "library.viewRecentlyAdded", scope: "library", defaults: ["Alt+7"] },
  { id: "library.viewBookmarks", scope: "library", defaults: ["Alt+8"] },
  { id: "library.viewAnnotations", scope: "library", defaults: ["Alt+9"] },
  // Any reader
  { id: "reader.close", scope: "reader", defaults: ["Backspace"] },
  { id: "reader.toggleControls", scope: "reader", defaults: ["Escape"] },
  { id: "reader.next", scope: "reader", defaults: ["PageDown", "S"] },
  { id: "reader.previous", scope: "reader", defaults: ["PageUp", "Z"] },
  { id: "reader.forward", scope: "reader", defaults: ["ArrowRight"] },
  { id: "reader.backward", scope: "reader", defaults: ["ArrowLeft"] },
  { id: "reader.first", scope: "reader", defaults: ["Home"] },
  { id: "reader.last", scope: "reader", defaults: ["End"] },
  { id: "reader.nextBook", scope: "reader", defaults: ["Ctrl+PageDown"] },
  { id: "reader.previousBook", scope: "reader", defaults: ["Ctrl+PageUp"] },
  { id: "reader.goToPage", scope: "reader", defaults: ["G"] },
  { id: "reader.bookmarks", scope: "reader", defaults: ["B"] },
  { id: "reader.addBookmark", scope: "reader", defaults: ["Ctrl+B"] },
  { id: "reader.annotations", scope: "reader", defaults: ["A"] },
  { id: "reader.annotate", scope: "reader", defaults: ["H", "Ctrl+Shift+A"] },
  { id: "reader.search", scope: "reader", defaults: ["F3", "/"] },
  { id: "reader.searchNext", scope: "reader", defaults: ["Ctrl+G"] },
  { id: "reader.searchPrevious", scope: "reader", defaults: ["Ctrl+Shift+G"] },
  { id: "reader.toc", scope: "reader", defaults: ["T"] },
  { id: "reader.print", scope: "reader", defaults: ["Ctrl+P"] },
  { id: "reader.night", scope: "reader", defaults: ["N"] },
  { id: "reader.settings", scope: "reader", defaults: ["O"] },
  { id: "reader.zoomIn", scope: "reader", defaults: ["+", "=", "Ctrl+="] },
  { id: "reader.zoomOut", scope: "reader", defaults: ["-", "Ctrl+-"] },
  { id: "reader.zoomReset", scope: "reader", defaults: ["0", "Ctrl+0"] },
  { id: "tts.playPause", scope: "reader", defaults: ["R"] },
  { id: "tts.stop", scope: "reader", defaults: ["Shift+R"] },
  { id: "tts.next", scope: "reader", defaults: ["Ctrl+ArrowRight"] },
  { id: "tts.previous", scope: "reader", defaults: ["Ctrl+ArrowLeft"] },
  { id: "tts.faster", scope: "reader", defaults: ["]"] },
  { id: "tts.slower", scope: "reader", defaults: ["["] },
  // Comic / PDF reader
  { id: "image.manga", scope: "image", defaults: ["M"] },
  { id: "image.pageMode", scope: "image", defaults: ["P"] },
  { id: "image.fitMode", scope: "image", defaults: ["F"] },
  { id: "image.autoCrop", scope: "image", defaults: ["C"] },
  // Text EPUB reader
  { id: "text.flow", scope: "text", defaults: ["P"] },
  { id: "text.theme", scope: "text", defaults: ["Shift+N"] },
  { id: "text.columns", scope: "text", defaults: ["Shift+C"] },
  { id: "text.align", scope: "text", defaults: ["J"] },
  { id: "text.lineHeightUp", scope: "text", defaults: ["Shift+ArrowUp"] },
  { id: "text.lineHeightDown", scope: "text", defaults: ["Shift+ArrowDown"] },
  { id: "text.marginUp", scope: "text", defaults: ["Shift+ArrowRight"] },
  { id: "text.marginDown", scope: "text", defaults: ["Shift+ArrowLeft"] },
  { id: "text.resetTypography", scope: "text", defaults: ["Ctrl+Shift+0"] },
];

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"]);

/** Normalized combo for a key event, or null for a lone modifier. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIERS.has(e.key)) return null;
  let key = e.key === " " ? "Space" : e.key;
  // With Ctrl/Alt, digits by physical key: on AZERTY, Alt+1 reports "&".
  if ((e.ctrlKey || e.altKey) && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  // Letters are stored upper-case; Shift stays meaningful for them only, since
  // symbols such as "+" or "?" already need Shift on many layouts.
  const letter = key.length === 1 && key.toLowerCase() !== key.toUpperCase();
  if (letter) key = key.toUpperCase();
  const symbol = key.length === 1 && !letter && !/\d/.test(key);
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey && !e.getModifierState?.("AltGraph")) parts.push("Alt");
  if (e.shiftKey && !symbol) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

export type Bindings = Record<string, string[]>;

export const bindingsFor = (user: Bindings, id: string) =>
  user[id] ?? ACTIONS.find((a) => a.id === id)?.defaults ?? [];

/** Actions whose bindings overlap with `combo` in a scope that can be active at the same time. */
export function conflicts(user: Bindings, id: string, combo: string): string[] {
  const scope = ACTIONS.find((a) => a.id === id)?.scope;
  const compatible = (s: Scope) =>
    s === scope ||
    s === "global" ||
    scope === "global" ||
    (s === "reader" && (scope === "image" || scope === "text")) ||
    (scope === "reader" && (s === "image" || s === "text"));
  return ACTIONS.filter((a) => a.id !== id && compatible(a.scope) && bindingsFor(user, a.id).includes(combo)).map(
    (a) => a.id,
  );
}

/** While the shortcut editor captures a key, global handlers stay quiet. */
export const capture = { active: false };

/** Open modal dialogs: only "global" shortcuts run while one is shown. */
export const modals = { open: 0 };

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "color"].includes(t.type)));

/**
 * Runs `handlers[actionId]` when a key bound to that action is pressed and one
 * of `scopes` is active. Handlers may return false to let the event through.
 */
export function useShortcuts(
  scopes: Scope[],
  user: Bindings,
  handlers: Partial<Record<string, (e: KeyboardEvent) => void | boolean>>,
) {
  const ref = useRef({ scopes, user, handlers });
  ref.current = { scopes, user, handlers };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (capture.active || e.defaultPrevented) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      if (typing(e.target) && combo !== "Escape") return;
      const { scopes, user, handlers } = ref.current;
      if (modals.open > 0 && scopes.some((s) => s !== "global")) return;
      for (const a of ACTIONS) {
        if (!scopes.includes(a.scope) || !handlers[a.id]) continue;
        if (!bindingsFor(user, a.id).includes(combo)) continue;
        if (handlers[a.id]!(e) !== false) e.preventDefault();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Readable form of a combo for display ("Ctrl+Shift+ArrowLeft" → "Ctrl + Shift + ←"). */
export function displayCombo(combo: string): string {
  const names: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Space: "␣",
  };
  return combo
    .split("+")
    .map((p, i, all) => (p === "" && i === all.length - 1 ? "+" : (names[p] ?? p)))
    .filter((p, i, all) => !(p === "" && i < all.length - 1))
    .join(" + ");
}
