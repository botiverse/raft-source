import { useCallback, useEffect, useRef, useState } from "react";

// Parent half of the untrusted measurement bridge for sandboxed HTML
// previews (attachment comments task #16 slice 2; security contract
// #wg-comment:ba106cab). The server appends a static reporter script to the
// html-preview response; this hook owns the parent side.
//
// Trust model: every inbound message is HOSTILE INPUT — the script runs
// inside attacker-controlled HTML. The gates, in order:
// 1. event.source === the active iframe's contentWindow (the real identity
//    check; event.origin is an opaque-origin null and unusable)
// 2. protocol marker + per-preview nonce (instance isolation, NOT
//    authentication — the document can read its own URL)
// 3. parent-minted per-load document epoch (rejects reports queued by the
//    document that was replaced inside the same contentWindow)
// 4. every number must be finite and is clamped to [0, MAX_COORD]
// Geometry only feeds coordinate math, scroll hints, the flash marker, and
// parent-owned external-link hotspots. The hostile document can forge every
// href and rect; the caller separately validates URLs, clips the overlay to
// the preview, and opens a tab only from a click on a parent-owned hotspot.

export type BridgeState = {
  scrollX: number;
  scrollY: number;
  docWidth: number;
  docHeight: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type LocatedRect = { x: number; y: number; w: number; h: number };

export type ExternalLinkHotspot = {
  href: string;
  text: string;
  rects: LocatedRect[];
};

const MAX_COORD = 10_000_000;
const MAX_EXTERNAL_HREF = 4097;
const MAX_EXTERNAL_LINKS = 64;
const MAX_EXTERNAL_LINK_RECTS = 8;

function clampedNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(value, MAX_COORD));
}

function plainText(value: unknown, maxLength: number): string {
  const raw = typeof value === "string" ? value.slice(0, maxLength) : "";
  return Array.from(raw)
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp < 32 || cp === 127 ? " " : ch;
    })
    .join("")
    .trim();
}

export function parseExternalLinkHotspots(value: unknown): ExternalLinkHotspot[] | null {
  if (!Array.isArray(value)) return null;
  const links: ExternalLinkHotspot[] = [];
  for (const raw of value.slice(0, MAX_EXTERNAL_LINKS)) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Record<string, unknown>;
    const href = plainText(candidate.href, MAX_EXTERNAL_HREF);
    if (!href || !Array.isArray(candidate.rects)) continue;
    const rects: LocatedRect[] = [];
    for (const rawRect of candidate.rects.slice(0, MAX_EXTERNAL_LINK_RECTS)) {
      if (!rawRect || typeof rawRect !== "object") continue;
      const candidateRect = rawRect as Record<string, unknown>;
      const x = clampedNumber(candidateRect.x);
      const y = clampedNumber(candidateRect.y);
      const w = clampedNumber(candidateRect.w);
      const h = clampedNumber(candidateRect.h);
      if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) continue;
      rects.push({ x, y, w, h });
    }
    if (!rects.length) continue;
    links.push({ href, text: plainText(candidate.text, 200), rects });
  }
  return links;
}

export function useAttachmentPreviewBridge() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [nonce] = useState(() => crypto.randomUUID());
  const activeDocumentEpochRef = useRef<string | null>(null);
  const [state, setState] = useState<BridgeState | null>(null);
  const [externalLinkState, setExternalLinkState] = useState<{
    links: ExternalLinkHotspot[];
    ready: boolean;
  }>({ links: [], ready: false });
  // Ref mirror so imperative consumers (jump handler) read the latest
  // geometry without re-registering on every bridge report.
  const stateRef = useRef<BridgeState | null>(null);
  stateRef.current = state;

  // Pending describe requests by id; resolved (or timed out to null) from the
  // message listener below.
  const describeRequestsRef = useRef(new Map<number, (text: string | null) => void>());
  const describeSeqRef = useRef(0);
  // Pending locate requests by id (re-anchor a region by its stored quote in
  // the current layout, #29); resolved to a rect or null (miss/timeout) below.
  const locateRequestsRef = useRef(new Map<number, (rect: LocatedRect | null) => void>());
  const locateSeqRef = useRef(0);

  // An iframe element and contentWindow survive top-level self-navigation, so
  // source + preview nonce alone cannot reject messages that the old document
  // queued before it unloaded. Mint a parent-owned epoch only after each load,
  // activate the current reporter with it, and require the epoch on every
  // subsequent report. The unloaded document never learns the new value.
  const activateDocument = useCallback(() => {
    const documentEpoch = crypto.randomUUID();
    activeDocumentEpochRef.current = documentEpoch;
    stateRef.current = null;
    setState(null);
    setExternalLinkState({ links: [], ready: false });
    for (const resolve of describeRequestsRef.current.values()) resolve(null);
    describeRequestsRef.current.clear();
    for (const resolve of locateRequestsRef.current.values()) resolve(null);
    locateRequestsRef.current.clear();
    iframeRef.current?.contentWindow?.postMessage(
      { slockAcBridge: 1, nonce, type: "activate-document", documentEpoch },
      "*",
    );
  }, [nonce]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || ev.source !== frame.contentWindow) return;
      const d = ev.data as Record<string, unknown> | null;
      if (!d || d.slockAcBridge !== 1 || d.nonce !== nonce) return;
      if (typeof d.documentEpoch !== "string" || d.documentEpoch !== activeDocumentEpochRef.current) return;
      if (d.type === "external-links") {
        const parsed = parseExternalLinkHotspots(d.links);
        if (parsed === null) return;
        setExternalLinkState({ links: parsed, ready: true });
        return;
      }
      if (d.type === "described") {
        const requestId = typeof d.requestId === "number" ? d.requestId : null;
        const resolve = requestId !== null ? describeRequestsRef.current.get(requestId) : undefined;
        if (resolve && requestId !== null) {
          describeRequestsRef.current.delete(requestId);
          // Hostile text: cap hard, strip control chars; consumers render it
          // as plain text only (chip label / tooltip), never as markup.
          // Strip control characters without a control-char regex
          // (eslint no-control-regex): filter by code point instead.
          const text = plainText(d.text, 200);
          resolve(text.length > 0 ? text : null);
        }
        return;
      }
      if (d.type === "located") {
        const requestId = typeof d.requestId === "number" ? d.requestId : null;
        const resolve = requestId !== null ? locateRequestsRef.current.get(requestId) : undefined;
        if (resolve && requestId !== null) {
          locateRequestsRef.current.delete(requestId);
          // The reporter signals "not found" with x < 0; clampedNumber would
          // floor that to 0, so check the raw sentinel first, then clamp.
          const rawX = typeof d.x === "number" ? d.x : -1;
          const x = clampedNumber(d.x);
          const y = clampedNumber(d.y);
          const w = clampedNumber(d.w);
          const h = clampedNumber(d.h);
          resolve(rawX >= 0 && x !== null && y !== null && w !== null && h !== null ? { x, y, w, h } : null);
        }
        return;
      }
      if (d.type !== "state") return;
      const scrollX = clampedNumber(d.scrollX);
      const scrollY = clampedNumber(d.scrollY);
      const docWidth = clampedNumber(d.docWidth);
      const docHeight = clampedNumber(d.docHeight);
      const viewportWidth = clampedNumber(d.viewportWidth);
      const viewportHeight = clampedNumber(d.viewportHeight);
      if (
        scrollX === null || scrollY === null
        || docWidth === null || docWidth <= 0
        || docHeight === null || docHeight <= 0
        || viewportWidth === null || viewportWidth <= 0
        || viewportHeight === null || viewportHeight <= 0
      ) {
        return;
      }
      setState({ scrollX, scrollY, docWidth, docHeight, viewportWidth, viewportHeight });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [nonce]);

  // Outbound scroll hint. targetOrigin must be "*": the sandboxed document
  // has an opaque origin which no concrete origin string matches. The
  // payload is a non-sensitive UX command (coordinates only).
  const scrollTo = useCallback(
    (x: number, y: number) => {
      iframeRef.current?.contentWindow?.postMessage(
        { slockAcBridge: 1, nonce, documentEpoch: activeDocumentEpochRef.current, type: "scrollTo", x, y },
        "*",
      );
    },
    [nonce],
  );

  const scrollBy = useCallback(
    (dx: number, dy: number) => {
      iframeRef.current?.contentWindow?.postMessage(
        { slockAcBridge: 1, nonce, documentEpoch: activeDocumentEpochRef.current, type: "scrollBy", dx, dy },
        "*",
      );
    },
    [nonce],
  );

  // Ask the document for a text snippet inside a content-coordinate region so
  // anchor chips can read like quotes instead of raw coordinates. Resolves
  // null on timeout — the hostile document is under no obligation to answer,
  // and capture must never block on its cooperation.
  const describe = useCallback(
    (x: number, y: number, w = 0, h = 0) =>
      new Promise<string | null>((resolve) => {
        const frame = iframeRef.current;
        if (!frame?.contentWindow) {
          resolve(null);
          return;
        }
        const requestId = ++describeSeqRef.current;
        describeRequestsRef.current.set(requestId, resolve);
        // setTimeout as request timeout: 400ms keeps the capture gesture
        // snappy when the document ignores or delays the describe request.
        window.setTimeout(() => {
          if (describeRequestsRef.current.delete(requestId)) resolve(null);
        }, 400);
        frame.contentWindow.postMessage(
          {
            slockAcBridge: 1,
            nonce,
            documentEpoch: activeDocumentEpochRef.current,
            type: "describe",
            x,
            y,
            w,
            h,
            requestId,
          },
          "*",
        );
      }),
    [nonce],
  );

  // Re-anchor a previously captured html-region by its stored quote text in the
  // current layout, so the marker tracks content reflow on resize (#29).
  // Resolves null on miss/timeout — callers fall back to the stored coordinates.
  const locate = useCallback(
    (quote: string, nearY?: number) =>
      new Promise<LocatedRect | null>((resolve) => {
        const frame = iframeRef.current;
        if (!frame?.contentWindow || !quote) {
          resolve(null);
          return;
        }
        const requestId = ++locateSeqRef.current;
        locateRequestsRef.current.set(requestId, resolve);
        window.setTimeout(() => {
          if (locateRequestsRef.current.delete(requestId)) resolve(null);
        }, 400);
        frame.contentWindow.postMessage(
          {
            slockAcBridge: 1,
            nonce,
            documentEpoch: activeDocumentEpochRef.current,
            type: "locate",
            quote,
            requestId,
            // Duplicate-quote disambiguation: the reporter prefers the
            // occurrence closest to the anchor's stored content-y (#29
            // runtime verify red — smallest-element pick hit the wrong
            // instance). Our own stored number, echoed to our own script.
            ...(typeof nearY === "number" && Number.isFinite(nearY) ? { nearY } : {}),
          },
          "*",
        );
      }),
    [nonce],
  );

  // The injected script is inert unless these params are present, so
  // non-comment surfaces that reuse the same URL builder stay no-ops.
  const buildSrc = useCallback(
    (url: string) => {
      try {
        const u = new URL(url);
        u.searchParams.set("acBridgeNonce", nonce);
        u.searchParams.set("acBridgeParentOrigin", window.location.origin);
        return u.toString();
      } catch {
        return url;
      }
    },
    [nonce],
  );

  return {
    iframeRef,
    state,
    stateRef,
    externalLinks: externalLinkState.links,
    externalLinksReady: externalLinkState.ready,
    scrollTo,
    scrollBy,
    describe,
    locate,
    buildSrc,
    activateDocument,
  };
}
