import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type BookKind = "zip" | "rar" | "7z" | "tar" | "pdf" | "epub" | "folder";

export interface Root {
  id: string;
  path: string;
}

export interface Shelf {
  id: string;
  root_id: string;
  parent_id: string | null;
  path: string;
  name: string;
}

export interface Book {
  id: string;
  root_id: string;
  shelf_id: string | null;
  path: string;
  name: string;
  kind: BookKind;
  size: number;
  added_at: number;
  page_count: number;
  current_page: number;
  last_read: number | null;
  finished: boolean;
  favorite: boolean;
  manga: boolean | null;
  /** 0 = pending, 1 = available, 2 = failed */
  thumb: number;
  // From ComicInfo.xml (comic archives) or the OPF (EPUB); null when absent.
  title: string | null;
  series: string | null;
  number: string | null;
  volume: number | null;
  year: number | null;
  authors: string | null;
  /** Text EPUBs: reading position as an EPUB CFI. */
  position: string | null;
}

/** Display title: "Series #N" for issues of a series, else the metadata title, else the file name. */
export const bookTitle = (b: Book) =>
  b.series ? `${b.series}${b.number ? ` #${b.number}` : ""}` : (b.title ?? b.name);

/** Secondary line: the issue title when the main line shows the series. */
export const bookSubtitle = (b: Book) => (b.series && b.title ? b.title : null);

export interface Bookmark {
  id: string;
  book_id: string;
  book_name: string;
  name: string;
  page: number;
  position: string | null;
  created_at: number;
}

/** Files opened outside the library carry an empty root id. */
export const isStandalone = (b: Book) => b.root_id === "";

export interface Library {
  roots: Root[];
  shelves: Shelf[];
  books: Book[];
}

// "http://planche.localhost/" on Windows, "planche://localhost/" elsewhere.
const base = convertFileSrc("", "planche");

export const pageUrl = (id: string, n: number) => `${base}page/${id}/${n}`;
export const thumbUrl = (id: string) => `${base}thumb/${id}`;
export const rawUrl = (id: string) => `${base}raw/${id}`;

export const api = {
  library: () => invoke<Library>("get_library"),
  addRoot: (path: string) => invoke<void>("add_root", { path }),
  removeRoot: (id: string) => invoke<void>("remove_root", { id }),
  rescan: () => invoke<void>("rescan"),
  openBook: (id: string) => invoke<{ book: Book; page_count: number; reflowable: boolean }>("open_book", { id }),
  setProgress: (id: string, page: number, position?: string) =>
    invoke<void>("set_progress", { id, page, position: position ?? null }),
  setPageCount: (id: string, count: number) => invoke<void>("set_page_count", { id, count }),
  setFavorite: (id: string, value: boolean) => invoke<void>("set_favorite", { id, value }),
  setFinished: (ids: string[], value: boolean) => invoke<void>("set_finished", { ids, value }),
  setManga: (ids: string[], value: boolean | null) => invoke<void>("set_manga", { ids, value }),
  saveThumbnail: (id: string, data: number[]) => invoke<void>("save_thumbnail", { id, data }),
  openFile: (path: string) => invoke<string>("open_file", { path }),
  takeInitialFile: () => invoke<string | null>("take_initial_file"),
  openWithOtherApp: (path: string) => invoke<void>("open_with_other_app", { path }),
  getBook: (id: string) => invoke<Book | null>("get_book", { id }),
  bookmarks: (bookId?: string) => invoke<Bookmark[]>("list_bookmarks", { bookId: bookId ?? null }),
  addBookmark: (bookId: string, page: number, name: string, position?: string) =>
    invoke<void>("add_bookmark", { bookId, page, name, position: position ?? null }),
  renameBookmark: (id: string, name: string) => invoke<void>("rename_bookmark", { id, name }),
  deleteBookmark: (id: string) => invoke<void>("delete_bookmark", { id }),
  getSettings: () => invoke<string | null>("get_settings"),
  setSettings: (json: string) => invoke<void>("set_settings", { json }),
};
