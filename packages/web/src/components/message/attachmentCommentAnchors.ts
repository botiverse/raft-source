// Structural anchors for attachment comments (spec §3/§8, task #15).
//
// Client mirror of the server's closed anchor vocabulary
// (attachmentCommentService.ANCHOR_TYPES). Capture is DOM-annotation driven:
// native preview renderers mark their structure (data-anchor-line on text
// lines, data-anchor-row on csv rows, heading ids inside the
// data-anchor-md-root markdown card) and this module maps a user selection
// to the nearest structural location — no renderer-specific logic leaks into
// the preview shell. HTML iframe previews cannot be captured here by design
// (sandbox boundary); they get coordinate anchors with comment mode
// (task #16).

import type { IntlShape } from "react-intl";

type FormatMessage = IntlShape["formatMessage"];

export type CommentAnchor =
  | { type: "md-section"; data: { headingId: string; headingTitle: string; quote?: string } }
  | { type: "lines"; data: { start: number; end: number; quote?: string } }
  | { type: "csv-rows"; data: { start: number; end: number; quote?: string } }
  | {
      type: "html-region";
      data: {
        x: number;
        y: number;
        w: number;
        h: number;
        viewportWidth: number;
        documentWidth: number;
        documentHeight: number;
        quote?: string;
      };
    }
  | { type: "video-timestamp"; data: { time: number } };

/** Loose shape as returned by the API (server validates the vocabulary). */
export type StoredAnchor = { type: string; data: Record<string, unknown> };

// Anchors carry a SHORT context quote, never document content — the server
// caps anchor_data at 4KB and rejects oversized payloads outright.
const MAX_QUOTE_LENGTH = 400;

function trimQuote(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_QUOTE_LENGTH ? `${trimmed.slice(0, MAX_QUOTE_LENGTH)}…` : trimmed;
}

function closestWithAttr(node: Node | null, attr: string): HTMLElement | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return (el?.closest(`[${attr}]`) as HTMLElement | null) ?? null;
}

function numericRange(
  startEl: HTMLElement,
  endEl: HTMLElement,
  attr: string,
): { start: number; end: number } | null {
  const a = Number(startEl.getAttribute(attr));
  const b = Number(endEl.getAttribute(attr));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/**
 * Map the current window selection to a structural anchor, or null when the
 * selection is empty or lies outside any annotated preview structure.
 */
export function captureSelectionAnchor(): CommentAnchor | null {
  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const quote = trimQuote(selection.toString());

  const startLine = closestWithAttr(range.startContainer, "data-anchor-line");
  const endLine = closestWithAttr(range.endContainer, "data-anchor-line");
  if (startLine && endLine) {
    const lines = numericRange(startLine, endLine, "data-anchor-line");
    if (lines) return { type: "lines", data: { ...lines, quote } };
  }

  const startRow = closestWithAttr(range.startContainer, "data-anchor-row");
  const endRow = closestWithAttr(range.endContainer, "data-anchor-row");
  if (startRow && endRow) {
    const rows = numericRange(startRow, endRow, "data-anchor-row");
    if (rows) return { type: "csv-rows", data: { ...rows, quote } };
  }

  // Markdown: anchor to the nearest heading at or before the selection start.
  const mdRoot = closestWithAttr(range.startContainer, "data-anchor-md-root");
  if (mdRoot) {
    const nearest = nearestMarkdownHeading(range.startContainer, mdRoot);
    if (nearest?.id) {
      return {
        type: "md-section",
        data: { headingId: nearest.id, headingTitle: nearest.textContent?.trim() || nearest.id, quote },
      };
    }
  }

  return null;
}

function nearestMarkdownHeading(node: Node, mdRoot: HTMLElement): HTMLElement | null {
  const headings = Array.from(mdRoot.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id]"));
  let nearest: HTMLElement | null = null;
  for (const heading of headings) {
    const pos = heading.compareDocumentPosition(node);
    const precedesOrContains =
      (pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 || (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) !== 0;
    if (precedesOrContains) nearest = heading;
    else break;
  }
  return nearest;
}

/**
 * Map a TAPPED node to a structural anchor (tap-to-structure, task #26):
 * the line / row / nearest section the tap landed on, with that structure's
 * own text as the context quote. Returns null outside annotated structures.
 */
export function captureNodeAnchor(node: Node): CommentAnchor | null {
  const line = closestWithAttr(node, "data-anchor-line");
  if (line) {
    const n = Number(line.getAttribute("data-anchor-line"));
    if (Number.isFinite(n)) {
      return { type: "lines", data: { start: n, end: n, quote: trimQuote(line.textContent ?? "") } };
    }
  }
  const row = closestWithAttr(node, "data-anchor-row");
  if (row) {
    const n = Number(row.getAttribute("data-anchor-row"));
    if (Number.isFinite(n)) {
      return { type: "csv-rows", data: { start: n, end: n, quote: trimQuote(row.textContent ?? "") } };
    }
  }
  const mdRoot = closestWithAttr(node, "data-anchor-md-root");
  if (mdRoot) {
    const nearest = nearestMarkdownHeading(node, mdRoot);
    if (nearest?.id) {
      const block = node instanceof Element ? node : node.parentElement;
      return {
        type: "md-section",
        data: {
          headingId: nearest.id,
          headingTitle: nearest.textContent?.trim() || nearest.id,
          quote: trimQuote(block?.textContent ?? ""),
        },
      };
    }
  }
  return null;
}

/** Short human label for an anchor chip: "§ Activation", "L12–18", "Rows 3–5". */
export function anchorLabel(anchor: StoredAnchor, formatMessage: FormatMessage): string {
  if (anchor.type === "md-section") {
    const title = anchor.data.headingTitle ?? anchor.data.headingId;
    return `§ ${typeof title === "string" && title ? title : formatMessage({ id: "message.attachment.sectionFallback" })}`;
  }
  if (anchor.type === "lines" || anchor.type === "csv-rows") {
    const start = Number(anchor.data.start);
    const end = Number(anchor.data.end ?? start);
    if (!Number.isFinite(start)) return anchor.type;
    if (anchor.type === "lines") {
      const prefix = formatMessage({ id: "message.attachment.linePrefix" });
      return start === (Number.isFinite(end) ? end : start)
        ? `${prefix}${start}`
        : `${prefix}${start}–${end}`;
    }
    return start === (Number.isFinite(end) ? end : start)
      ? formatMessage({ id: "message.attachmentAnchor.rowSingle" }, { n: start })
      : formatMessage({ id: "message.attachmentAnchor.rowRange" }, { start, end });
  }
  if (anchor.type === "html-region") {
    // Quote-first: text near the captured region (via the bridge describe
    // request) is what a reader recognizes — "~37%" was not (cindyz 6/10).
    const quote = anchor.data.quote;
    if (typeof quote === "string" && quote.trim().length > 0) {
      const trimmed = quote.trim();
      return trimmed.length > 36 ? `${trimmed.slice(0, 36)}…` : trimmed;
    }
    return formatMessage({ id: "message.attachmentAnchor.htmlRegion" });
  }
  if (anchor.type === "video-timestamp") {
    const time = Number(anchor.data.time);
    if (!Number.isFinite(time)) return formatMessage({ id: "message.attachment.timestampFallback" });
    const h = Math.floor(time / 3600);
    const m = Math.floor((time % 3600) / 60);
    const s = Math.floor(time % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }
  return anchor.type;
}

// html-region jumps need the live preview's bridge (scrollTo + flash layer),
// which only the mounted HTML preview owns. It registers a handler here;
// jumpToAnchor delegates. Registry over context because jump is invoked from
// the comments panel, which is deliberately renderer-agnostic.
let htmlRegionJumpHandler: ((anchor: StoredAnchor) => boolean) | null = null;

export function registerHtmlRegionJumpHandler(
  handler: ((anchor: StoredAnchor) => boolean) | null,
): void {
  htmlRegionJumpHandler = handler;
}

let videoTimestampJumpHandler: ((time: number) => boolean) | null = null;

export function registerVideoTimestampJumpHandler(
  handler: ((time: number) => boolean) | null,
): void {
  videoTimestampJumpHandler = handler;
}

let pendingVideoSeek: { attachmentId: string; time: number } | null = null;

export function setPendingVideoSeek(attachmentId: string, time: number): void {
  pendingVideoSeek = { attachmentId, time };
}

export function consumePendingVideoSeek(attachmentId: string): number | null {
  if (pendingVideoSeek?.attachmentId === attachmentId) {
    const time = pendingVideoSeek.time;
    pendingVideoSeek = null;
    return time;
  }
  return null;
}

export function parseTimestampLabel(label: string): number | null {
  const parts = label.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * Vertical document-order key for sorting comments by anchor position
 * (Figma-list presentation): lines/rows sort by their 1-based start, html
 * regions by content y, markdown sections by the live heading's offset
 * inside the active preview scope. null = unanchored (callers sink these).
 * One attachment = one format, so keys never mix coordinate spaces.
 */
export function anchorOrderKey(anchor: StoredAnchor): number | null {
  if (anchor.type === "lines" || anchor.type === "csv-rows") {
    const start = Number(anchor.data.start);
    return Number.isFinite(start) ? start : null;
  }
  if (anchor.type === "html-region") {
    const y = Number(anchor.data.y);
    return Number.isFinite(y) ? y : null;
  }
  if (anchor.type === "md-section") {
    const id = typeof anchor.data.headingId === "string" ? anchor.data.headingId : "";
    if (!id) return null;
    const scopes = document.querySelectorAll<HTMLElement>("[data-anchor-scope]");
    const root = scopes.length > 0 ? scopes[scopes.length - 1] : null;
    const el = root?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!el || !root) return null;
    return el.getBoundingClientRect().top - root.getBoundingClientRect().top;
  }
  if (anchor.type === "video-timestamp") {
    const time = Number(anchor.data.time);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

/** Anchor quote for tooltips, when present. */
export function anchorQuote(anchor: StoredAnchor): string | undefined {
  return typeof anchor.data.quote === "string" && anchor.data.quote ? anchor.data.quote : undefined;
}

// Cap how many sibling elements a multi-line flash decorates — jump targets
// the range start; the flash is orientation, not an exhaustive highlight.
const MAX_FLASH_ELEMENTS = 200;

/**
 * Scroll the open preview to the anchor's location and flash-highlight it.
 * Returns false when the target structure is not in the DOM (e.g. preview
 * truncated before the anchored line).
 */
export function jumpToAnchor(anchor: StoredAnchor): boolean {
  if (anchor.type === "html-region") {
    return htmlRegionJumpHandler ? htmlRegionJumpHandler(anchor) : false;
  }
  if (anchor.type === "video-timestamp") {
    const time = Number(anchor.data.time);
    if (!Number.isFinite(time)) return false;
    return videoTimestampJumpHandler ? videoTimestampJumpHandler(time) : false;
  }
  // Resolve inside the ACTIVE preview only (last open [data-anchor-scope]) so
  // a heading id or line marker in a background surface can never be hit.
  const scopes = document.querySelectorAll<HTMLElement>("[data-anchor-scope]");
  const root: ParentNode = scopes.length > 0 ? scopes[scopes.length - 1] : document;

  const targets: HTMLElement[] = [];
  if (anchor.type === "md-section") {
    const id = typeof anchor.data.headingId === "string" ? anchor.data.headingId : "";
    const el = id ? root.querySelector<HTMLElement>(`#${CSS.escape(id)}`) : null;
    if (el) targets.push(el);
  } else if (anchor.type === "lines" || anchor.type === "csv-rows") {
    const attr = anchor.type === "lines" ? "data-anchor-line" : "data-anchor-row";
    const start = Number(anchor.data.start);
    const end = Number(anchor.data.end ?? start);
    if (Number.isFinite(start)) {
      const last = Number.isFinite(end) ? Math.min(end, start + MAX_FLASH_ELEMENTS) : start;
      for (let n = start; n <= last; n++) {
        const el = root.querySelector<HTMLElement>(`[${attr}="${n}"]`);
        if (el) targets.push(el);
      }
    }
  }
  if (targets.length === 0) return false;

  targets[0].scrollIntoView({ behavior: "smooth", block: "center" });
  for (const el of targets) {
    // Restart the animation when jumping to the same anchor twice.
    el.classList.remove("anchor-flash");
    void el.offsetWidth;
    el.classList.add("anchor-flash");
    el.addEventListener("animationend", () => el.classList.remove("anchor-flash"), { once: true });
  }
  return true;
}
