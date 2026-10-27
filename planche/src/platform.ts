// Platform differences. On Android, library folders and files come from the
// system picker (Storage Access Framework) as content:// documents, and
// exports are written through it; printing and window fullscreen do not exist.
import { invoke } from "@tauri-apps/api/core";

export const isAndroid = /Android/i.test(navigator.userAgent);

export interface Picked {
  path: string;
  name: string;
}

/** Runs an Android picker; null when the user backs out. */
async function pick(command: string, args?: Record<string, unknown>): Promise<Picked | null> {
  try {
    return await invoke<Picked>(`plugin:planche-storage|${command}`, args);
  } catch (e) {
    if (String(e).includes("cancelled")) return null;
    throw e;
  }
}

export const pickFolder = () => pick("pick_folder");
export const pickFile = () => pick("pick_file");
/** Asks where to save, then writes `content` there. */
export const saveDocument = (name: string, mimeType: string, content: string) =>
  pick("save_document", { name, mimeType, content });
