import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import { isAndroid, saveDocument } from "./platform";

export interface Annotation {
  id: string;
  book_id: string;
  book_name: string;
  book_path: string;
  /** Page (image books) or approximate location index (text). */
  page: number;
  /** EPUB CFI range for text highlights; null for page notes. */
  position: string | null;
  /** Highlighted quote (text) or null. */
  text: string | null;
  note: string;
  color: string;
  created_at: number;
  updated_at: number;
}

export const ANNOTATION_COLORS = ["#f7d154", "#8ad48a", "#7cc4f2", "#f29bb4", "#f5a25d", "#b69cf2"];

export const annotationsApi = {
  list: (bookId?: string) => invoke<Annotation[]>("list_annotations", { bookId: bookId ?? null }),
  save: (a: Partial<Annotation> & Pick<Annotation, "book_id" | "page" | "color" | "note">) =>
    invoke<string>("save_annotation", {
      annotation: { id: "", position: null, text: null, ...a },
    }),
  remove: (id: string) => invoke<void>("delete_annotation", { id }),
};

const iso = (secs: number) => new Date(secs * 1000).toISOString();

/** Markdown: one section per book, quotes as blockquotes, notes below. */
export function toMarkdown(list: Annotation[]): string {
  const out: string[] = [`# ${t("annotations.exportTitle")}`, ""];
  let book = "";
  for (const a of list) {
    if (a.book_id !== book) {
      book = a.book_id;
      out.push(`## ${a.book_name}`, "");
    }
    out.push(`### ${t("annotations.pageLabel", { page: a.page + 1 })}`);
    if (a.text) out.push(...a.text.split("\n").map((l) => `> ${l}`));
    if (a.note) out.push("", a.note);
    out.push("");
  }
  return out.join("\n");
}

/** W3C Web Annotation collection, the format Readium/Thorium also exchange. */
export function toW3C(list: Annotation[]) {
  return {
    "@context": "http://www.w3.org/ns/anno.jsonld",
    type: "AnnotationCollection",
    generator: "Planche",
    generated: new Date().toISOString(),
    items: list.map((a) => ({
      id: `urn:uuid:${a.id}`,
      type: "Annotation",
      created: iso(a.created_at),
      modified: iso(a.updated_at),
      motivation: a.note ? "commenting" : "highlighting",
      body: a.note ? { type: "TextualBody", value: a.note, format: "text/plain" } : undefined,
      target: {
        source: a.book_path,
        selector: [
          a.position
            ? {
                type: "FragmentSelector",
                conformsTo: "http://www.idpf.org/epub/linking/cfi/epub-cfi.html",
                value: a.position,
              }
            : { type: "FragmentSelector", value: `page=${a.page + 1}` },
          ...(a.text ? [{ type: "TextQuoteSelector", exact: a.text }] : []),
        ],
      },
      "planche:color": a.color,
      "planche:page": a.page + 1,
      "planche:book": a.book_name,
    })),
  };
}

/** Asks where to save (dialog run by the backend), then writes Markdown or JSON depending on the chosen extension.
 * Android's picker cannot switch formats: Markdown there. */
export async function exportAnnotations(list: Annotation[], baseName: string): Promise<string | null> {
  const defaultName = `${baseName.replace(/[\\/:*?"<>|]/g, "_")} - ${t("annotations.title")}.md`;
  if (isAndroid) return (await saveDocument(defaultName, "text/markdown", toMarkdown(list)))?.name ?? null;
  return invoke<string | null>("export_annotations", {
    title: t("annotations.export"),
    defaultName,
    markdown: toMarkdown(list),
    json: JSON.stringify(toW3C(list), null, 2),
  });
}
