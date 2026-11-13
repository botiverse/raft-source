import { toPng } from "html-to-image";
import {
  planScreenshotPixelRatio,
  ScreenshotNeedsPaginationError,
  validateScreenshotPng,
} from "./screenshotBudget";
import type { ValidatedScreenshot } from "./screenshotBudget";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { materializeDomCaptureSnapshots } from "./domCaptureSnapshot";
import {
  planScreenshotPages,
} from "./selectScreenshotPagination";
import type { ScreenshotMessageMeasure, ScreenshotPageSegment } from "./selectScreenshotPagination";
import { requestAllTimelineRowsMounted } from "./timelineMountAll";
import {
  SHARE_PREVIEW_MAX_WIDTH,
  SelectScreenshotRowsMissingError,
  SelectScreenshotTimeoutError,
  SelectScreenshotTransientContentError,
} from "./selectScreenshotShared";
import { inlineImagesForScreenshot } from "./selectScreenshotImages";
import type { ScreenshotImageReads } from "./selectScreenshotImages";
import { getScreenshotFontEmbedCss } from "./selectScreenshotFonts";

export {
  getDefaultAvatarDataUrl,
  inlineImagesForScreenshot,
  resolveAvatarImageFetchTargetUrl,
} from "./selectScreenshotImages";
export type { ScreenshotImageReads } from "./selectScreenshotImages";

export {
  downloadDataUrl,
  SHARE_PREVIEW_MAX_WIDTH,
  SelectScreenshotRowsMissingError,
  SelectScreenshotTimeoutError,
  SelectScreenshotTransientContentError,
} from "./selectScreenshotShared";

const DEFAULT_CAPTURE_TIMEOUT_MS = 20_000;
// Keep exports crisp on high-DPR/mobile screens without letting very long
// selections explode memory on 4x+ displays.
const MIN_CAPTURE_PIXEL_RATIO = 2;
const MAX_CAPTURE_PIXEL_RATIO = 3;
const FONT_READY_TIMEOUT_MS = 1_000;

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
export function resolveScreenshotSurface(source: HTMLElement): { backgroundColor: string; color: string } {
  const color = getComputedStyle(source).color;
  for (let element: HTMLElement | null = source.parentElement; element; element = element.parentElement) {
    const backgroundColor = getComputedStyle(element).backgroundColor;
    // Selection/hover washes are stripped from the clone. Use its solid
    // underlying surface, not a translucent row highlight or a white default.
    const alpha = backgroundColor.match(/(?:rgba\([^)]*,|\/)\s*([\d.]+)(%)?\s*\)$/);
    const opacity = alpha ? Number(alpha[1]) / (alpha[2] ? 100 : 1) : 1;
    if (backgroundColor && backgroundColor !== "transparent" && opacity >= 1) {
      return { backgroundColor, color };
    }
  }
  return { backgroundColor: "#FFFFFF", color };
}

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
   * Panel the selection was made in. A thread's parent message also renders
   * in the channel timeline, so a document-wide id lookup can pick that copy
   * and size the export to the wrong column.
   */
  scope?: ParentNode | null;
  /** Internal page slices used after the full selection exceeds the budget. */
  pageSegments?: readonly ScreenshotPageSegment[];
  pageNumber?: number;
  pageCount?: number;
  /** Internal: image reads shared by every page of one capture. */
  imageReads?: ScreenshotImageReads;
}

export type ScreenshotCapturePhase = "preparing" | "rendering" | "validating";

export interface ScreenshotCaptureProgress {
  phase: ScreenshotCapturePhase;
  pageNumber: number;
  pageCount: number;
}

export interface CaptureSelectedMessageImagesOptions extends CaptureOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ScreenshotCaptureProgress) => void;
}

class MeasuredScreenshotNeedsPaginationError extends ScreenshotNeedsPaginationError {
  readonly messageMeasures: readonly ScreenshotMessageMeasure[];
  readonly pageChromeCssHeight: number;

  constructor(
    plan: ConstructorParameters<typeof ScreenshotNeedsPaginationError>[0],
    messageMeasures: readonly ScreenshotMessageMeasure[],
    pageChromeCssHeight: number,
  ) {
    super(plan);
    this.name = "MeasuredScreenshotNeedsPaginationError";
    this.messageMeasures = messageMeasures;
    this.pageChromeCssHeight = pageChromeCssHeight;
  }
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
  // Reactions are useful live conversation state, but Cindy explicitly keeps
  // them out of the durable share artifact. The semantic marker lives on the
  // whole chip so both interactive and read-only variants are removed.
  '[data-select-screenshot-reaction="true"]',
  // A human's server role is useful live workspace chrome, but Cindy keeps it
  // out of the exported share artifact. Human-authored profile descriptions
  // remain; only the role fallback receives this marker.
  '[data-select-screenshot-human-role="true"]',
  // Viewer-only previews. A share image is public, so it never includes what
  // was resolved for this viewer about something the message names: what this
  // viewer may see is not what everyone who sees the image may see. Inline
  // chips go back to the author's link (`data-app-link-chip-url` below); any
  // other such preview marks its root `data-select-screenshot-viewer-only`
  // and is removed whole: first-party object cards (an Artifact's card under
  // a message, its "Saved as Artifact" lines) and the quote preview of a
  // linked message (MessageItem's wrapper, so every state of it and its margin
  // go). App link previews predate the marker and keep their own (the next
  // three).
  '[data-select-screenshot-viewer-only="true"]',
  // App link hover cards are third-party data resolved for this viewer only
  // (e.g. a private issue title). Share artifacts are public; the chips go
  // back to the message's own links first (sanitizeClonedMessageForScreenshot).
  "[data-app-link-preview]",
  // The same viewer-only slot: the viewer's own consent prompt for an App, and
  // the placeholder of a card loading after they allowed it.
  "[data-app-link-preview-prompt]",
  "[data-app-link-preview-pending]",
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
    content.classList.remove("relative", "overflow-clip", "mask-fade-b");
    content.style.removeProperty("max-height");
  }

  clone.querySelectorAll([
    "[data-message-content-toggle]",
    "[data-message-content-toggle-placeholder]",
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
function replaceInteractiveElementWithStaticSpan(element: HTMLElement): void {
  const replacement = document.createElement("span");
  const visibleText = (element.textContent ?? "").trim();
  const taskNumber = visibleText.match(/^#?(\d+)$/)?.[1];
  replacement.textContent = taskNumber ? `task #${taskNumber}` : visibleText;
  replacement.className = "font-mono font-bold text-foreground";
  replacement.setAttribute("data-select-screenshot-static-ref", "true");
  element.replaceWith(replacement);
}

/**
 * Normalize a cloned MessageItem into a durable reading artifact.
 *
 * Keep readable message content, but remove reactions and source-surface state
 * (task status, saved/read/thread badges and interactive chrome). Attachments
 * become a compact filename list so a gallery/player/document preview cannot
 * dominate the exported pages or introduce another asynchronous render path.
 */
export function sanitizeClonedMessageForScreenshot(clone: HTMLElement): void {
  clone.querySelectorAll<HTMLElement>('[data-select-screenshot-attachment-content="true"]')
    .forEach((node) => node.remove());
  clone.querySelectorAll<HTMLElement>('[data-select-screenshot-attachment-summary="true"]')
    .forEach((summary) => {
      summary.classList.remove("hidden");
      summary.removeAttribute("aria-hidden");
      summary.style.display = "flex";
      summary.style.flexWrap = "wrap";
      summary.style.gap = "6px";
      summary.style.marginTop = "6px";
    });

  // Action cards are executable UI on the live message surface. A durable
  // image keeps only the header's action title and completed-result sentence;
  // runtime status, collapse controls, scopes, properties, errors, and action
  // buttons are interaction state rather than message content.
  clone.querySelectorAll<HTMLElement>('[data-select-screenshot-action-detail="true"], [data-select-screenshot-action-control="true"]')
    .forEach((node) => node.remove());

  // Footer task chips carry runtime status and are excluded. Inline task refs
  // use the same affordance marker, so preserve their visible `task #N` text
  // as a static span before the generic affordance strip runs.
  clone.querySelectorAll<HTMLElement>('[data-message-affordance="open-linked-task"]')
    .forEach((node) => {
      if (node.querySelector('[data-testid="message-task-badge"]')) {
        node.remove();
      } else {
        replaceInteractiveElementWithStaticSpan(node);
      }
    });

  // A link chip names what the link points to as this viewer resolved it: an
  // App link chip the App's data (its title), a Raft message link the
  // conversation (a private channel's name, a DM peer's). The public artifact
  // shows the link the author wrote instead: its address, or the words the
  // author gave it (`data-select-screenshot-author-text`).
  clone.querySelectorAll<HTMLElement>("[data-app-link-chip-url], [data-select-screenshot-author-link]")
    .forEach((chip) => {
      const url = chip.getAttribute("data-select-screenshot-author-link") ?? chip.getAttribute("data-app-link-chip-url") ?? "";
      const link = document.createElement("a");
      link.href = url;
      link.textContent = chip.getAttribute("data-select-screenshot-author-text") || url;
      link.className = "text-foreground-link underline decoration-2 underline-offset-2 decoration-foreground-link/40";
      chip.replaceWith(link);
    });

  // Drop transient UI.
  for (const sel of STRIP_SELECTORS) {
    clone.querySelectorAll(sel).forEach((n) => n.remove());
  }

  // Drop the row container's interactive affordance (`group`) and its
  // positioning context.
  clone.classList.remove("group", "relative");
  // Border and wash vary by selection / hover / jump-highlight state; force a
  // clean transparent frame so clones stack calmly without double lines.
  clone.style.border = "2px solid transparent";
  clone.style.marginBottom = "4px";
  clone.style.background = "transparent";
}

function sanitizeClone(clone: HTMLElement): void {
  sanitizeClonedMessageForScreenshot(clone);
}

function createContinuationMarker(direction: "previous" | "next"): HTMLElement {
  const marker = document.createElement("div");
  marker.setAttribute("data-select-screenshot-continuation", direction);
  marker.textContent = direction === "previous" ? "↑ …" : "… ↓";
  marker.style.height = "24px";
  marker.style.display = "flex";
  marker.style.alignItems = "center";
  marker.style.justifyContent = "center";
  marker.style.fontFamily = "'Space Mono', ui-monospace, monospace";
  marker.style.fontSize = "11px";
  marker.style.fontWeight = "700";
  marker.style.color = "#141111";
  marker.style.letterSpacing = "0.08em";
  return marker;
}

function appendScreenshotSegment(
  contentArea: HTMLElement,
  clone: HTMLElement,
  segment: ScreenshotPageSegment | undefined,
): void {
  if (!segment || (!segment.continuedFromPrevious && !segment.continuesOnNext)) {
    contentArea.appendChild(clone);
    return;
  }

  const segmentRoot = document.createElement("div");
  segmentRoot.setAttribute("data-select-screenshot-segment", segment.messageId);
  if (segment.continuedFromPrevious) {
    segmentRoot.appendChild(createContinuationMarker("previous"));
  }
  const viewport = document.createElement("div");
  viewport.style.height = `${segment.cssHeight}px`;
  viewport.style.overflow = "hidden";
  viewport.style.position = "relative";
  clone.style.marginBottom = "0";
  clone.style.transform = `translateY(-${segment.sourceOffsetTop}px)`;
  clone.style.transformOrigin = "top left";
  viewport.appendChild(clone);
  segmentRoot.appendChild(viewport);
  if (segment.continuesOnNext) {
    segmentRoot.appendChild(createContinuationMarker("next"));
  }
  contentArea.appendChild(segmentRoot);
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

function findSelectedMessageRow(id: string, scope?: ParentNode | null): HTMLElement | null {
  return scope?.querySelector<HTMLElement>(`[id="message-${id}"]`) ?? document.getElementById(`message-${id}`);
}

function missingSelectedMessageIds(messageIds: readonly string[], scope?: ParentNode | null): string[] {
  return messageIds.filter((id) => !findSelectedMessageRow(id, scope));
}

const ROWS_MOUNT_TIMEOUT_MS = 2_000;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * Make sure every selected message has its row in the DOM before a capture:
 * the virtual timeline mounts only the rows near the view, so a selection the
 * reader scrolled through has rows that are not mounted. While any is
 * missing, every timeline mounts all of its rows (timelineMountAll) until the
 * returned release is called. A message whose row is still missing after that
 * fails the capture (SelectScreenshotRowsMissingError): never a partial image.
 */
export async function ensureSelectedMessageRowsMounted(
  messageIds: readonly string[],
  scope?: ParentNode | null,
  signal?: AbortSignal,
): Promise<() => void> {
  if (missingSelectedMessageIds(messageIds, scope).length === 0) return () => {};
  const release = requestAllTimelineRowsMounted();
  try {
    const deadline = performance.now() + ROWS_MOUNT_TIMEOUT_MS;
    let missing = missingSelectedMessageIds(messageIds, scope);
    while (missing.length > 0 && performance.now() < deadline) {
      await nextFrame();
      throwIfCaptureAborted(signal);
      missing = missingSelectedMessageIds(messageIds, scope);
    }
    if (missing.length > 0) throw new SelectScreenshotRowsMissingError(missing, messageIds.length);
    // One more frame: the rows mounted in the last one are laid out and
    // their images have started loading.
    await nextFrame();
    throwIfCaptureAborted(signal);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

// The message ids of the rows the last share capture rendered (its input,
// every page), for the e2e hook (window.__SLOCK_E2E__.readLastCaptureMessageIds).
let lastCaptureMessageIds = new Set<string>();
export function readLastCaptureMessageIds(): string[] {
  return [...lastCaptureMessageIds];
}

/**
 * Live rows for the selected ids in document order, preferring rows inside
 * `scope` (the panel the selection was made in) over same-id rows elsewhere.
 */
export function findSelectedMessageRows(messageIds: readonly string[], scope?: ParentNode | null): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  for (const id of messageIds) {
    const el = findSelectedMessageRow(id, scope);
    if (el) nodes.push(el);
  }
  return nodes.sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

/**
 * Render the selected messages to one PNG that has passed
 * `validateScreenshotPng`. Throws `ScreenshotNeedsPaginationError` when even
 * 1x is over the pixel budget (no over-budget render is attempted) and
 * `ScreenshotInvalidOutputError` when the engine returned an unusable image.
 */
export async function captureSelectedMessageImage(
  messageIds: string[],
  options: CaptureOptions = {},
): Promise<ValidatedScreenshot> {
  return withCaptureTimeout(captureSelectedMessagesUnsafe(messageIds, options), options.timeoutMs);
}

function throwIfCaptureAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Capture cancelled", "AbortError");
}

/**
 * Capture one or more validated PNG pages. The first attempt keeps the legacy
 * single-image path; only a selection that cannot fit at 1x is paginated.
 * Page breaks prefer message boundaries. A single oversize row is clipped into
 * complete ordered slices with visible continuation markers.
 */
export async function captureSelectedMessageImages(
  messageIds: string[],
  options: CaptureSelectedMessageImagesOptions = {},
): Promise<ValidatedScreenshot[]> {
  const { signal, onProgress, ...captureOptions } = options;
  throwIfCaptureAborted(signal);
  onProgress?.({ phase: "preparing", pageNumber: 0, pageCount: 1 });
  throwIfCaptureAborted(signal);
  lastCaptureMessageIds = new Set();
  const releaseRows = await ensureSelectedMessageRowsMounted(messageIds, captureOptions.scope, signal);
  try {
    return await captureSelectedMountedMessageImages(messageIds, captureOptions, signal, onProgress);
  } finally {
    releaseRows();
  }
}

async function captureSelectedMountedMessageImages(
  messageIds: string[],
  pageOptions: CaptureOptions,
  signal: AbortSignal | undefined,
  onProgress: CaptureSelectedMessageImagesOptions["onProgress"],
): Promise<ValidatedScreenshot[]> {
  // The single-page attempt and every page read each image once between them.
  const captureOptions: CaptureOptions = { ...pageOptions, imageReads: pageOptions.imageReads ?? new Map() };
  try {
    onProgress?.({ phase: "rendering", pageNumber: 1, pageCount: 1 });
    throwIfCaptureAborted(signal);
    const single = await captureSelectedMessageImage(messageIds, captureOptions);
    throwIfCaptureAborted(signal);
    onProgress?.({ phase: "validating", pageNumber: 1, pageCount: 1 });
    return [single];
  } catch (error) {
    if (!(error instanceof ScreenshotNeedsPaginationError)) throw error;

    const nodes = findSelectedMessageRows(messageIds, captureOptions.scope);
    if (nodes.length === 0) throw error;
    const fallbackChromeCssHeight = 80;
    let pageChromeCssHeight = fallbackChromeCssHeight;
    let measures: readonly ScreenshotMessageMeasure[];
    if (error instanceof MeasuredScreenshotNeedsPaginationError) {
      pageChromeCssHeight = error.pageChromeCssHeight;
      measures = error.messageMeasures;
    } else {
      const liveHeights = nodes.map((node) => Math.max(
        1,
        node.getBoundingClientRect().height,
        node.scrollHeight,
        node.offsetHeight,
      ));
      const totalLiveHeight = liveHeights.reduce((sum, height) => sum + height, 0);
      const measuredContentHeight = Math.max(1, error.plan.cssHeight - pageChromeCssHeight);
      measures = nodes.map((node, index) => ({
        id: node.id.replace(/^message-/, ""),
        cssHeight: measuredContentHeight * ((liveHeights[index] ?? 1) / totalLiveHeight),
      }));
    }
    const pages = planScreenshotPages(measures, {
      cssWidth: error.plan.cssWidth,
      pageChromeCssHeight,
      continuationChromeCssHeight: 24,
      preferredPixelRatio: resolveCapturePixelRatio(captureOptions.pixelRatio),
    });

    const images: ValidatedScreenshot[] = [];
    for (const page of pages) {
      throwIfCaptureAborted(signal);
      onProgress?.({ phase: "rendering", pageNumber: page.pageNumber, pageCount: page.pageCount });
      throwIfCaptureAborted(signal);
      const image = await captureSelectedMessageImage(
        page.segments.map((segment) => segment.messageId),
        {
          ...captureOptions,
          pageSegments: page.segments,
          pageNumber: page.pageNumber,
          pageCount: page.pageCount,
        },
      );
      throwIfCaptureAborted(signal);
      onProgress?.({ phase: "validating", pageNumber: page.pageNumber, pageCount: page.pageCount });
      images.push(image);
    }
    return images;
  }
}

/** Data-URL form of `captureSelectedMessageImage`, for the e2e test hook. */
export async function captureSelectedMessages(
  messageIds: string[],
  options: CaptureOptions = {},
): Promise<string> {
  return (await captureSelectedMessageImage(messageIds, options)).dataUrl;
}

async function captureSelectedMessagesUnsafe(
  messageIds: string[],
  options: CaptureOptions = {},
): Promise<ValidatedScreenshot> {
  if (messageIds.length === 0) {
    throw new Error("captureSelectedMessages: no message ids");
  }

  const nodes = findSelectedMessageRows(messageIds, options.scope);
  if (nodes.length === 0) {
    throw new Error("captureSelectedMessages: no DOM matches");
  }
  for (const node of nodes) lastCaptureMessageIds.add(node.id.replace(/^message-/, ""));
  const transientMessageIds = nodes
    .filter((node) => node.querySelector('[data-select-screenshot-transient-state="true"]'))
    .map((node) => node.id.replace(/^message-/, ""));
  if (transientMessageIds.length > 0) {
    throw new SelectScreenshotTransientContentError(transientMessageIds);
  }

  // Match the live surface so cloned dark-theme text keeps its original contrast.
  const surface = resolveScreenshotSurface(nodes[0]);
  const bg = options.backgroundColor ?? surface.backgroundColor;

  // Track the LIVE MESSAGE ROW's own rendered width — not the chat column /
  // parent's. Measuring the parent (chat column) lets the off-screen container
  // become wider than where the row was actually laid out (parent padding,
  // flex-1 sibling siblings, max-w constraints), which causes inline
  // children like the message reference chips (`#proj-growth` etc.) to
  // re-layout inside
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
  container.style.zIndex = "var(--z-index-below)";
  container.style.width = `${liveWidth}px`;
  container.style.padding = "0";
  container.style.background = bg;
  container.style.fontFamily = getComputedStyle(document.body).fontFamily;
  container.style.color = surface.color;
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
  domain.textContent = options.pageCount && options.pageCount > 1
    ? `raft.build · ${options.pageNumber ?? 1}/${options.pageCount}`
    : "raft.build";
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

  const pageSegments = new Map(
    (options.pageSegments ?? []).map((segment) => [segment.messageId, segment]),
  );
  const disposeSnapshots: Array<() => void> = [];
  try {
    for (const node of nodes) {
      const id = node.getAttribute("id")?.replace(/^message-/, "") ?? "";
      const clone = node.cloneNode(true) as HTMLElement;
      sanitizeClone(clone);
      expandClonedMessageContentForScreenshot(clone);
      freezeCloneRenderedBoxes(node, clone);
      disposeSnapshots.push(await materializeDomCaptureSnapshots(node, clone));
      appendScreenshotSegment(contentArea, clone, pageSegments.get(id));
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

    // The image document cannot reach the page's web fonts, so the app's own
    // faces are embedded as data URLs (selectScreenshotFonts.ts; built once a
    // session, bounded, and optional). Start it now, use it at rasterization.
    const fontEmbedCss = getScreenshotFontEmbedCss();

    // Wait briefly for page fonts (the live layout the clone copies), but
    // never let font loading own the share action.
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
    // Pixel avatars are already <img> data URLs (PixelAvatar), so they go
    // through the same image inlining as everything else.
    const imgs = Array.from(container.querySelectorAll("img")) as HTMLImageElement[];
    await inlineImagesForScreenshot(imgs, options.imageReads);

    // Root needs an explicit height so the SVG wrapper knows how tall
    // to make its viewBox. Without it, some browsers clip to content
    // height but leave an uninitialized pixel buffer around the edges,
    // which reads as "blank" on small outputs.
    const liveHeight = container.offsetHeight;

    // Over an engine's canvas budget the render does not fail, it comes back
    // empty. Pick the highest ratio that fits the shared budget, and never
    // attempt a render that does not fit (task #1302).
    const plan = planScreenshotPixelRatio(liveWidth, liveHeight, resolveCapturePixelRatio(options.pixelRatio));
    if (plan.kind === "needsPagination") {
      const messageMeasures = Array.from(contentArea.children).map((child, index) => {
        const element = child as HTMLElement;
        const style = getComputedStyle(element);
        const marginTop = Number.parseFloat(style.marginTop) || 0;
        const marginBottom = Number.parseFloat(style.marginBottom) || 0;
        return {
          id: nodes[index]?.id.replace(/^message-/, "") ?? String(index),
          cssHeight: Math.max(1, element.getBoundingClientRect().height, element.offsetHeight) + marginTop + marginBottom,
        };
      });
      const measuredMessagesCssHeight = messageMeasures.reduce((sum, message) => sum + message.cssHeight, 0);
      const pageChromeCssHeight = Math.max(1, liveHeight - measuredMessagesCssHeight);
      throw new MeasuredScreenshotNeedsPaginationError(plan, messageMeasures, pageChromeCssHeight);
    }

    const dataUrl = await toPng(container, {
      backgroundColor: bg,
      pixelRatio: plan.pixelRatio,
      // `cacheBust: true` re-fetches every img/font URL with a unique
      // query string, which defeats the decode() wait above (the new
      // URL gets a fresh pending fetch). Turn it off — we've already
      // waited for the live images to decode.
      cacheBust: false,
      // Our embedded faces. html-to-image's own pass (skipFonts) stays off: it
      // fetches every stylesheet, third-party ones included (#7024). Without
      // embedded CSS the image falls back to system fonts, as before.
      fontEmbedCSS: (await fontEmbedCss) ?? undefined,
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
    return await validateScreenshotPng(dataUrl, plan.pixelRatio);
  } finally {
    container.remove();
    for (const dispose of disposeSnapshots.reverse()) dispose();
  }
}
