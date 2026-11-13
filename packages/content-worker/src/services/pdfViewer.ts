/**
 * How a PDF version shows in its frame (S2): a viewer page beside the PDF
 * that draws it with pdf.js, served from the version's own files like any
 * page (Porthole's shell, the frame's CSP and sandbox).
 *
 * Why a page and not the PDF itself (measured, scripts/raft-content-pdf-probe.ts):
 * the frame is `sandbox="allow-scripts allow-same-origin"` and Porthole
 * serves a PDF inert (`default-src 'none'; sandbox`). Chromium refuses any
 * PDF in a sandboxed frame ("This page has been blocked"), whatever the
 * tokens; Firefox's viewer shows it, but no shell reports to the host, so
 * Porthole's host calls the frame blocked; WebKit on Linux has no PDF viewer
 * at all. A page that draws the PDF into canvases runs under the rules every
 * page has, and nothing in the frame or its CSP is loosened for it.
 *
 * pdf.js is the pinned pdfjs-dist, carried in the Worker's bundle
 * (pdfjsAssets.ts) and served under the version as `_raft-pdf/…`: no CDN, no
 * other origin. PDF scripting (quickjs) and XFA stay off. Code in a PDF could
 * only ever run on the Artifact's own origin, which runs the Artifact's code
 * anyway.
 *
 * Over each page's canvas lies its text (pdf.js's `TextLayer`, with the few
 * rules of pdf.js's own style sheet it needs, inline: nothing is fetched for
 * it): transparent words in the page's own DOM, each where the canvas draws
 * it. That is what makes a PDF's text selectable and copyable, and what
 * Porthole's shell reads: Raft's find bar (`find`) and comments on a passage
 * (`annotate`: the selection's quote, and its mark found again by that quote)
 * work on a PDF as on any page, with no change to the frame or its CSP.
 * Checked in a browser by scripts/raft-content-pdf-text-browser-smoke.ts.
 */
import { PDFJS_ASSETS } from "./pdfjsAssets";

/** The viewer's directory under the version (its files win over a version's own at these paths). */
export const PDF_VIEWER_DIR = "_raft-pdf/";

/** The viewer page of a PDF entry: `report.pdf` opens as `report.pdf.html`, beside it. */
export const pdfViewerPath = (entry: string): string => `${entry}.html`;

type Asset = { readonly bytes: Uint8Array; readonly sha256: string };
let assets: ReadonlyMap<string, Asset> | null = null;

/** pdf.js's files by their path in the version (made once per isolate, when a PDF is first served). */
export function pdfViewerFiles(): ReadonlyMap<string, Asset> {
  if (assets === null) {
    const encoder = new TextEncoder();
    assets = new Map(
      PDFJS_ASSETS.map(([path, content, _size, sha256]) => [
        `${PDF_VIEWER_DIR}${path}`,
        { bytes: typeof content === "string" ? encoder.encode(content) : new Uint8Array(content), sha256 },
      ]),
    );
  }
  return assets;
}

const html = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/**
 * The most text spans built ahead of the reader (pages not drawn yet): a few hundred pages of prose.
 * Past it, a page's text comes with its canvas.
 */
export const TEXT_SPAN_BUDGET = 60_000;

/** A string as a JS literal inside an inline script (never closes it). */
const literal = (text: string) => JSON.stringify(text).replace(/</g, "\\u003c");

/**
 * The viewer page for `entry`: its pages one element each (`#page-N`,
 * `data-page="N"`: a stable name for each page), fit to the frame's width.
 * A page's canvas is drawn when it nears the view, and again when the width
 * or the device's pixel ratio changes. Its text is built once, with its
 * first draw: every place in it is a share of the page and every size a
 * multiple of `--total-scale-factor`, which is set with the page's width, so
 * the text stays on the canvas through a resize with nothing rebuilt. The
 * other pages' text follows one page at a time while nothing is being drawn,
 * up to TEXT_SPAN_BUDGET spans, so find and a comment's mark reach pages the
 * reader hasn't scrolled to; past the budget a page gets its text when it is
 * drawn. A page without text (a scan) is a canvas alone, as before.
 *
 * The words as Porthole reads them: the document's text is its text nodes end
 * to end, and pdf.js ends a line with a `<br>`, which is no text. So each
 * line's end gets a line feed of its own (a text node that draws nothing),
 * unless a CJK sentence goes on there, which breaks with no space; and each
 * page ends with one. Radicals are read as the ideographs they stand for
 * (Chromium's PDFs write 页 as the radical ⻚), so words typed in the find
 * bar are found.
 *
 * Relative addresses only: the page runs at the version's own address (the
 * frame's sealed files path), its files beside it.
 */
export function pdfViewerPage(entry: string, title: string): string {
  const depth = entry.split("/").length - 1;
  const up = "../".repeat(depth);
  const file = encodeURIComponent(entry.slice(entry.lastIndexOf("/") + 1));
  const name = title.trim() || entry.slice(entry.lastIndexOf("/") + 1);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(name)}</title>
<style>
:root{color-scheme:light dark}
html,body{margin:0;background:#e9e9ed}
@media (prefers-color-scheme:dark){html,body{background:#2b2a33}}
#pages{display:flex;flex-direction:column;align-items:center;gap:12px;padding:12px 8px 24px}
.page{position:relative;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);--total-scale-factor:1}
.page canvas{display:block;width:100%;height:100%}
/* pdf.js's text layer (its web/pdf_viewer.css, the rules a plain layer needs): transparent words over the canvas. */
.textLayer{color-scheme:only light;position:absolute;inset:0;overflow:clip;opacity:1;line-height:1;text-align:initial;letter-spacing:normal;word-spacing:normal;-webkit-text-size-adjust:none;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;caret-color:CanvasText;z-index:0;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor)*var(--min-font-size));--min-font-size-inv:calc(1/var(--min-font-size))}
.textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%;-webkit-user-select:text;user-select:text}
.textLayer>span{z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor)*var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
.textLayer ::selection{background:rgba(0,0,255,.25);background:color-mix(in srgb,AccentColor,transparent 50%);color:transparent}
.textLayer br::selection{background:transparent}
.textLayer .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:0;cursor:default;-webkit-user-select:none;user-select:none}
.textLayer.selecting .endOfContent{top:0}
.textLayer[data-main-rotation="90"]{transform:rotate(90deg) translateY(-100%)}
.textLayer[data-main-rotation="180"]{transform:rotate(180deg) translate(-100%,-100%)}
.textLayer[data-main-rotation="270"]{transform:rotate(270deg) translateX(-100%)}
#status{font:14px/1.5 system-ui,sans-serif;color:#5b5b66;text-align:center;margin:0;padding:32px 16px}
@media (prefers-color-scheme:dark){#status{color:#cfcfd8}}
</style></head>
<body><p id="status" role="status">Loading the PDF…</p><main id="pages" aria-label="${html(name)}"></main>
<script type="module">
import * as pdfjs from ${literal(`./${up}${PDF_VIEWER_DIR}pdf.min.mjs`)};
const here = (path) => new URL(path, document.baseURI).href;
const assets = here(${literal(`./${up}${PDF_VIEWER_DIR}`)});
pdfjs.GlobalWorkerOptions.workerSrc = assets + "pdf.worker.min.mjs";
const status = document.getElementById("status");
const box = document.getElementById("pages");
try {
  const pdf = await pdfjs.getDocument({
    url: here(${literal(`./${file}`)}),
    cMapUrl: assets + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: assets + "standard_fonts/",
    wasmUrl: assets + "wasm/",
    iccUrl: assets + "iccs/",
    enableXfa: false,
  }).promise;
  const first = await pdf.getPage(1);
  const pages = [];
  const widthOf = () => Math.min(box.clientWidth - 16, 1100);
  // What a canvas was drawn for: the page's width and the device's pixel ratio.
  const drawnFor = () => widthOf() + "@" + (window.devicePixelRatio || 1);
  const place = (view) => {
    const width = widthOf();
    view.element.style.width = width + "px";
    view.element.style.height = Math.round(width * view.ratio) + "px";
    // CSS px per PDF unit: the text's places and sizes are multiples of it, so it moves with the canvas.
    view.element.style.setProperty("--total-scale-factor", String(width / view.unit));
  };
  // A page's own shape, once it is read (until then the first page's).
  const shape = (view, page) => {
    const base = page.getViewport({ scale: 1 });
    view.ratio = base.height / base.width;
    view.unit = base.width / (page.userUnit || 1);
    place(view);
    return base;
  };
  // CJK, its punctuation and full-width forms: where a line breaks inside a sentence, with no space.
  const WIDE = "[\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF\\u{20000}-\\u{3FFFF}]";
  const wideEnd = new RegExp(WIDE + "$", "u");
  const wideStart = new RegExp("^" + WIDE, "u");
  // A sentence going on over a line's end: CJK on both sides, the same size, the next line just below.
  const continues = (a, b) =>
    wideEnd.test(a.str) && wideStart.test(b.str) && Math.abs(a.height - b.height) <= a.height * 0.05 &&
    a.transform[5] > b.transform[5] && a.transform[5] - b.transform[5] <= a.height * 2;
  // A radical read as the ideograph it stands for (Unicode's Equivalent_Unified_Ideograph; the Kangxi block's
  // is its NFKC form): a PDF printed by Chromium names a glyph by its lowest code point, which for a few
  // hundred common characters is a radical's (⻚ for 页, ⾯ for 面), and nobody types those in a find bar.
  const RADICALS = [..."⺀厂乛乚乙亻冂𠘨刀刂卜㔾小小兀尣尢𡯂巳幺彑𫜹忄心扌攵⺚旡日月歺母民氵氺灬爫爫丬牛犭王𤴔目示礻𥫗糹纟罓罒㓁冗𦉫羊𦍌𦍋耂肀聿肉𦥑艹艹艹虎衤覀西见角𧢲讠贝𧾷车辶辶辶邑钅長镸长门𨸏阝雨青韦页风飞食𩙿飠饣𩠐马骨鬼鱼鸟卤麦黄黾斉齐歯齿竜龙龜亀龟"];
  const plain = (words) => words.replace(/[\\u2E80-\\u2EF3\\u2F00-\\u2FD5]/g, (c) => (c < "\\u2F00" ? RADICALS[c.charCodeAt(0) - 0x2E80] : c.normalize("NFKC")));
  const worded = (node, step) => {
    while (node && !(node.localName === "span" && node.textContent.trim() !== "")) node = node[step];
    return node;
  };
  let spans = 0;
  // A page's text over its canvas, built once (null: the page has none, or it couldn't be read: the canvas alone).
  const write = (view) => (view.text ??= (async () => {
    const page = await pdf.getPage(view.number);
    const base = shape(view, page);
    const content = await page.getTextContent();
    content.items = content.items.filter((item) => typeof item.str === "string");
    if (!content.items.some((item) => item.str.trim() !== "")) return null;
    for (const item of content.items) item.str = plain(item.str);
    const layer = document.createElement("div");
    layer.className = "textLayer";
    const viewport = page.getViewport({ scale: widthOf() / base.width });
    const text = new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport });
    await text.render();
    // The page's size as a multiple of the scale (pdf.js gives the same with CSS round(), which older browsers lack).
    layer.style.width = "calc(var(--total-scale-factor) * " + viewport.rawDims.pageWidth + "px)";
    layer.style.height = "calc(var(--total-scale-factor) * " + viewport.rawDims.pageHeight + "px)";
    // A line's end is a line feed in the text (one that draws nothing), unless its sentence goes on with no space.
    const itemOf = new Map(text.textDivs.map((span, index) => [span, content.items[index]]));
    for (const br of layer.querySelectorAll("br")) {
      const before = worded(br.previousSibling, "previousSibling");
      const after = worded(br.nextSibling, "nextSibling");
      if (!(before && after && continues(itemOf.get(before), itemOf.get(after)))) br.before("\\n");
    }
    const end = document.createElement("div");
    end.className = "endOfContent";
    layer.append("\\n", end);
    view.element.append(layer);
    // No longer a picture alone: its words are in it.
    view.element.setAttribute("role", "group");
    if (view.canvas) view.canvas.setAttribute("aria-hidden", "true");
    spans += text.textDivs.length;
    return text;
  })().catch(() => null));
  const draw = async (view) => {
    const width = widthOf();
    const wanted = drawnFor();
    if (view.drawn === wanted || view.drawing) return;
    view.drawing = true;
    try {
      const page = await pdf.getPage(view.number);
      const base = shape(view, page);
      const written = write(view);
      const viewport = page.getViewport({ scale: (width / base.width) * (window.devicePixelRatio || 1) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      if (view.canvas) view.canvas.replaceWith(canvas);
      else view.element.prepend(canvas);
      view.canvas = canvas;
      view.drawn = wanted;
      const text = await written;
      if (text) {
        canvas.setAttribute("aria-hidden", "true");
        // Its spans' widths, measured again at this size (their places and sizes already follow the scale).
        text.update({ viewport: page.getViewport({ scale: width / base.width }) });
      }
    } finally {
      view.drawing = false;
    }
    if (view.drawn !== drawnFor() && view.near) draw(view);
  };
  // The document as the root: a frame's implicit root is the top page's viewport, which ignores rootMargin.
  const near = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const view = pages[Number(entry.target.dataset.page) - 1];
      view.near = entry.isIntersecting;
      if (view.near) draw(view).catch(fail);
    }
  }, { root: document, rootMargin: "150% 0px" });
  const firstBase = first.getViewport({ scale: 1 });
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const element = document.createElement("div");
    element.className = "page";
    element.id = "page-" + number;
    element.dataset.page = String(number);
    element.setAttribute("role", "img");
    element.setAttribute("aria-label", "Page " + number + " of " + pdf.numPages);
    const view = { number, element, ratio: firstBase.height / firstBase.width, unit: firstBase.width / (first.userUnit || 1), drawn: "", drawing: false, near: false, canvas: null, text: null };
    pages.push(view);
    place(view);
    box.append(element);
    near.observe(element);
  }
  status.hidden = true;
  // Not part of the document's text, which find and comments read.
  status.textContent = "";
  let resized = 0;
  new ResizeObserver(() => {
    clearTimeout(resized);
    resized = setTimeout(() => {
      for (const view of pages) {
        place(view);
        if (view.near) draw(view).catch(fail);
      }
    }, 150);
  }).observe(box);
  // While the pointer selects, a text layer the selection is in is covered by its .endOfContent, under its
  // words: with the pointer between two lines or in a margin the selection then stays as it was, where it
  // would jump to the page's first or last word (pdf.js's viewer's own way, without its moves of that
  // element for older engines).
  let selecting = false;
  const settle = () => {
    selecting = false;
    for (const layer of box.querySelectorAll(".textLayer.selecting")) layer.classList.remove("selecting");
  };
  box.addEventListener("mousedown", (event) => {
    const layer = event.target instanceof Element ? event.target.closest(".textLayer") : null;
    selecting = layer !== null;
    if (layer) layer.classList.add("selecting");
  });
  document.addEventListener("pointerup", settle);
  window.addEventListener("blur", settle);
  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    if (!selecting || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    for (const layer of box.querySelectorAll(".textLayer")) layer.classList.toggle("selecting", range.intersectsNode(layer));
  });
  // Every other page's text, in order, one page at a time and never while a page is being drawn.
  const idle = () => new Promise((done) => (window.requestIdleCallback ? window.requestIdleCallback(done, { timeout: 400 }) : setTimeout(done, 40)));
  (async () => {
    for (const view of pages) {
      do await idle(); while (pages.some((each) => each.drawing));
      if (spans >= ${TEXT_SPAN_BUDGET}) return;
      await write(view);
    }
  })();
} catch (error) {
  fail(error);
}
function fail(error) {
  status.hidden = false;
  status.textContent = error && error.name === "PasswordException"
    ? "This PDF is protected by a password, so it can't be shown here."
    : "This PDF couldn't be shown: " + (error && error.message ? error.message : String(error));
}
</script></body></html>
`;
}
