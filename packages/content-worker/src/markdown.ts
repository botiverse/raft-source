import { ARTIFACT_PAGE_CARD_MIN_WIDTH_PX, ARTIFACT_PAGE_COLORS, ARTIFACT_PAGE_THEME_VARIABLES, artifactPageVariable } from "@botiverse/raft-shared/src/artifactPageTheme";
import type { ArtifactPageToken } from "@botiverse/raft-shared/src/artifactPageTheme";
import { marked, type Tokens } from "marked";

/**
 * Markdown → a whole HTML page, served on the artifact's own content origin
 * through Porthole exactly like an HTML version (the same config, CSP and
 * tickets). Nothing is sanitized: raw HTML in the Markdown is kept and runs,
 * as on Claude's Markdown artifacts; the content origin is the boundary.
 *
 * Look: the Raft Design System's reading surface. With no theme the document
 * sits on white paper with no card; with one, on a screen wide enough to leave
 * wide empty space on both sides of the column (ARTIFACT_PAGE_CARD_MIN_WIDTH_PX),
 * it sits in a card on the sidebar's ground, as the attachment Markdown preview
 * does (attachmentPreviewSurfaces.tsx `MarkdownPreviewPane`: same card, same
 * relation to the outline, which stays on the ground beside it); narrower, it
 * sits on the canvas as with no theme, no tint and no card. Code blocks,
 * tables and diagrams share the code-block container (a hairline, 10px radius),
 * a sticky left outline column (indented items), mermaid diagrams via the
 * vendored bundle. The content origin loads no
 * app CSS, so every colour is a variable the host's theme fills in, with the
 * @botiverse/raft-ui light value inlined as its fallback (`pageColor`): a page
 * with no theme (a host that sends none, or no host at all) looks as it always
 * has. The variables reach the page the way any of Porthole's do, and are
 * colours only; packages/shared/src/artifactPageTheme.ts says why they are
 * Raft's names and not Porthole's.
 */

/** A colour of the page: Raft's token through the host's theme, else its light value. */
function pageColor(token: ArtifactPageToken): string {
  return `var(${artifactPageVariable(token)}, ${ARTIFACT_PAGE_COLORS[token]})`;
}
const CANVAS = pageColor("--layer-canvas");
const GROUND = pageColor("--layer-sidebar");
const CARD = pageColor("--layer-card");
const CODE_LAYER = pageColor("--layer-code");
const BACKDROP = pageColor("--layer-backdrop");
const INK = pageColor("--foreground");
const MUTED = pageColor("--foreground-muted");
const HINT = pageColor("--foreground-hint");
const LINK = pageColor("--foreground-link");
const HAIRLINE = pageColor("--line-hairline");
const SEAM = pageColor("--line-seam");
const FILL_MUTED = pageColor("--fill-muted");
const FILL_MEDIUM = pageColor("--fill-medium");
const BRAND = pageColor("--brand-400");
const ON_BRAND = pageColor("--sticker-ink");
const WARNING_SOFT = pageColor("--warning-soft");

/** Paper takes no theme: on print every colour is its light value, over the host's inline ones. */
const PRINT_COLORS = Object.entries(ARTIFACT_PAGE_THEME_VARIABLES)
  .map(([name, value]) => `${name}: ${value} !important;`)
  .join(" ");

/**
 * Raft's faces, from the page's own origin: the files are served beside the page, under the
 * version, as the PDF viewer's `_raft-pdf/` are (services/markdownFonts.ts), so the frame's CSP,
 * which opens `font-src` to the version's own files, already allows them, and nothing is loaded
 * from another origin. They win over a version's own files at these paths.
 */
export const MARKDOWN_FONTS_DIR = "_raft-fonts/";

// Google Fonts' latin and latin-ext ranges, as the web's fonts.css has them.
const LATIN_EXT =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF";
const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";

/**
 * The faces a Markdown page declares: the web's own files (packages/web/src/assets/fonts), the
 * latin and latin-ext subsets only (Space Grotesk variable 300..700, Space Mono 400 and 700), each
 * with its SHA-256 (its ETag; test/markdown-fonts.test.ts checks it against the bytes). A browser
 * fetches a file only when the page draws a character in its range.
 */
export const MARKDOWN_FONT_FACES = [
  { file: "space-grotesk-latin-ext.woff2", family: "Space Grotesk", weight: "300 700", range: LATIN_EXT, sha256: "054c266fbb441ee059365dba0885d206f67ca05b375de869b88e02ebfccc9b9d" },
  { file: "space-grotesk-latin.woff2", family: "Space Grotesk", weight: "300 700", range: LATIN, sha256: "a0d054c4af557de20afd6ca59f47ab353bcaec49c63ff04b6c9d39d0f8910557" },
  { file: "space-mono-latin-ext-400.woff2", family: "Space Mono", weight: "400", range: LATIN_EXT, sha256: "b4f90459adf4851575a46d9a492c17ee34c97fe40d56979521de67d1ee77d75a" },
  { file: "space-mono-latin-400.woff2", family: "Space Mono", weight: "400", range: LATIN, sha256: "e0c8e616bda27642f4c3cebaecff6525d901e73afc8a227cbbb0f2af4810f300" },
  { file: "space-mono-latin-ext-700.woff2", family: "Space Mono", weight: "700", range: LATIN_EXT, sha256: "512458b32bf452ac0e4b33fd6277bf4f07821acefb59db2d1498aa107679a1a6" },
  { file: "space-mono-latin-700.woff2", family: "Space Mono", weight: "700", range: LATIN, sha256: "af7cf6d2b897ec453acdcdacde4e9bcc8410718af5914de865b453e09f10eebc" },
] as const;

/** The page's `@font-face` rules, each file by a relative address from the page's directory (`up`). */
function fontFaces(up: string): string {
  return MARKDOWN_FONT_FACES.map(({ file, family, weight, range }) =>
    `  @font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; font-display: swap;
    src: url(./${up}${MARKDOWN_FONTS_DIR}${file}) format('woff2'); unicode-range: ${range}; }`).join("\n");
}

/**
 * raft-ui's font variables (its fonts.css after the Google Fonts import), verbatim, as the web's
 * fonts.css carries them (copied by hand: no test compares the two): CJK falls back to the
 * system's Chinese faces, and a page whose `lang` is Traditional Chinese, Japanese or Korean to
 * that language's own first.
 */
export const FONT_VARIABLES = `  :where(:root) {
    --heading-font:
      "Space Grotesk", Arial, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
      "Noto Sans SC", "Noto Sans CJK SC", system-ui, sans-serif;
    --sans-font:
      "Space Grotesk", Arial, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
      "Noto Sans SC", "Noto Sans CJK SC", system-ui, sans-serif;
    --mono-font: "Space Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
  :where(:root:lang(zh-TW), :root:lang(zh-HK), :root:lang(zh-MO), :root:lang(zh-Hant)) {
    --heading-font:
      "Space Grotesk", Arial, "Helvetica Neue", "PingFang TC", "Microsoft JhengHei UI",
      "Microsoft JhengHei", "Noto Sans TC", "Noto Sans CJK TC", system-ui, sans-serif;
    --sans-font:
      "Space Grotesk", Arial, "Helvetica Neue", "PingFang TC", "Microsoft JhengHei UI",
      "Microsoft JhengHei", "Noto Sans TC", "Noto Sans CJK TC", system-ui, sans-serif;
  }
  :where(:root:lang(ja)) {
    --heading-font:
      "Space Grotesk", Arial, "Helvetica Neue", "Hiragino Sans", "Hiragino Kaku Gothic ProN",
      "Yu Gothic UI", Meiryo, "Noto Sans JP", "Noto Sans CJK JP", system-ui, sans-serif;
    --sans-font:
      "Space Grotesk", Arial, "Helvetica Neue", "Hiragino Sans", "Hiragino Kaku Gothic ProN",
      "Yu Gothic UI", Meiryo, "Noto Sans JP", "Noto Sans CJK JP", system-ui, sans-serif;
  }
  :where(:root:lang(ko)) {
    --heading-font:
      "Space Grotesk", Arial, "Helvetica Neue", "Apple SD Gothic Neo", "Malgun Gothic",
      "Noto Sans KR", "Noto Sans CJK KR", system-ui, sans-serif;
    --sans-font:
      "Space Grotesk", Arial, "Helvetica Neue", "Apple SD Gothic Neo", "Malgun Gothic",
      "Noto Sans KR", "Noto Sans CJK KR", system-ui, sans-serif;
  }`;

// Common characters written differently in Traditional and Simplified Chinese, pair by pair.
const TRADITIONAL = new Set("這個們來說時會國對學為過還開關實點現發經應動間從樣體機長問題讓給線頁號嗎歷業務員圖書寫讀語話電腦網檔設計資訊處統選擇換");
const SIMPLIFIED = new Set("这个们来说时会国对学为过还开关实点现发经应动间从样体机长问题让给线页号吗历业务员图书写读语话电脑网档设计资讯处统选择换");

/**
 * The page's `lang`, from its words: `ja` where there is kana, `ko` where Hangul is most of it,
 * else `zh-CN` (`zh-TW` where Traditional forms clearly outnumber Simplified ones) once CJK is a
 * fifth of the letters; otherwise `en`. Code, tags and link targets don't count. It picks the CJK
 * faces the font variables fall back to, and tells a screen reader how to read the page.
 */
export function pageLangOf(markdown: string): string {
  const prose = markdown
    .replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<[^>\n]*>/g, " ")
    .replace(/\]\([^)\n]*\)/g, "]");
  let han = 0, kana = 0, hangul = 0, latin = 0, traditional = 0, simplified = 0;
  for (const char of prose) {
    if (/\p{Script=Han}/u.test(char)) {
      han += 1;
      if (TRADITIONAL.has(char)) traditional += 1;
      else if (SIMPLIFIED.has(char)) simplified += 1;
    } else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) kana += 1;
    else if (/\p{Script=Hangul}/u.test(char)) hangul += 1;
    else if (/\p{Script=Latin}/u.test(char)) latin += 1;
  }
  const cjk = han + kana + hangul;
  if (cjk === 0 || cjk * 5 < cjk + latin) return "en";
  if (hangul * 2 >= cjk) return "ko";
  if (kana * 20 >= cjk) return "ja";
  return traditional >= 3 && traditional > simplified * 2 ? "zh-TW" : "zh-CN";
}

type OutlineItem = { id: string; level: number; title: string };

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "section";
}

/**
 * Mermaid, pinned to the exact build the app used to vendor (same bytes,
 * SHA-256 18327bef…), from jsDelivr, which the content CSP already allows for
 * scripts; the integrity hash means the CDN can't change it.
 */
export const MERMAID_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.16.1/dist/mermaid.min.js";
export const MERMAID_SCRIPT_INTEGRITY = "sha384-aBQXj4hK6Jm05i7aQAsUV3bLdSUrHX1BGYfMB0166TtWt/RRaw+h0Eelme9OCOvy";

/** Mermaid fences render in the page, only when the document has one. */
function hasMermaid(markdown: string): boolean {
  return /^\s*(?:```|~~~)mermaid\s*$/m.test(markdown);
}

/**
 * Reading a colour in a script (shared by the two below). The tokens are oklch and some are
 * see-through, which neither a luminance sum nor Mermaid's colour parser can read: a canvas paints
 * the colour, over `under`, and says what came out. A colour it can't parse, or an unset variable,
 * leaves `under`.
 */
const COLOR_PROBE = `
  var probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  function themeColor(token) {
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  }
  function painted(color, under) {
    if (!probe) return [255, 255, 255];
    probe.fillStyle = under;
    probe.fillRect(0, 0, 1, 1);
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    var data = probe.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2]];
  }`;

/**
 * What the page's colours say, on the root, for the CSS and for Mermaid. The shell writes the
 * variables on the root's `style`, on the first host context and each theme change, and the first
 * brings no event (P061), so the attribute is watched.
 *
 * `data-raft-card`: the host's ground and card differ, so there is a theme to draw the card in. It
 * decides the card's geometry, which no theme can send (a page gets colours only) and no colour
 * fallback can take back: padding would move the text of a page with no theme. Without a theme the
 * two are the same white, whether the shell set them to the config's defaults (a public page) or
 * set neither (an older host, a check's page with no host), so the attribute is never set and no
 * card rule matches.
 *
 * `data-raft-surface`: the surface the document sits on is dark, for the browser's dark scrollbars
 * and form controls, and Mermaid's colours. Read from `.doc` as it is painted, as that is the card,
 * or the canvas on a phone or with no theme, and the CSS is what says which. The page declares no
 * `color-scheme` meta, on purpose: then Porthole would set `color-scheme` from the person's mode
 * even under a host that sends no colours, on a white page (P039).
 */
const SURFACE_SCRIPT = `
<script>
(function () {
  "use strict";${COLOR_PROBE}
  var root = document.documentElement;
  var doc = document.querySelector(".doc");
  function followSurface() {
    var ground = painted(themeColor("${artifactPageVariable("--layer-sidebar")}"), "#fff");
    var card = painted(themeColor("${artifactPageVariable("--layer-card")}"), "#fff");
    if (ground.join() !== card.join()) root.setAttribute("data-raft-card", "");
    else root.removeAttribute("data-raft-card");
    var rgb = painted(getComputedStyle(doc).backgroundColor, "#fff");
    if (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128) root.setAttribute("data-raft-surface", "dark");
    else root.removeAttribute("data-raft-surface");
  }
  followSurface();
  new MutationObserver(followSurface).observe(root, { attributes: true, attributeFilter: ["style"] });
}());
</script>`;

const MERMAID_SCRIPTS = `
<script src="${MERMAID_SCRIPT_URL}" integrity="${MERMAID_SCRIPT_INTEGRITY}" crossorigin="anonymous"></script>
<script>
(function () {
  "use strict";${COLOR_PROBE}

  var labels = {
    diagram: "Diagram",
    code: "Code",
    previewMode: "Mermaid preview mode",
    zoomControls: "Mermaid zoom controls",
    zoomOut: "Zoom out Mermaid diagram",
    zoomIn: "Zoom in Mermaid diagram",
    copy: "Copy Mermaid source",
    copied: "Copied Mermaid source",
    copyError: "Couldn't copy Mermaid source",
    fullscreen: "Open Mermaid diagram fullscreen",
    closeFullscreen: "Close Mermaid diagram fullscreen",
    rendering: "Rendering diagram…",
    renderError: "Couldn't render this diagram"
  };

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function actionButton(label, symbol) {
    var button = element("button", "mermaid-action");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    var icon = element("span", "mermaid-action-icon", symbol);
    icon.setAttribute("aria-hidden", "true");
    button.appendChild(icon);
    return button;
  }

  // The page can't write the clipboard itself (Porthole P051): the viewer
  // copies in the reader's click through copyText, and shows what it copied.
  async function copySource(text) {
    if (typeof copyText !== "function" || !(await copyText(text))) throw new Error(labels.copyError);
  }

  function makeToolbar(source, controls) {
    var toolbar = element("div", "mermaid-toolbar");
    toolbar.setAttribute("data-testid", "mermaid-toolbar");

    var views = element("div", "mermaid-toolbar-views");
    views.setAttribute("role", "group");
    views.setAttribute("aria-label", labels.previewMode);
    var diagramTab = element("button", "mermaid-tab is-active", labels.diagram);
    diagramTab.type = "button";
    diagramTab.setAttribute("aria-pressed", "true");
    var codeTab = element("button", "mermaid-tab", labels.code);
    codeTab.type = "button";
    codeTab.setAttribute("aria-pressed", "false");
    views.append(diagramTab, codeTab);
    toolbar.appendChild(views);

    var zoom = element("div", "mermaid-toolbar-zoom");
    zoom.setAttribute("role", "group");
    zoom.setAttribute("aria-label", labels.zoomControls);
    var zoomOut = actionButton(labels.zoomOut, "−");
    var zoomIn = actionButton(labels.zoomIn, "+");
    zoom.append(zoomOut, zoomIn);
    toolbar.appendChild(zoom);

    // No downloads: a page on its content origin can't start one.
    var copy = actionButton(labels.copy, "⧉");
    var fullscreen = actionButton(labels.fullscreen, "⛶");
    toolbar.append(copy, fullscreen);

    function setView(view) {
      var diagram = view === "diagram";
      controls.diagramPanel.hidden = !diagram;
      controls.sourcePanel.hidden = diagram;
      zoom.hidden = !diagram;
      fullscreen.hidden = !diagram;
      diagramTab.classList.toggle("is-active", diagram);
      codeTab.classList.toggle("is-active", !diagram);
      diagramTab.setAttribute("aria-pressed", String(diagram));
      codeTab.setAttribute("aria-pressed", String(!diagram));
      controls.alert.hidden = true;
    }

    diagramTab.addEventListener("click", function () { setView("diagram"); });
    codeTab.addEventListener("click", function () { setView("code"); });
    zoomOut.addEventListener("click", function () { controls.zoomBy(1 / 1.2); });
    zoomIn.addEventListener("click", function () { controls.zoomBy(1.2); });
    fullscreen.addEventListener("click", controls.openFullscreen);
    copy.addEventListener("click", async function () {
      controls.alert.hidden = true;
      try {
        await copySource(source);
        copy.setAttribute("aria-label", labels.copied);
        copy.title = labels.copied;
        copy.querySelector("span").textContent = "✓";
        setTimeout(function () {
          copy.setAttribute("aria-label", labels.copy);
          copy.title = labels.copy;
          copy.querySelector("span").textContent = "⧉";
        }, 1600);
      } catch (_) {
        controls.showAlert(labels.copyError);
      }
    });
    controls.setDiagramActionsEnabled = function (enabled) {
      zoomOut.disabled = !enabled;
      zoomIn.disabled = !enabled;
      fullscreen.disabled = !enabled;
    };
    controls.setDiagramActionsEnabled(false);
    return toolbar;
  }

  // Each diagram's draw, for a new theme to run again.
  var draws = [];

  function mountDiagram(code, index) {
    var source = code.textContent || "";
    var originalPre = code.parentElement;
    if (!originalPre) return;

    var root = element("div", "mermaid-diagram");
    originalPre.parentNode.insertBefore(root, originalPre);
    root.dataset.mermaidStatus = "loading";
    var diagramPanel = element("div", "mermaid-diagram-panel");
    var viewport = element("div", "mermaid-viewport");
    viewport.setAttribute("data-testid", "mermaid-pan-zoom-viewport");
    var stage = element("div", "mermaid-stage");
    var canvas = element("div", "mermaid-canvas");
    var status = element("div", "mermaid-status", labels.rendering);
    status.setAttribute("role", "status");
    canvas.appendChild(status);
    stage.appendChild(canvas);
    viewport.appendChild(stage);
    diagramPanel.appendChild(viewport);

    var sourcePanel = element("div", "mermaid-source");
    sourcePanel.hidden = true;
    sourcePanel.appendChild(originalPre);
    var alert = element("p", "mermaid-alert");
    alert.setAttribute("role", "alert");
    alert.hidden = true;
    var renderedSvg = "";
    var scale = 1;
    // The rendered diagram's own size (its viewBox), once rendered.
    var natural = null;
    var MIN_HEIGHT = 96;

    // The diagram fits the box's width (never enlarged); the box is as tall
    // as the fitted diagram, between MIN_HEIGHT and most of the window (a
    // taller diagram scrolls); zoom scales the diagram inside the box.
    function layout() {
      var svg = canvas.querySelector("svg");
      if (!natural || !svg) return;
      var style = getComputedStyle(canvas);
      var padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      var padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      var fit = Math.min(1, (viewport.clientWidth - padX) / natural.width);
      var maxHeight = Math.max(240, Math.min(640, window.innerHeight * 0.75));
      viewport.style.height = Math.round(Math.min(maxHeight, Math.max(MIN_HEIGHT, natural.height * fit + padY))) + "px";
      svg.style.maxWidth = "none";
      svg.style.width = natural.width * fit * scale + "px";
      svg.style.height = natural.height * fit * scale + "px";
    }
    var laidOutWidth = 0;
    new ResizeObserver(function () {
      if (viewport.clientWidth === laidOutWidth) return;
      laidOutWidth = viewport.clientWidth;
      layout();
    }).observe(viewport);

    var fullscreen = element("div", "mermaid-fullscreen");
    fullscreen.hidden = true;
    fullscreen.setAttribute("data-testid", "mermaid-fullscreen");
    fullscreen.setAttribute("role", "dialog");
    fullscreen.setAttribute("aria-modal", "true");
    fullscreen.setAttribute("aria-label", labels.fullscreen);
    var fullscreenPanel = element("div", "mermaid-fullscreen-panel");
    var fullscreenCanvas = element("div", "mermaid-fullscreen-canvas");
    var close = actionButton(labels.closeFullscreen, "×");
    close.classList.add("mermaid-fullscreen-close");
    fullscreenPanel.append(close, fullscreenCanvas);
    fullscreen.appendChild(fullscreenPanel);

    function closeFullscreen() {
      fullscreen.hidden = true;
      document.body.classList.remove("mermaid-modal-open");
    }
    close.addEventListener("click", closeFullscreen);
    fullscreen.addEventListener("click", function (event) {
      if (event.target === fullscreen) closeFullscreen();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !fullscreen.hidden) closeFullscreen();
    });

    var controls = {
      diagramPanel: diagramPanel,
      sourcePanel: sourcePanel,
      alert: alert,
      canvas: canvas,
      svg: function () { return renderedSvg; },
      showAlert: function (message) {
        alert.textContent = message;
        alert.hidden = false;
      },
      zoomBy: function (factor) {
        scale = Math.max(0.25, Math.min(4, scale * factor));
        layout();
      },
      openFullscreen: function () {
        if (!renderedSvg) return;
        fullscreenCanvas.innerHTML = renderedSvg;
        fullscreen.hidden = false;
        document.body.classList.add("mermaid-modal-open");
        close.focus();
      }
    };
    var toolbar = makeToolbar(source, controls);
    root.append(toolbar, diagramPanel, sourcePanel, alert, fullscreen);

    // A new id each time: Mermaid first removes what has the id, here the diagram on screen.
    draws.push(async function (run) {
      try {
        var result = await mermaid.render("artifact-mermaid-" + index + "-" + run, source);
        renderedSvg = result.svg;
        canvas.innerHTML = result.svg;
        if (!fullscreen.hidden) fullscreenCanvas.innerHTML = result.svg;
        canvas.querySelectorAll("a").forEach(function (link) {
          link.setAttribute("target", "_blank");
          link.setAttribute("rel", "noopener noreferrer");
        });
        var box = canvas.querySelector("svg") && canvas.querySelector("svg").viewBox.baseVal;
        if (box && box.width > 0 && box.height > 0) natural = { width: box.width, height: box.height };
        layout();
        root.dataset.mermaidStatus = "valid";
        controls.setDiagramActionsEnabled(true);
        if (typeof result.bindFunctions === "function") result.bindFunctions(canvas);
      } catch (error) {
        console.error("[Mermaid] render failed", error);
        canvas.textContent = "";
        var failure = element("div", "mermaid-render-error", labels.renderError);
        failure.setAttribute("role", "alert");
        canvas.appendChild(failure);
        root.dataset.mermaidStatus = "error";
      }
    });
  }

  function hex(rgb) {
    return "#" + rgb.map(function (channel) { return channel.toString(16).padStart(2, "0"); }).join("");
  }

  // A light surface draws in Mermaid's neutral theme, as it always has: every Raft theme keeps the
  // same paper and ink in light. A dark one draws in the page's colours, through its base theme, as
  // the app's own diagrams do (mermaidRenderer.ts): its built-in dark has colours of its own.
  function mermaidTheme() {
    if (document.documentElement.getAttribute("data-raft-surface") !== "dark") return { theme: "neutral" };
    var background = hex(painted(themeColor("${artifactPageVariable("--layer-code")}"), "#000"));
    var surface = hex(painted(themeColor("${artifactPageVariable("--fill-muted")}"), background));
    var border = hex(painted(themeColor("${artifactPageVariable("--line-seam")}"), background));
    var foreground = hex(painted(themeColor("${artifactPageVariable("--foreground")}"), background));
    return {
      theme: "base",
      themeVariables: {
        darkMode: true,
        background: background,
        primaryColor: surface,
        primaryTextColor: foreground,
        primaryBorderColor: border,
        lineColor: foreground,
        secondaryColor: surface,
        secondaryTextColor: foreground,
        tertiaryColor: background,
        tertiaryTextColor: foreground,
        textColor: foreground,
        edgeLabelBackground: background,
        noteBkgColor: surface,
        noteTextColor: foreground,
        noteBorderColor: border
      }
    };
  }

  // Mermaid's config is global, so a theme is set between draws, never during one.
  var themed = null;
  function setTheme() {
    var theme = mermaidTheme();
    var key = JSON.stringify(theme);
    if (key === themed) return false;
    themed = key;
    // Labels wrap at 320px, not Mermaid's 200: a host name or path fits on one
    // line (wrapped, it breaks at its hyphens); longer text still wraps.
    mermaid.initialize(Object.assign({ startOnLoad: false, securityLevel: "strict", flowchart: { wrappingWidth: 320 } }, theme));
    return true;
  }

  var drawRun = 0;
  async function drawDiagrams() {
    drawRun += 1;
    for (var index = 0; index < draws.length; index += 1) await draws[index](drawRun);
  }

  // First, before a fence is touched: if the library didn't load this throws, and the code stays.
  setTheme();
  Array.from(document.querySelectorAll("pre > code.language-mermaid")).forEach(mountDiagram);
  var drawing = drawDiagrams();
  // SVG can't follow the variables: a theme that changes Mermaid's colours draws every diagram
  // again, one job at a time. One that doesn't (a light theme for another) draws none.
  new MutationObserver(function () {
    drawing = drawing.then(function () { return setTheme() ? drawDiagrams() : undefined; });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-raft-surface"] });
}());
</script>`;

const CODE_COPY_SCRIPT = `
<script>
(function () {
  "use strict";
  // Copy buttons go through copyText: the page can't write the clipboard
  // itself (Porthole P051); the viewer copies and shows what it copied.
  Array.from(document.querySelectorAll(".doc pre")).forEach(function (pre) {
    if (pre.closest(".mermaid-source")) return;
    var wrapper = document.createElement("div");
    wrapper.className = "code-block";
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);
    var button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.setAttribute("aria-label", "Copy code");
    button.title = "Copy code";
    button.textContent = "⧉";
    button.addEventListener("click", async function () {
      if (typeof copyText !== "function" || !(await copyText(pre.textContent || ""))) return;
      button.textContent = "✓";
      button.setAttribute("aria-label", "Copied code");
      button.title = "Copied code";
      setTimeout(function () {
        button.textContent = "⧉";
        button.setAttribute("aria-label", "Copy code");
        button.title = "Copy code";
      }, 1400);
    });
    wrapper.appendChild(button);
  });
}());
</script>`;

/**
 * An image in the document opens over the page, as big as the page allows (#proj-workspace:#288, xxchan: agents put
 * pictures in Markdown that can't be made big enough to read, and can't be opened). The viewer is the page's own, as a
 * Mermaid diagram's full screen is: a frame can't draw outside itself, and in the viewer it fills the Artifact's area.
 * It zooms with the buttons, the wheel, a trackpad pinch (the wheel with ctrl, or Safari's gesture events) and two
 * fingers, round the point under them; drags to pan; double-click toggles fit and actual size; Esc, × or a click on the
 * backdrop closes it. An image inside a link stays the link's. While picking something to comment on, Porthole takes
 * the click first, so the pick wins.
 */
const IMAGE_VIEWER_SCRIPT = `
<script>
(function () {
  "use strict";
  var labels = { open: "Open image", viewer: "Image", close: "Close image", zoomIn: "Zoom in", zoomOut: "Zoom out" };
  var images = Array.from(document.querySelectorAll(".doc img")).filter(function (img) {
    return !img.closest("a") && !img.closest(".mermaid-diagram");
  });
  if (images.length === 0) return;

  function element(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }
  function button(label, symbol, className) {
    var node = element("button", "image-viewer-action " + className);
    node.type = "button";
    node.setAttribute("aria-label", label);
    node.title = label;
    node.textContent = symbol;
    return node;
  }

  var viewer = element("div", "image-viewer");
  viewer.hidden = true;
  viewer.setAttribute("role", "dialog");
  viewer.setAttribute("aria-modal", "true");
  viewer.setAttribute("aria-label", labels.viewer);
  viewer.setAttribute("data-testid", "image-viewer");
  var stage = element("div", "image-viewer-stage");
  var shown = element("img", "image-viewer-image");
  shown.alt = "";
  shown.draggable = false;
  stage.appendChild(shown);
  var bar = element("div", "image-viewer-bar");
  var zoomOut = button(labels.zoomOut, "−", "image-viewer-zoom-out");
  var zoomIn = button(labels.zoomIn, "+", "image-viewer-zoom-in");
  var close = button(labels.close, "×", "image-viewer-close");
  bar.append(zoomOut, zoomIn, close);
  viewer.append(stage, bar);
  document.body.appendChild(viewer);

  // The image's natural size, the scale that fits it in the stage (never above 1), and where it is: scale and offset.
  var natural = { w: 1, h: 1 };
  var fit = 1;
  var view = { s: 1, x: 0, y: 0 };
  var opener = null;

  function stageSize() { return { w: stage.clientWidth, h: stage.clientHeight }; }
  function bounds() { return { min: fit, max: Math.max(fit * 8, 4) }; }
  // Smaller than the stage on an axis: centred on it. Larger: its edges never come inside the stage.
  function place() {
    var size = stageSize();
    var w = natural.w * view.s;
    var h = natural.h * view.s;
    view.x = w <= size.w ? (size.w - w) / 2 : Math.min(0, Math.max(size.w - w, view.x));
    view.y = h <= size.h ? (size.h - h) / 2 : Math.min(0, Math.max(size.h - h, view.y));
    shown.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.s + ")";
    var limits = bounds();
    zoomOut.disabled = view.s <= limits.min + 1e-6;
    zoomIn.disabled = view.s >= limits.max - 1e-6;
    stage.classList.toggle("is-zoomed", view.s > fit + 1e-6);
  }
  function fitView() {
    var size = stageSize();
    fit = Math.min(1, size.w / natural.w, size.h / natural.h);
    view.s = fit;
    place();
  }
  // Scale by factor round a point of the stage, so what is under it stays under it.
  function zoomAt(factor, px, py) {
    var limits = bounds();
    var next = Math.min(limits.max, Math.max(limits.min, view.s * factor));
    view.x = px - (px - view.x) * (next / view.s);
    view.y = py - (py - view.y) * (next / view.s);
    view.s = next;
    place();
  }
  function zoomCentre(factor) {
    var size = stageSize();
    zoomAt(factor, size.w / 2, size.h / 2);
  }
  function point(event) {
    var rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function open(img) {
    opener = img;
    shown.src = img.currentSrc || img.src;
    shown.alt = img.alt || "";
    natural = { w: img.naturalWidth || img.width || 1, h: img.naturalHeight || img.height || 1 };
    viewer.hidden = false;
    document.body.classList.add("image-viewer-open");
    fitView();
    close.focus();
  }
  function shut() {
    if (viewer.hidden) return;
    viewer.hidden = true;
    document.body.classList.remove("image-viewer-open");
    if (opener) opener.focus();
    opener = null;
  }

  images.forEach(function (img) {
    img.classList.add("image-opens");
    img.tabIndex = 0;
    img.setAttribute("role", "button");
    img.setAttribute("aria-label", img.alt ? labels.open + ": " + img.alt : labels.open);
    img.addEventListener("click", function () { open(img); });
    img.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open(img);
    });
  });

  zoomIn.addEventListener("click", function () { zoomCentre(1.5); });
  zoomOut.addEventListener("click", function () { zoomCentre(1 / 1.5); });
  close.addEventListener("click", shut);
  document.addEventListener("keydown", function (event) {
    if (viewer.hidden) return;
    if (event.key === "Escape") { event.preventDefault(); shut(); }
    else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomCentre(1.5); }
    else if (event.key === "-") { event.preventDefault(); zoomCentre(1 / 1.5); }
  });
  new ResizeObserver(function () { if (!viewer.hidden) fitView(); }).observe(stage);

  // The wheel: a pinch (ctrl) or a zoom gesture zooms; a plain wheel pans a zoomed image.
  stage.addEventListener("wheel", function (event) {
    event.preventDefault();
    var p = point(event);
    if (event.ctrlKey || event.metaKey) {
      zoomAt(Math.exp(-event.deltaY * 0.01), p.x, p.y);
    } else if (view.s > fit + 1e-6) {
      view.x -= event.deltaX;
      view.y -= event.deltaY;
      place();
    } else {
      zoomAt(Math.exp(-event.deltaY * 0.002), p.x, p.y);
    }
  }, { passive: false });
  // Safari's trackpad pinch.
  var gestureStart = 1;
  stage.addEventListener("gesturestart", function (event) { event.preventDefault(); gestureStart = view.s; });
  stage.addEventListener("gesturechange", function (event) {
    event.preventDefault();
    var p = point(event);
    zoomAt((gestureStart * event.scale) / view.s, p.x, p.y);
  });

  // Pointers: one drags, two pinch. A press and release in one place on the backdrop closes.
  var pointers = new Map();
  var pinch = null;
  var moved = false;
  stage.addEventListener("pointerdown", function (event) {
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, point(event));
    moved = false;
    if (pointers.size === 2) {
      var two = Array.from(pointers.values());
      pinch = { d: Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y) || 1 };
    }
  });
  stage.addEventListener("pointermove", function (event) {
    var last = pointers.get(event.pointerId);
    if (!last) return;
    var now = point(event);
    pointers.set(event.pointerId, now);
    if (Math.abs(now.x - last.x) + Math.abs(now.y - last.y) > 0) moved = true;
    if (pointers.size === 2 && pinch) {
      var two = Array.from(pointers.values());
      var d = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y) || 1;
      zoomAt(d / pinch.d, (two[0].x + two[1].x) / 2, (two[0].y + two[1].y) / 2);
      pinch.d = d;
    } else if (pointers.size === 1) {
      view.x += now.x - last.x;
      view.y += now.y - last.y;
      place();
    }
  });
  function lift(event) {
    var wasOne = pointers.size === 1;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (event.type === "pointerup" && wasOne && !moved && event.target === stage) shut();
  }
  stage.addEventListener("pointerup", lift);
  stage.addEventListener("pointercancel", lift);
  shown.addEventListener("dblclick", function (event) {
    var p = point(event);
    zoomAt(view.s > fit + 1e-6 ? fit / view.s : Math.max(1, fit * 2) / view.s, p.x, p.y);
  });
}());
</script>`;

/**
 * The page for `markdown`, served at `<entry>.html` beside its source (`entry`, the version's
 * Markdown file: its directory decides the fonts' relative address).
 */
export function renderMarkdownToHtml(markdown: string, title: string, entry = ""): string {
  const outline: OutlineItem[] = [];
  const seen = new Map<string, number>();
  const renderer = new marked.Renderer();
  renderer.heading = function ({ tokens, depth }: Tokens.Heading): string {
    const html = this.parser.parseInline(tokens);
    const plain = html.replace(/<[^>]+>/g, "").trim();
    const base = slugify(plain);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    if (depth <= 3 && plain) outline.push({ id, level: depth, title: plain });
    return `<h${depth} id="${id}">${html}</h${depth}>\n`;
  };

  // As written: raw HTML is kept (the content origin is the boundary, not a sanitizer).
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: true, renderer });

  const outlineNav = outline.length > 0
    ? `<aside class="outline-col"><nav class="outline" aria-label="Outline"><div class="outline-title">Outline</div><ol>${outline
        .map((item) => `<li class="lv${item.level}"><a href="#${item.id}" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</a></li>`)
        .join("")}</ol></nav></aside>`
    : "";

  const up = "../".repeat(entry.split("/").length - 1);

  return `<!doctype html>
<html lang="${pageLangOf(markdown)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${fontFaces(up)}
${FONT_VARIABLES}
  * { box-sizing: border-box; }
  :root[data-raft-surface="dark"] { color-scheme: dark; }
  body { margin: 0; background: ${CANVAS}; color: ${INK};
         font: 400 16px/1.5 var(--sans-font); }
  /* The body tier (raft-design typography.md, text-body): 16/24, and 14/22 on a desktop. */
  @media (min-width: 48rem) and (pointer: fine) { body { font-size: 14px; line-height: calc(22 / 14); } }
  .page { padding: 2rem 1rem; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.5rem; max-width: 48rem; margin: 0 auto; }
  .doc { background: ${CANVAS}; padding: 0 .25rem; overflow-wrap: anywhere; overflow-x: auto; }
  .outline-col { display: none; }
  @media (min-width: 1280px) {
    .layout { grid-template-columns: 16rem minmax(0, 48rem); align-items: start; max-width: 66.5rem; }
    .outline-col { display: block; position: sticky; top: 5rem; max-height: calc(100vh - 7rem); overflow: auto; }
  }
  nav.outline { border-left: 1px solid ${HAIRLINE}; padding-left: 1rem; font-size: 0.875rem; }
  nav.outline .outline-title { font-size: 13px; font-weight: 700; color: ${HINT}; margin-bottom: 0.5rem; }
  nav.outline ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.375rem; }
  nav.outline a { display: block; font-size: 13px; font-weight: 500; color: ${MUTED}; text-decoration: none;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  nav.outline a:hover { color: ${INK}; }
  nav.outline li.lv2 { padding-left: 0.9rem; }
  nav.outline li.lv3 { padding-left: 1.8rem; }
  .doc p { margin: 0 0 .75rem; }
  .doc ul, .doc ol { margin: 0 0 .75rem; padding-left: 1.5rem; }
  .doc li { margin-bottom: .25rem; }
  .doc pre, .doc code { font-family: var(--mono-font); }
  .doc :not(pre) > code { padding: 0 .25rem; border-radius: 4px; background: ${FILL_MUTED}; font-size: .9em; overflow-wrap: anywhere; }
  .code-block { position: relative; margin: .5rem 0; }
  .doc pre { margin: 0; overflow-x: auto; border: 1px solid ${HAIRLINE}; border-radius: 10px; background: ${CODE_LAYER}; color: ${INK};
    padding: .75rem 3rem .75rem .75rem; font-size: 13px; line-height: 20px; }
  .code-copy { position: absolute; top: .5rem; right: .5rem; z-index: 10; width: 1.75rem; height: 1.75rem;
    border: 0; border-radius: 8px; background: transparent; color: ${HINT}; cursor: pointer; font: 700 16px/1 monospace; }
  .code-copy:hover, .code-copy:focus-visible { color: ${INK}; background: ${FILL_MEDIUM}; }
  .code-copy:focus-visible { outline: 2px solid ${INK}; outline-offset: 1px; }
  .doc img { max-width: 100%; margin: .5rem 0; border: 1px solid ${HAIRLINE}; border-radius: 10px;
    background-color: ${CANVAS}; background-image: linear-gradient(45deg,${FILL_MUTED} 25%,transparent 25%),linear-gradient(-45deg,${FILL_MUTED} 25%,transparent 25%),linear-gradient(45deg,transparent 75%,${FILL_MUTED} 75%),linear-gradient(-45deg,transparent 75%,${FILL_MUTED} 75%);
    background-size: 16px 16px; background-position: 0 0,0 8px,8px -8px,-8px 0; }
  .doc img.image-opens { cursor: zoom-in; }
  .doc img.image-opens:focus-visible { outline: 2px solid ${INK}; outline-offset: 2px; }
  .image-viewer { position: fixed; inset: 0; z-index: 9999; background: ${BACKDROP}; }
  .image-viewer-stage { position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: zoom-out; }
  .image-viewer-stage.is-zoomed { cursor: grab; }
  .image-viewer-stage.is-zoomed:active { cursor: grabbing; }
  .image-viewer-image { position: absolute; top: 0; left: 0; max-width: none; transform-origin: 0 0; user-select: none;
    -webkit-user-drag: none; cursor: inherit; }
  .image-viewer-bar { position: absolute; top: .5rem; right: .5rem; display: flex; gap: .25rem; border-radius: 10px;
    background: ${CODE_LAYER}; box-shadow: inset 0 0 0 1px ${HAIRLINE}; padding: .25rem; }
  .image-viewer-action { appearance: none; display: inline-grid; width: 2rem; height: 2rem; place-items: center; padding: 0;
    border: 0; border-radius: 8px; background: transparent; color: ${INK}; cursor: pointer; font: 600 18px/1 var(--sans-font); }
  .image-viewer-action:hover:not(:disabled) { background: ${FILL_MEDIUM}; }
  .image-viewer-action:focus-visible { outline: 2px solid ${INK}; outline-offset: 2px; }
  .image-viewer-action:disabled { cursor: not-allowed; opacity: .35; }
  body.image-viewer-open { overflow: hidden; }
  .doc table { display: block; max-width: 100%; margin: .5rem 0; overflow-x: auto; border-collapse: collapse; }
  .doc th, .doc td { border-bottom: 1px solid ${HAIRLINE}; padding: .4rem .75rem .4rem 0; }
  .doc th { font-size: 13px; font-weight: 600; color: ${HINT}; text-align: left; white-space: nowrap; }
  .doc blockquote { margin: .5rem 0; border-left: 2px solid ${SEAM}; padding-left: .75rem; color: ${MUTED}; }
  .doc h1, .doc h2, .doc h3 { scroll-margin-top: 5rem; font-weight: 700; line-height: 1.25; }
  .doc h1 { margin: 1.5rem 0 .75rem; font-size: 1.875rem; }
  .doc h2 { margin: 1.25rem 0 .625rem; font-size: 1.5rem; }
  .doc h3 { margin: 1rem 0 .5rem; font-size: 1.25rem; }
  .doc h4, .doc h5, .doc h6 { margin: .75rem 0 .25rem; line-height: 1.25; }
  .doc hr { margin: 1rem 0; border: 0; border-top: 1px solid ${HAIRLINE}; }
  .doc a { color: ${LINK}; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
  .doc input[type="checkbox"] { margin-right: .35rem; accent-color: ${INK}; }
  .mermaid-diagram { position: relative; margin: 1rem 0; border: 1px solid ${HAIRLINE}; border-radius: 10px; overflow: hidden; background: ${CODE_LAYER}; }
  .mermaid-toolbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; justify-content: flex-end;
    gap: .35rem; border-bottom: 1px solid ${HAIRLINE}; background: ${CODE_LAYER}; padding: .4rem .5rem; }
  .mermaid-toolbar-views { display: flex; gap: .25rem; margin-right: auto; }
  .mermaid-toolbar-zoom { display: flex; gap: .25rem; }
  .mermaid-tab, .mermaid-action { appearance: none; border: 0; border-radius: 8px; background: transparent;
    color: ${INK}; cursor: pointer; font: 600 12px/1.1 var(--sans-font); }
  .mermaid-tab { min-height: 1.75rem; padding: .3rem .55rem; }
  .mermaid-tab.is-active { background: ${BRAND}; color: ${ON_BRAND}; box-shadow: inset 0 0 0 1.5px ${ON_BRAND}; }
  .mermaid-action { display: inline-grid; width: 1.75rem; height: 1.75rem; place-items: center; padding: 0; font-size: 16px; }
  .mermaid-tab:hover:not(.is-active), .mermaid-action:hover:not(:disabled) { background: ${FILL_MEDIUM}; }
  .mermaid-action:focus-visible, .mermaid-tab:focus-visible {
    outline: 2px solid ${INK}; outline-offset: 2px; }
  .mermaid-action:disabled { cursor: not-allowed; opacity: .35; }
  .mermaid-diagram-panel { background: ${CODE_LAYER}; }
  .mermaid-viewport { display: flex; height: 96px; overflow: auto; overscroll-behavior: contain; }
  .mermaid-stage { display: flex; flex: none; min-width: 100%; min-height: 100%; margin: auto; align-items: center; justify-content: center; }
  .mermaid-canvas { display: flex; align-items: center; justify-content: center; padding: .75rem; box-sizing: border-box; }
  .mermaid-canvas svg { display: block; flex: none; }
  .mermaid-status { color: ${HINT}; font-size: .875rem; }
  .mermaid-render-error { color: ${MUTED}; font-weight: 700; text-align: center; }
  .mermaid-source pre { margin: 0; border: 0; border-radius: 0; padding: .9rem; }
  .mermaid-alert { margin: 0; border-top: 1px solid ${HAIRLINE}; background: ${WARNING_SOFT}; padding: .55rem .75rem;
    font: 12px/1.4 var(--mono-font); }
  .mermaid-fullscreen { position: fixed; inset: 0; z-index: 9999; padding: clamp(.75rem, 3vw, 1.5rem); background: ${BACKDROP}; }
  .mermaid-fullscreen-panel { position: relative; display: flex; width: 100%; height: 100%; max-width: 80rem; margin: auto;
    border-radius: 16px; background: ${CODE_LAYER}; box-sizing: border-box; }
  .mermaid-fullscreen-canvas { display: flex; width: 100%; height: 100%; align-items: center; justify-content: center; overflow: auto; padding: 1rem; box-sizing: border-box; }
  .mermaid-fullscreen-canvas svg { display: block; width: auto !important; max-width: 100%; height: auto !important; max-height: 100%; }
  .mermaid-fullscreen-close { position: absolute; top: .5rem; right: .5rem; z-index: 2; background: ${CODE_LAYER}; box-shadow: inset 0 0 0 1px ${HAIRLINE}; }
  body.mermaid-modal-open { overflow: hidden; }
  [hidden] { display: none !important; }
  @media (max-width: 639px) {
    .mermaid-toolbar { gap: .45rem; }
    .mermaid-toolbar-zoom { display: none; }
    .mermaid-tab { padding-inline: .45rem; }
    .mermaid-action { width: 2rem; height: 2rem; }
    }
  /* The paper: only where the page leaves wide empty space on both sides of the column. Narrower,
     the text sits on the canvas, with no tint and no sheet (Kirby, xxchan). */
  @media screen and (min-width: ${ARTIFACT_PAGE_CARD_MIN_WIDTH_PX}px) {
    :root[data-raft-card] body { background: ${GROUND}; }
    :root[data-raft-card] .page { padding: 2.5rem 2rem; }
    :root[data-raft-card] .doc { border: 1px solid ${HAIRLINE}; border-radius: 10px; background: ${CARD}; padding: 3rem 2.5rem; }
    :root[data-raft-card] .doc img { background-color: ${CARD}; }
  }
  @media print {
    :root { ${PRINT_COLORS} }
    :root[data-raft-surface="dark"] { color-scheme: light; }
  }
</style>
</head>
<body><div class="page"><div class="layout">${outlineNav}<div class="doc">${html}</div></div></div>${SURFACE_SCRIPT}${hasMermaid(markdown) ? MERMAID_SCRIPTS : ""}${CODE_COPY_SCRIPT}${/<img\b/i.test(html) ? IMAGE_VIEWER_SCRIPT : ""}</body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
