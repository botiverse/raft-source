import { toPng } from "html-to-image";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import pixelAvatars from "../../assets/avatars/pixelAvatars.json";
import { useServerStore } from "../store/serverStore";
import { assertValidDesktopRuntimeEnvironment, RUNTIME_API_BASE } from "../desktopRuntimeEnvironment";
import { materializeDomCaptureSnapshots } from "./domCaptureSnapshot";

const TRANSPARENT_GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const API_BASE = RUNTIME_API_BASE;

const DEFAULT_CAPTURE_TIMEOUT_MS = 20_000;
// Keep exports crisp on high-DPR/mobile screens without letting very long
// selections explode memory on 4x+ displays.
const MIN_CAPTURE_PIXEL_RATIO = 2;
const MAX_CAPTURE_PIXEL_RATIO = 3;
const IMAGE_INLINE_TIMEOUT_MS = 1_000;
const FONT_READY_TIMEOUT_MS = 1_000;
export const SHARE_PREVIEW_MAX_WIDTH = 768;

export class SelectScreenshotTimeoutError extends Error {
  readonly timeoutSeconds: number;

  constructor(timeoutMs: number) {
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    super(`Rendering timed out after ${timeoutSeconds}s`);
    this.name = "SelectScreenshotTimeoutError";
    this.timeoutSeconds = timeoutSeconds;
  }
}

class SelectScreenshotImageInlineTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Image inlining timed out after ${Math.max(1, Math.ceil(timeoutMs / 1000))}s`);
    this.name = "SelectScreenshotImageInlineTimeoutError";
  }
}

export function withCaptureTimeout<T>(
  promise: Promise<T>,
  timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new SelectScreenshotTimeoutError(timeoutMs)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

export function resolveCapturePixelRatio(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  const devicePixelRatio =
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(
    MAX_CAPTURE_PIXEL_RATIO,
    Math.max(MIN_CAPTURE_PIXEL_RATIO, devicePixelRatio),
  );
}

export async function waitForDocumentFontsForScreenshot(
  fonts: FontFaceSet | undefined = typeof document === "undefined" ? undefined : document.fonts,
  timeoutMs = FONT_READY_TIMEOUT_MS,
): Promise<void> {
  if (typeof fonts?.ready !== "object") return;
  let timeoutId: unknown;
  try {
    await Promise.race([
      fonts.ready,
      new Promise<void>((resolve) => {
        timeoutId = setClockTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    /* noop — fonts.ready rejects are non-fatal */
  } finally {
    if (timeoutId) clearClockTimeout(timeoutId);
  }
}

/**
 * Capture an image of the messages identified by `messageIds`.
 *
 * Pipeline (rewritten 2026-05-01 for v1.5 after huxijin's feedback in
 * #proj-mobile:fd343bd8 — "在 SLOCK 里长什么样，导出就是什么样"):
 *
 *   1. Locate each live `<div id="message-${id}">` row.
 *   2. **Deep-clone the whole row.** No more avatar/header/body reconstruction
 *      — that rewrites the DOM and drifts from the real MessageItem (wrong
 *      image sizes, dropped attachment previews, bad markdown alignment on
 *      mobile, etc.).
 *   3. Normalize clone-only presentation state: long-message reading chrome
 *      is expanded because a share artifact must contain the full selected
 *      message; the live row remains untouched. Strip the select indicator,
 *      bookmark button, disclosure toggle, and hover-only thread / download
 *      overlays — none are message content. Components with non-cloneable
 *      live surfaces (for example sandboxed frames) may replace their clone
 *      through the generic DOM-capture snapshot boundary.
 *   4. Append the clones to an off-screen container whose width tracks
 *      the live chat column (so wrapping behaviour matches), then
 *      rasterize via `html-to-image`'s `toPng`. `html-to-image` preserves
 *      `display:flex`, `gap`, CSS variables, and Tailwind-class resolution
 *      far better than canvas-based rasterizers, because it goes through
 *      SVG `foreignObject`.
 *
 * Returns a `data:image/png;base64,...` URL.
 */
export interface CaptureOptions {
  backgroundColor?: string;
  pixelRatio?: number;
  timeoutMs?: number;
  /**
   * Optional CSS-pixel width cap for cross-device share artifacts. This caps
   * layout width only; `pixelRatio` still controls rasterized resolution.
   */
  maxWidth?: number;
  /**
   * Set of message ids that should render with one-step left indent — used
   * for thread replies under their selected parent. Pure padding indent, no
   * connector line, per huxijin's v1.4 spec ("纯 padding 缩紧").
   */
  threadChildIds?: ReadonlySet<string>;
}

/**
 * Selectors for transient / interactive UI that lives inside the
 * MessageItem row but shouldn't appear in the exported image.
 *
 * Kept here as one list so it's easy to audit what we're stripping.
 * Prefer semantic selectors (testid / data-message-affordance / aria-
 * label / title) over visual class tuples — Tailwind class names drift
 * and a Tailwind rename would silently leak a button into the export.
 * Per peng's 2026-05-01 review in #proj-mobile:fd343bd8.
 */
const STRIP_SELECTORS = [
  // The select-mode indicator circle (v1.5 — was `self-center`, now
  // `self-start mt-1.5`). Stable testid — never strip by layout class.
  '[data-testid^="message-select-circle-"]',
  // All hover/static affordances marked with `data-message-affordance`
  // — bookmark, thread button, image download overlay, file download
  // overlay. Attribute is set on the affordance root in MessageItem.tsx
  // so renames of Tailwind chrome don't break the strip pass.
  "[data-message-affordance]",
];

const FREEZE_RENDERED_BOX_SELECTORS = [
  // html-to-image can re-measure compact inline-flex buttons with subtly
  // different text metrics inside the exported foreignObject. The share PNG
  // should preserve the live message chrome, so copy the live chip box.
  '[data-testid="message-thread-replies-badge"]',
];

function queryMatchingElements(root: HTMLElement, selector: string): HTMLElement[] {
  const matches = root.matches(selector) ? [root] : [];
  return matches.concat(Array.from(root.querySelectorAll<HTMLElement>(selector)));
}

/**
 * Share images are durable content artifacts, not snapshots of ephemeral
 * reading chrome. A selected row may currently be clipped, but its clone still
 * contains the full DOM. Expand only that clone before rasterization; never
 * click the live disclosure or mutate its React/session state.
 */
export function expandClonedMessageContentForScreenshot(clone: HTMLElement): void {
  for (const content of queryMatchingElements(clone, '[data-message-collapsible-content="true"]')) {
    content.dataset.messageCollapsed = "false";
    content.classList.remove("relative", "overflow-clip");
    content.style.removeProperty("max-height");
  }

  clone.querySelectorAll([
    "[data-message-content-toggle]",
    "[data-message-content-toggle-placeholder]",
    "[data-message-collapse-fade]",
  ].join(",")).forEach((node) => node.remove());
}

function freezeCloneRenderedBoxes(source: HTMLElement, clone: HTMLElement): void {
  for (const selector of FREEZE_RENDERED_BOX_SELECTORS) {
    const sourceElements = queryMatchingElements(source, selector);
    const cloneElements = queryMatchingElements(clone, selector);
    sourceElements.forEach((sourceEl, index) => {
      const cloneEl = cloneElements[index];
      if (!cloneEl) return;
      const rect = sourceEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const width = `${rect.width}px`;
      cloneEl.style.boxSizing = "border-box";
      cloneEl.style.width = width;
      cloneEl.style.minWidth = width;
      cloneEl.style.maxWidth = width;
      cloneEl.style.height = `${rect.height}px`;
      cloneEl.style.flex = "0 0 auto";
    });
  }
}

const TEXT_LINE_BOX_SELECTORS = [
  "[data-message-selectable]",
  "[data-message-selectable] p",
  "[data-message-selectable] li",
  "[data-message-selectable] h1",
  "[data-message-selectable] h2",
  "[data-message-selectable] h3",
  "[data-message-selectable] h4",
  "[data-message-selectable] h5",
  "[data-message-selectable] h6",
  "[data-message-selectable] code",
  "[data-message-selectable] a",
  "[data-message-selectable] span",
  "[data-message-selectable] strong",
  "[data-message-selectable] em",
].join(",");

const WIDE_CONTENT_SELECTORS = [
  "[data-message-selectable]",
  "[data-message-selectable] pre",
  "[data-message-selectable] code",
  "[data-message-selectable] table",
  "[data-message-selectable] th",
  "[data-message-selectable] td",
  "[data-message-selectable] a",
].join(",");

/**
 * Mutations that must be applied to the cloned message row before it
 * hits the rasterizer. Keeps the clone static (no hover transitions,
 * no cursor changes, no group-hover bleed).
 */
function sanitizeClone(clone: HTMLElement): void {
  // Drop transient UI.
  for (const sel of STRIP_SELECTORS) {
    clone.querySelectorAll(sel).forEach((n) => n.remove());
  }

  // Strip border / shadow / highlight state from the row container so
  // the exported version has a calm, neutral chrome. Drop `group` /
  // `cursor-*` too — they're interactive affordances.
  clone.classList.remove(
    "group",
    "relative",
    "hover:border-black",
    "hover:bg-white",
    "active:bg-white",
    "active:border-black",
  );
  // Border rings vary by selection / hover state; force a clean
  // transparent border so clones stack without double lines.
  clone.style.border = "2px solid transparent";
  clone.style.marginBottom = "4px";
  clone.style.background = "transparent";
}

function freezeTextLineBoxesForScreenshot(root: HTMLElement): void {
  const nodes = root.querySelectorAll<HTMLElement>(TEXT_LINE_BOX_SELECTORS);
  nodes.forEach((node) => {
    const style = window.getComputedStyle(node);
    const fontSize = style.fontSize;
    const lineHeight = style.lineHeight;
    if (fontSize.endsWith("px")) node.style.fontSize = fontSize;
    if (lineHeight.endsWith("px")) node.style.lineHeight = lineHeight;
  });
}

function constrainWideContentForScreenshot(root: HTMLElement): void {
  const nodes = root.querySelectorAll<HTMLElement>(WIDE_CONTENT_SELECTORS);
  nodes.forEach((node) => {
    node.style.boxSizing = "border-box";
    node.style.maxWidth = "100%";
    node.style.overflowWrap = "anywhere";
    if (node.tagName === "PRE") {
      node.style.whiteSpace = "pre-wrap";
      node.style.overflowX = "hidden";
    } else if (node.tagName === "TABLE") {
      node.style.width = "100%";
      node.style.minWidth = "0";
      node.style.tableLayout = "fixed";
      const tableWrapper = node.parentElement;
      if (tableWrapper && tableWrapper !== root) {
        tableWrapper.style.maxWidth = "100%";
        tableWrapper.style.overflowX = "hidden";
      }
    } else if (node.tagName === "TH" || node.tagName === "TD") {
      node.style.minWidth = "0";
      node.style.whiteSpace = "normal";
      node.style.wordBreak = "break-word";
    }
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  const reader = new FileReader();
  return new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

function getAuthHeaders(): HeadersInit {
  assertValidDesktopRuntimeEnvironment();

  const headers: Record<string, string> = {};
  const token = localStorage.getItem("slock_access_token");
  const serverId = useServerStore.getState().current?.id;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (serverId) headers["X-Server-Id"] = serverId;
  return headers;
}

export function resolveAvatarImageFetchTargetUrl(src: string, baseHref = window.location.href): string | null {
  const url = new URL(src, baseHref);
  const avatarMatch = url.pathname.match(/(?:^|\/)avatars\/([^/]+)\/([0-9a-f]+\.webp)$/i);
  if (!avatarMatch) return null;
  const [, namespace, filename] = avatarMatch;
  return `${API_BASE}/avatars/${encodeURIComponent(namespace)}/${encodeURIComponent(filename)}`;
}

function getPublicAvatarFetchInit(): RequestInit {
  return {
    cache: "no-cache",
    mode: "cors",
    credentials: "omit",
  };
}

type ScreenshotImageFetchTarget = {
  url: string;
  init: RequestInit;
  preserveOriginalOnFailure: boolean;
  avatarFallbackKind?: string;
};

function getImageFetchTarget(img: HTMLImageElement): ScreenshotImageFetchTarget | null {
  const attachmentId = img.dataset.selectScreenshotAttachmentId;
  if (attachmentId) {
    return {
      preserveOriginalOnFailure: false,
      url: `${API_BASE}/attachments/${encodeURIComponent(attachmentId)}?disposition=inline&selectScreenshot=1`,
      init: {
        headers: getAuthHeaders(),
        cache: "no-cache",
      },
    };
  }

  const src = img.currentSrc || img.src || img.getAttribute("src") || "";
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return null;

  const avatarFallbackKind = img.closest<HTMLElement>("[data-avatar-kind]")?.dataset.avatarKind;
  const url = new URL(src, window.location.href);
  const avatarApiUrl = resolveAvatarImageFetchTargetUrl(url.toString());
  if (avatarApiUrl) {
    return {
      preserveOriginalOnFailure: true,
      avatarFallbackKind: avatarFallbackKind ?? "human",
      url: avatarApiUrl,
      init: getPublicAvatarFetchInit(),
    };
  }

  const sameOrigin = url.origin === window.location.origin;
  return {
    preserveOriginalOnFailure: Boolean(avatarFallbackKind),
    avatarFallbackKind,
    url: url.toString(),
    init: sameOrigin
      ? {
          headers: getAuthHeaders(),
          cache: "no-cache",
        }
      : {
          credentials: "omit",
          mode: "cors",
          cache: "no-cache",
        },
  };
}

async function fetchImageForScreenshot(
  url: string,
  init: RequestInit,
  timeoutMs = IMAGE_INLINE_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new SelectScreenshotImageInlineTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetch(url, {
        ...init,
        signal: controller.signal,
      }),
      timeout,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function freezeRenderedImageBox(img: HTMLImageElement): void {
  const rect = img.getBoundingClientRect();
  if (rect.width > 16 && rect.height > 16) {
    img.style.width = `${rect.width}px`;
    img.style.height = `${rect.height}px`;
    return;
  }

  const sourceWidth = Number(img.dataset.selectScreenshotAttachmentWidth);
  const sourceHeight = Number(img.dataset.selectScreenshotAttachmentHeight);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return;
  }

  const maxWidth = Math.min(416, img.parentElement?.parentElement?.getBoundingClientRect().width || 416);
  const maxHeight = 288;
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  img.style.width = `${Math.max(1, Math.round(sourceWidth * scale))}px`;
  img.style.height = `${Math.max(1, Math.round(sourceHeight * scale))}px`;
}

async function decodeImage(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return;
  try {
    await Promise.race([
      img.decode(),
      new Promise<void>((r) => setTimeout(r, 2000)),
    ]);
  } catch {
    /* image failed to decode; rasterize whatever the browser has */
  }
}

function isTransparentColor(value: string): boolean {
  const color = value.trim().toLowerCase();
  return color === "" || color === "transparent" || color === "rgba(0, 0, 0, 0)" || color === "rgba(0,0,0,0)";
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const DEFAULT_HUMAN_AVATAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#BBAFE6"/><path d="M20 21a8 8 0 0 0-16 0" fill="none" stroke="#141111" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><circle cx="12" cy="7" r="4" fill="none" stroke="#141111" stroke-width="2"/></svg>';

// The agent default is the same robot sprite used by AgentAvatar when a
// custom image is unavailable. Keep this capture-only copy inline so a failed
// image cannot make the rasterizer depend on React/CSS-grid state.
const DEFAULT_AGENT_AVATAR_DATA_URL = (() => {
  const avatars = pixelAvatars.avatars as Record<string, { bg: string; grid: string[] }>;
  const avatar = avatars[pixelAvatars.defaultKey];
  const palette = pixelAvatars.palette as Record<string, string>;
  const bg = avatar.bg.startsWith("#") ? avatar.bg : palette[avatar.bg];
  const cells = avatar.grid.flatMap((row, y) => row.split("").flatMap((color, x) => {
    const fill = color === "_" ? "transparent" : color.startsWith("#") ? color : palette[color];
    return fill === "transparent"
      ? []
      : [`<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`];
  }));
  return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges"><rect width="8" height="8" fill="${bg}"/>${cells.join("")}</svg>`);
})();

/**
 * Return the same visible default-avatar treatment used by AvatarSlot when a
 * cloned share image cannot load an avatar. Unknown callers use the human
 * placeholder because it is the neutral AvatarSlot fallback.
 */
export function getDefaultAvatarDataUrl(kind?: string): string {
  return kind === "agent" ? DEFAULT_AGENT_AVATAR_DATA_URL : svgDataUrl(DEFAULT_HUMAN_AVATAR_SVG);
}

function inlineDefaultAvatarForScreenshot(img: HTMLImageElement): void {
  const kind = img.closest<HTMLElement>("[data-avatar-kind]")?.dataset.avatarKind;
  // srcset can otherwise win URL selection again after assigning the data URL.
  img.removeAttribute("srcset");
  img.removeAttribute("sizes");
  img.hidden = false;
  img.style.display = "block";
  img.style.visibility = "visible";
  img.style.opacity = "1";
  img.dataset.selectScreenshotAvatarFallback = kind ?? "human";
  img.src = getDefaultAvatarDataUrl(kind);
}

function canRasterizeOriginalImage(src: string): boolean {
  if (src.startsWith("data:") || src.startsWith("blob:")) return true;
  try {
    // A foreignObject rasterizer cannot reliably re-read a cross-origin image
    // that was not converted to a data URL. Keep a same-origin original only;
    // CDN capability URLs must use the API/data-url path or a safe placeholder.
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * html-to-image serializes CSS grid children inconsistently inside SVG
 * foreignObject. Pixel avatars are intentionally CSS-only in the live UI, so
 * materialize each 8x8 grid into one inline SVG before rasterization. This is
 * capture-only; the live avatar remains the canonical CSS grid.
 */
function inlinePixelAvatarsForScreenshot(root: HTMLElement): void {
  const avatars = root.querySelectorAll<HTMLElement>("[data-agent-pixel-avatar]");
  avatars.forEach((avatar) => {
    const cells = Array.from(avatar.children).slice(0, 64) as HTMLElement[];
    if (cells.length !== 64) return;

    const avatarStyle = window.getComputedStyle(avatar);
    const bg = avatarStyle.backgroundColor;
    if (isTransparentColor(bg)) return;

    const rects = cells.flatMap((cell, index) => {
      const fill = window.getComputedStyle(cell).backgroundColor;
      if (isTransparentColor(fill)) return [];
      const x = index % 8;
      const y = Math.floor(index / 8);
      return [`<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`];
    });

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges"><rect width="8" height="8" fill="${bg}"/>${rects.join("")}</svg>`;
    const img = document.createElement("img");
    img.src = svgDataUrl(svg);
    img.alt = "";
    img.style.display = "block";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "cover";
    img.style.imageRendering = "pixelated";

    avatar.replaceChildren(img);
    avatar.style.display = "block";
    avatar.style.backgroundColor = bg;
  });
}

async function inlineImageForScreenshot(img: HTMLImageElement): Promise<void> {
  freezeRenderedImageBox(img);
  const target = getImageFetchTarget(img);
  if (!target) {
    await decodeImage(img);
    return;
  }

  const originalSrc = img.currentSrc || img.src || img.getAttribute("src") || target.url;
  try {
    const response = await fetchImageForScreenshot(target.url, target.init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    img.src = await blobToDataUrl(await response.blob());
    await decodeImage(img);
  } catch (err) {
    // The live browser may already have decoded an uploaded avatar from its
    // capability URL even when the API fallback is unavailable. Keep that
    // source for html-to-image's best-effort pass instead of exposing the
    // AvatarSlot placeholder background in the generated image.
    if (target.preserveOriginalOnFailure && canRasterizeOriginalImage(originalSrc)) {
      img.src = originalSrc;
      await decodeImage(img);
      if (img.complete && img.naturalWidth > 0) return;
    }

    // Keep the already-frozen rendered dimensions so one bad image cannot
    // collapse the whole message into a tiny placeholder in the export.
    console.warn(
      "captureSelectedMessages: image inlining failed, using placeholder",
      {
        src: originalSrc,
        fetchUrl: target.url,
        error: err,
        errMessage: err instanceof Error ? err.message : String(err),
        errName: err instanceof Error ? err.name : typeof err,
      },
    );
    if (target.avatarFallbackKind) {
      inlineDefaultAvatarForScreenshot(img);
    } else {
      img.src = TRANSPARENT_GIF;
    }
    await decodeImage(img);
  }
}

export async function captureSelectedMessages(
  messageIds: string[],
  options: CaptureOptions = {},
): Promise<string> {
  return withCaptureTimeout(captureSelectedMessagesUnsafe(messageIds, options), options.timeoutMs);
}

async function captureSelectedMessagesUnsafe(
  messageIds: string[],
  options: CaptureOptions = {},
): Promise<string> {
  if (messageIds.length === 0) {
    throw new Error("captureSelectedMessages: no message ids");
  }

  const nodes: HTMLElement[] = [];
  for (const id of messageIds) {
    const el = document.getElementById(`message-${id}`);
    if (el) nodes.push(el);
  }
  if (nodes.length === 0) {
    throw new Error("captureSelectedMessages: no DOM matches");
  }
  nodes.sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  // Default falls through to white per the layout color contract (post-#1272
  // main panel = white). Callers should still pass an explicit value.
  const bg = options.backgroundColor ?? "#FFFFFF";

  // Track the LIVE MESSAGE ROW's own rendered width — not the chat column /
  // parent's. Measuring the parent (chat column) lets the off-screen container
  // become wider than where the row was actually laid out (parent padding,
  // flex-1 sibling siblings, max-w constraints), which causes inline-block
  // children like `<MSG_REF_CHIP>` (`#proj-growth` etc.) to re-layout inside
  // an SVG `<foreignObject>` and overflow because the chip itself has no
  // max-width / truncate. Optionally cap the export to a channel-specific
  // reading width so a single message does not become an overly wide, flat
  // card when the image is read on a different device than it was created on.
  // tygg #wg-sharing:e1f749f8 2026-05-24 — first-principles root cause for
  // the recurring "share screenshot inconsistency" class of bug (see also
  // the FREEZE_RENDERED_BOX_SELECTORS pattern which is a per-callsite
  // workaround for the same SVG re-layout class).
  const rowWidth = nodes[0]?.getBoundingClientRect().width ?? SHARE_PREVIEW_MAX_WIDTH;
  const maxWidth = options.maxWidth;
  const liveWidth = typeof maxWidth === "number" && Number.isFinite(maxWidth) && maxWidth > 0
    ? Math.min(rowWidth, maxWidth)
    : rowWidth;

  // Container placement: off-screen-left, fully opaque, normal layout.
  //
  // v1.4 used `position: fixed; transform: translateY(100vh)`. That turned
  // out to be the root cause of CI blank PNG output: `html-to-image` reads
  // computed layout via `<foreignObject>`, and fixed-position nodes
  // outside the viewport can resolve `width:auto` → 0, collapsing the
  // whole subtree. We can't use `opacity:0` or `visibility:hidden` as a
  // replacement either — both values are inline-copied into the clone
  // that html-to-image rasterizes, producing a transparent image.
  //
  // The correct first-principles fix is **off-screen-by-offset**: leave
  // the container in normal layout at `position:absolute; left:-99999px`.
  // The browser resolves widths / fonts / image layout identically to
  // on-screen content; the user never sees it because it's scrolled off
  // the left edge. This is the approach taken by modern-screenshot
  // (qq15725's active html-to-image fork) and recommended in the
  // bubkoo/html-to-image issue tracker for the blank-canvas class.
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "-99999px";
  container.style.top = "0";
  container.style.pointerEvents = "none";
  container.style.zIndex = "-1";
  container.style.width = `${liveWidth}px`;
  container.style.padding = "0";
  container.style.background = bg;
  container.style.fontFamily = getComputedStyle(document.body).fontFamily;
  container.style.color = "#141111";
  container.style.boxSizing = "border-box";
  container.setAttribute("data-select-screenshot-root", "true");

  // Brand header bar — yellow nav-bar style with official Raft lockup + domain.
  // Replaces bottom-right watermark with a top bar that matches the mobile
  // nav bar visual language (per stdrc in #wg-sharing:7ae7ab16). Header bar
  // spans container full width (no padding) for edge-to-edge visual.
  const headerBar = document.createElement("div");
  headerBar.style.display = "flex";
  headerBar.style.alignItems = "center";
  headerBar.style.justifyContent = "space-between";
  headerBar.style.padding = "8px 16px 8px 24px";
  headerBar.style.background = "#FFD440";
  headerBar.style.borderBottom = "2px solid #141111";
  headerBar.style.fontFamily =
    "'Space Grotesk', 'Space Mono', ui-monospace, sans-serif";

  const lockup = document.createElement("div");
  lockup.setAttribute("aria-label", "Raft");
  lockup.style.display = "inline-flex";
  lockup.style.alignItems = "center";
  lockup.style.lineHeight = "1";

  const lockupIcon = document.createElement("img");
  lockupIcon.src = "/brand/raft-logo.svg";
  lockupIcon.alt = "";
  lockupIcon.setAttribute("aria-hidden", "true");
  lockupIcon.style.display = "block";
  lockupIcon.style.width = "auto";
  lockupIcon.style.height = "22.68px";

  lockup.appendChild(lockupIcon);

  const domain = document.createElement("span");
  domain.textContent = "raft.build";
  domain.style.fontFamily =
    "'Space Mono', ui-monospace, monospace";
  domain.style.fontSize = "12px";
  domain.style.fontWeight = "700";
  domain.style.color = "#141111";
  domain.style.opacity = "0.7";

  headerBar.appendChild(lockup);
  headerBar.appendChild(domain);
  container.appendChild(headerBar);

  // Message content area with padding (container itself has no padding
  // so the header bar spans edge-to-edge).
  const contentArea = document.createElement("div");
  contentArea.style.padding = "12px 16px 16px";

  const childIds = options.threadChildIds ?? new Set<string>();
  const disposeSnapshots: Array<() => void> = [];
  try {
    for (const node of nodes) {
      const id = node.getAttribute("id")?.replace(/^message-/, "") ?? "";
      const clone = node.cloneNode(true) as HTMLElement;
      sanitizeClone(clone);
      expandClonedMessageContentForScreenshot(clone);
      freezeCloneRenderedBoxes(node, clone);
      disposeSnapshots.push(await materializeDomCaptureSnapshots(node, clone));
      if (childIds.has(id)) clone.style.paddingLeft = "32px";
      contentArea.appendChild(clone);
    }
  } catch (error) {
    for (const dispose of disposeSnapshots.reverse()) dispose();
    throw error;
  }
  container.appendChild(contentArea);

  try {
    document.body.appendChild(container);
    // Force layout so html-to-image reads resolved styles.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    container.offsetHeight;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    // Wait briefly for page fonts, but never let third-party font loading own
    // the share action. html-to-image also has its own web-font embedding pass;
    // we disable it below so a stalled Google Fonts/GStatic request cannot keep
    // the toolbar on "Rendering..." until the outer capture timeout fires.
    await waitForDocumentFontsForScreenshot();

    // html-to-image serializes the off-screen subtree into SVG foreignObject.
    // Some browser/font combinations re-resolve markdown inline chips against a
    // different line box during that serialization, which can make wrapped text
    // paint over the next line in the exported PNG. Freeze the already-computed
    // text metrics in the clone only; the live message DOM remains unchanged.
    constrainWideContentForScreenshot(container);
    freezeTextLineBoxesForScreenshot(container);

    // Inline image sources inside the clone before rasterization. Attachment
    // thumbnails are commonly CDN URLs; if CDN CORS is missing/stale,
    // `html-to-image` cannot serialize them from the cloned <img>. MessageItem
    // marks attachment images with `data-select-screenshot-attachment-id`, so
    // we can fetch the protected same-origin attachment stream with the current
    // auth/server headers and swap it to a data URL before rendering.
    //
    // We also freeze each image's rendered box before replacing src. If a single
    // image still fails, the export keeps the live message layout instead of
    // collapsing that media slot to a 1x1 broken-image placeholder.
    inlinePixelAvatarsForScreenshot(container);
    const imgs = Array.from(container.querySelectorAll("img")) as HTMLImageElement[];
    await Promise.all(imgs.map((img) => inlineImageForScreenshot(img)));

    // Root needs an explicit height so the SVG wrapper knows how tall
    // to make its viewBox. Without it, some browsers clip to content
    // height but leave an uninitialized pixel buffer around the edges,
    // which reads as "blank" on small outputs.
    const liveHeight = container.offsetHeight;

    return await toPng(container, {
      backgroundColor: bg,
      pixelRatio: resolveCapturePixelRatio(options.pixelRatio),
      // `cacheBust: true` re-fetches every img/font URL with a unique
      // query string, which defeats the decode() wait above (the new
      // URL gets a fresh pending fetch). Turn it off — we've already
      // waited for the live images to decode.
      cacheBust: false,
      skipFonts: true,
      skipAutoScale: true,
      width: liveWidth,
      height: liveHeight,
      // Reset positioning on the cloned root so html-to-image's
      // `<foreignObject>` renders the content at (0, 0) instead of
      // at `left:-99999px` (where rasterization would clip it away).
      // We keep the container off-screen on the *live* DOM to avoid
      // a visible flash, but the rasterized clone must be at origin.
      style: {
        position: "static",
        left: "0",
        top: "0",
      },
    });
  } finally {
    container.remove();
    for (const dispose of disposeSnapshots.reverse()) dispose();
  }
}

/**
 * Trigger a browser download for a `data:image/png;base64,...` URL.
 */
export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
