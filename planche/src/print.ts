// Printing goes through the WebView's own print dialog: the pages to print are
// put in a dedicated container that is the only thing visible under @media print.

/** Parses "1-3, 7, 10-" (1-based, inclusive) into 0-based page indexes. */
export function parsePageRanges(spec: string, count: number): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(/[,;]/).map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const from = m[1] ? parseInt(m[1], 10) : 1;
      const to = m[2] ? parseInt(m[2], 10) : count;
      for (let p = Math.max(1, from); p <= Math.min(count, to); p++) pages.add(p - 1);
    } else if (/^\d+$/.test(part)) {
      const p = parseInt(part, 10);
      if (p >= 1 && p <= count) pages.add(p - 1);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

function container(): HTMLElement {
  let el = document.getElementById("print-root");
  if (!el) {
    el = document.createElement("div");
    el.id = "print-root";
    document.body.appendChild(el);
  }
  el.replaceChildren();
  return el;
}

/** Opens the print dialog and resolves once it is closed (the WebView may show it asynchronously). */
function printAndWait(root: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener("afterprint", done);
      root.replaceChildren();
      resolve();
    };
    window.addEventListener("afterprint", done);
    window.print();
  });
}

const loaded = (img: HTMLImageElement) =>
  img.complete ? Promise.resolve() : new Promise<void>((r) => ((img.onload = () => r()), (img.onerror = () => r())));

/** Prints images, one per sheet, scaled to fit. */
export async function printImages(urls: string[]) {
  const root = container();
  const imgs = urls.map((u) => {
    const img = document.createElement("img");
    img.src = u;
    img.className = "print-page";
    root.appendChild(img);
    return img;
  });
  await Promise.all(imgs.map(loaded));
  await printAndWait(root);
}

const SAFE_TAGS = new Set(
  "a abbr article aside b bdi bdo blockquote br caption cite code col colgroup dd del dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp section small span strong sub sup table tbody td tfoot th thead time tr u ul var wbr"
    .split(" "),
);
const SAFE_ATTRS = new Set(["alt", "title", "lang", "dir", "colspan", "rowspan", "class", "src", "href", "width", "height"]);

/**
 * Copies book HTML (untrusted) keeping only presentational elements and
 * attributes: no scripts, event handlers, frames, forms, styles or external
 * URLs. The document is parsed inertly, so nothing runs while sanitizing.
 */
export function sanitizeBookHtml(html: string): DocumentFragment {
  const source = new DOMParser().parseFromString(html, "text/html").body;
  const out = document.createDocumentFragment();
  const copy = (from: Node, to: Node) => {
    for (const child of from.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) to.appendChild(document.createTextNode(child.textContent ?? ""));
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.localName.toLowerCase();
      if (!SAFE_TAGS.has(tag)) {
        // Unknown wrappers keep their text; dangerous elements are dropped whole.
        if (!["script", "style", "iframe", "object", "embed", "form", "svg", "math", "template", "link", "meta", "base"].includes(tag)) copy(el, to);
        continue;
      }
      const clean = document.createElement(tag);
      for (const attr of el.attributes) {
        const name = attr.name.toLowerCase();
        if (!SAFE_ATTRS.has(name)) continue;
        // Only images already loaded by the reader (blob:) and in-book anchors.
        if (name === "src" && !/^blob:/i.test(attr.value)) continue;
        if (name === "href" && !attr.value.startsWith("#")) continue;
        clean.setAttribute(name, attr.value);
      }
      to.appendChild(clean);
      copy(el, clean);
    }
  };
  copy(source, out);
  return out;
}

/** Prints a chapter of a book with the given CSS; the HTML is sanitized first. */
export async function printHtml(html: string, css: string) {
  const root = container();
  const style = document.createElement("style");
  style.textContent = `@media print { ${css} }`;
  const body = document.createElement("div");
  body.className = "print-text";
  body.appendChild(sanitizeBookHtml(html));
  root.append(style, body);
  await Promise.all([...body.querySelectorAll("img")].map(loaded));
  await printAndWait(root);
}
