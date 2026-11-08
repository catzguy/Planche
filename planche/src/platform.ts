// Platform differences. File and folder pickers run in the backend on every
// platform (system dialog on the desktop, Storage Access Framework picker on
// Android, where they return content:// documents): the page only learns the
// paths the user chose, and the backend accepts no other. On Android, printing
// and window fullscreen do not exist.
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

export const isAndroid = /Android/i.test(navigator.userAgent);

export interface Picked {
  path: string;
  name: string;
}

/** Book file picker; null when the user backs out. */
export const pickFile = () =>
  invoke<Picked | null>("pick_file", { title: t("library.openFileTitle"), filter: t("library.fileFilter") });
/** Library folder picker; null when the user backs out. */
export const pickFolder = () => invoke<Picked | null>("pick_folder", { title: t("library.chooseFolder") });
