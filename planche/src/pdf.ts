// The legacy build polyfills the newest JavaScript APIs that the modern build
// calls unguarded (Map.getOrInsertComputed, Math.sumPrecise…), which WebKit
// engines (WebKitGTK on Linux, macOS) may not have yet.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { api, rawUrl } from "./api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDoc = pdfjs.PDFDocumentProxy;

export const loadPdf = (bookId: string) => pdfjs.getDocument({ url: rawUrl(bookId) }).promise;

/** Renders a page to a JPEG blob, `width` CSS pixels wide. */
export async function renderPdfPage(doc: PdfDoc, index: number, width: number): Promise<Blob> {
  const page = await doc.getPage(index + 1);
  const unscaled = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / unscaled.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas export failed"))), "image/jpeg", 0.9),
  );
}

let queue: Promise<void> = Promise.resolve();
const queued = new Set<string>();

/** Generates thumbnail + page count for a PDF book, one at a time. */
export function queuePdfThumbnail(bookId: string, onDone: () => void) {
  if (queued.has(bookId)) return;
  queued.add(bookId);
  queue = queue.then(async () => {
    try {
      const doc = await loadPdf(bookId);
      await api.setPageCount(bookId, doc.numPages);
      const blob = await renderPdfPage(doc, 0, 300);
      await api.saveThumbnail(bookId, Array.from(new Uint8Array(await blob.arrayBuffer())));
      await doc.loadingTask.destroy();
    } catch (e) {
      console.warn("PDF thumbnail failed", bookId, e);
      await api.saveThumbnail(bookId, []).catch(() => {});
    }
    onDone();
  });
}
