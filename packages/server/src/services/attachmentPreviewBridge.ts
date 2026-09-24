import { Transform, type TransformCallback } from "node:stream";

// Untrusted measurement bridge for HTML attachment previews (attachment
// comments task #16 slice 2; security contract: #wg-comment:ba106cab).
//
// This static script is added only to the html-preview response — never to
// downloads or the stored object. It is normally appended after the original
// bytes. If the attachment supplies a CSP meta tag, the bridge is inserted
// immediately BEFORE that tag: meta CSP applies only to content parsed after
// it, so the bridge can install its inert listeners while the attachment's own
// stricter policy still governs all following document content. The server's
// preview CSP and opaque-origin iframe sandbox remain authoritative.
//
// Trust model — the script runs INSIDE the hostile document, so nothing it
// sends can be trusted and nothing it does grants authority:
// - it REPORTS geometry plus an untrusted inventory of external-link viewport
//   rects and performs window.scrollTo on request; the parent independently
//   validates every URL and owns the only clickable/window-opening elements
// - the per-preview nonce comes from the embedding client via the
//   acBridgeNonce query param and disambiguates preview instances; a separate
//   parent-minted per-load epoch rejects reports queued by the document that
//   was replaced inside the same contentWindow. Neither value authenticates
//   the hostile current document (it can read/observe both); the epoch is only
//   a lifecycle freshness gate. Authority stays in parent-owned clicks and
//   every payload remains hostile input.
// - postMessage targets the embedder origin passed via acBridgeParentOrigin,
//   falling back to "*" (the payload is non-sensitive geometry)
// - without the query params the script is inert, so non-comment preview
//   loads behave exactly as before
export const ATTACHMENT_PREVIEW_BRIDGE_SCRIPT = `
<script>(function () {
  "use strict";
  try {
    if (window.parent === window) return;
    var qs = new URLSearchParams(window.location.search);
    var nonce = qs.get("acBridgeNonce");
    if (!nonce) return;
    var parentOrigin = qs.get("acBridgeParentOrigin") || "*";
    // Parent-owned, per-load capability. contentWindow + nonce survive iframe
    // self-navigation, so the parent sends a fresh epoch only after load;
    // messages queued by the unloaded document cannot carry the new value.
    var documentEpoch = null;
    var MAX_QUOTE = 200;
    var MAX_EXTERNAL_LINKS = 64;
    var MAX_EXTERNAL_LINK_RECTS = 8;
    var normalizeText = function (value) {
      return (typeof value === "string" ? value : "").replace(/\\s+/g, " ").trim();
    };
    var isBoundary = function (ch) {
      return ch === "\\n" || ch === "\\r" || ch === "." || ch === "!" || ch === "?"
        || ch === "。" || ch === "！" || ch === "？" || ch === ";" || ch === "；";
    };
    var snippetFromTextNode = function (node, offset) {
      var raw = typeof (node && node.textContent) === "string" ? node.textContent : "";
      if (!normalizeText(raw)) return "";
      var i = typeof offset === "number" && isFinite(offset)
        ? Math.max(0, Math.min(raw.length, Math.floor(offset)))
        : 0;
      while (i < raw.length && /\\s/.test(raw.charAt(i))) i++;
      if (i >= raw.length) {
        i = Math.max(0, Math.min(raw.length - 1, (typeof offset === "number" ? Math.floor(offset) : raw.length) - 1));
        while (i > 0 && /\\s/.test(raw.charAt(i))) i--;
      }
      var start = i;
      while (start > 0 && !isBoundary(raw.charAt(start - 1)) && i - start < 40) start--;
      while (start < raw.length && /\\s/.test(raw.charAt(start))) start++;
      var end = Math.max(i, start + 1);
      while (end < raw.length && !isBoundary(raw.charAt(end)) && end - start < MAX_QUOTE) end++;
      return normalizeText(raw.slice(start, end)).slice(0, MAX_QUOTE);
    };
    var snippetFromCaretPoint = function (clientX, clientY) {
      try {
        var pos = document.caretPositionFromPoint ? document.caretPositionFromPoint(clientX, clientY) : null;
        if (pos && pos.offsetNode && pos.offsetNode.nodeType === 3) {
          var byPosition = snippetFromTextNode(pos.offsetNode, pos.offset);
          if (byPosition) return byPosition;
        }
      } catch (e) {}
      try {
        var range = document.caretRangeFromPoint ? document.caretRangeFromPoint(clientX, clientY) : null;
        if (range && range.startContainer && range.startContainer.nodeType === 3) {
          var byRange = snippetFromTextNode(range.startContainer, range.startOffset);
          if (byRange) return byRange;
        }
      } catch (e) {}
      return "";
    };
    var rectIntersects = function (a, b) {
      return a && b && a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
    };
    var joinSnippets = function (parts) {
      var out = "";
      for (var i = 0; i < parts.length; i++) {
        var part = normalizeText(parts[i]);
        if (!part) continue;
        if (out && (out.indexOf(part) !== -1 || part.indexOf(out) !== -1)) continue;
        var next = out ? out + " ... " + part : part;
        if (next.length <= MAX_QUOTE) {
          out = next;
          continue;
        }
        if (!out) return next.slice(0, MAX_QUOTE);
        var remaining = MAX_QUOTE - out.length - 5;
        if (remaining > 20) out += " ... " + part.slice(0, remaining);
        return out.slice(0, MAX_QUOTE);
      }
      return out;
    };
    var textFromCaretScan = function (left, top, width, height) {
      var right = left + Math.max(1, width);
      var bottom = top + Math.max(1, height);
      var stepX = Math.max(8, Math.min(24, Math.max(1, width) / 4));
      var stepY = Math.max(8, Math.min(24, Math.max(1, height) / 4));
      var checked = 0;
      for (var y = top + 1; y <= bottom && checked < 400; y += stepY) {
        for (var x = left + 1; x <= right && checked < 400; x += stepX) {
          checked++;
          var text = snippetFromCaretPoint(x, y);
          if (text) return text;
        }
      }
      return snippetFromCaretPoint(left + 1, top + 1) || snippetFromCaretPoint(left + width / 2, top + height / 2);
    };
    var textFromIntersectingRects = function (left, top, width, height) {
      var query = {
        left: left,
        top: top,
        right: left + Math.max(1, width),
        bottom: top + Math.max(1, height)
      };
      var candidates = [];
      try {
        var root = document.body || document.documentElement;
        var walker = document.createTreeWalker(root, 4, null);
        var node, seen = 0;
        while ((node = walker.nextNode()) && seen < 5000) {
          seen++;
          if (!normalizeText(node.textContent || "")) continue;
          var range = document.createRange();
          range.selectNodeContents(node);
          var rects = range.getClientRects ? range.getClientRects() : [];
          var nodeScore = Infinity;
          for (var i = 0; i < rects.length; i++) {
            var r = rects[i];
            if (!rectIntersects(r, query)) continue;
            var score = Math.max(0, r.top - query.top) * 100000 + Math.max(0, r.left - query.left);
            if (score < nodeScore) nodeScore = score;
          }
          if (nodeScore < Infinity) {
            var text = snippetFromTextNode(node, 0);
            if (text) candidates.push({ score: nodeScore, text: text });
          }
          if (range.detach) range.detach();
        }
      } catch (e) {}
      candidates.sort(function (a, b) { return a.score - b.score; });
      var parts = [];
      for (var j = 0; j < candidates.length; j++) parts.push(candidates[j].text);
      return joinSnippets(parts);
    };
    var fallbackTextFromPoint = function (left, top, width, height) {
      var points = [
        [left + 1, top + 1],
        [left + width / 2, top + height / 2]
      ];
      for (var i = 0; i < points.length; i++) {
        try {
          var hit = document.elementFromPoint(points[i][0], points[i][1]);
          var cur = hit;
          while (cur && cur !== document.documentElement) {
            var text = normalizeText(cur.innerText || cur.textContent || "");
            if (text) return text.slice(0, MAX_QUOTE);
            cur = cur.parentElement;
          }
        } catch (e) {}
      }
      return "";
    };
    var describeRegion = function (x, y, w, h) {
      var left = x - window.scrollX;
      var top = y - window.scrollY;
      var width = Math.max(0, w);
      var height = Math.max(0, h);
      var isRegion = width >= 4 && height >= 4;
      return (isRegion ? textFromIntersectingRects(left, top, width, height) : "")
        || textFromCaretScan(left, top, width, height)
        || (!isRegion ? textFromIntersectingRects(left, top, width, height) : "")
        || fallbackTextFromPoint(left, top, width, height);
    };
    var externalLinks = function () {
      var links = [];
      try {
        if (typeof document.querySelectorAll !== "function") return links;
        var anchors = document.querySelectorAll("a[href]");
        for (var i = 0; i < anchors.length && links.length < MAX_EXTERNAL_LINKS; i++) {
          var anchor = anchors[i];
          if (!anchor || typeof anchor.getAttribute !== "function"
            || typeof anchor.getClientRects !== "function") continue;
          var href = anchor.getAttribute("href");
          if (typeof href !== "string" || !href.trim()) continue;
          var sourceRects = anchor.getClientRects();
          var rects = [];
          for (var j = 0; j < sourceRects.length && rects.length < MAX_EXTERNAL_LINK_RECTS; j++) {
            var source = sourceRects[j];
            var left = Math.max(0, Number(source.left));
            var top = Math.max(0, Number(source.top));
            var right = Math.min(window.innerWidth, Number(source.right));
            var bottom = Math.min(window.innerHeight, Number(source.bottom));
            if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)
              || right <= left || bottom <= top) continue;
            rects.push({ x: left, y: top, w: right - left, h: bottom - top });
          }
          if (!rects.length) continue;
          links.push({
            href: href.slice(0, 4097),
            text: normalizeText(anchor.textContent || "").slice(0, MAX_QUOTE),
            rects: rects
          });
        }
      } catch (e) {}
      return links;
    };
    var send = function () {
      try {
        if (!documentEpoch) return;
        var de = document.documentElement;
        var b = document.body;
        window.parent.postMessage({
          slockAcBridge: 1,
          nonce: nonce,
          documentEpoch: documentEpoch,
          type: "state",
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          docWidth: Math.max(de ? de.scrollWidth : 0, b ? b.scrollWidth : 0),
          docHeight: Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        }, parentOrigin);
        window.parent.postMessage({
          slockAcBridge: 1,
          nonce: nonce,
          documentEpoch: documentEpoch,
          type: "external-links",
          links: externalLinks()
        }, parentOrigin);
      } catch (e) {}
    };
    var pending = false;
    var schedule = function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; send(); });
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    // Inventory is viewport-relative, so invalidate it for any DOM/layout
    // mutation that can move, add, hide, or resize an anchor. Every report is
    // still hostile input: this only keeps honest previews fresh.
    if (typeof MutationObserver === "function") {
      new MutationObserver(schedule).observe(document.documentElement, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true
      });
    }
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(schedule).observe(document.documentElement);
    }
    document.addEventListener("load", schedule, true);
    window.addEventListener("message", function (ev) {
      var d = ev && ev.data;
      if (!d || d.slockAcBridge !== 1 || d.nonce !== nonce) return;
      if (d.type === "activate-document") {
        var nextDocumentEpoch = typeof d.documentEpoch === "string" ? d.documentEpoch : "";
        if (!nextDocumentEpoch || nextDocumentEpoch.length > 200) return;
        documentEpoch = nextDocumentEpoch;
        send();
        return;
      }
      if (!documentEpoch || d.documentEpoch !== documentEpoch) return;
      if (d.type === "scrollTo") {
        var x = Number(d.x);
        var y = Number(d.y);
        if (!isFinite(x) || !isFinite(y)) return;
        try {
          window.scrollTo({ left: x, top: y, behavior: "smooth" });
        } catch (e) {
          window.scrollTo(x, y);
        }
        schedule();
        return;
      }
      if (d.type === "scrollBy") {
        var sbx = Number(d.dx);
        var sby = Number(d.dy);
        if (!isFinite(sbx) || !isFinite(sby)) return;
        window.scrollBy(sbx, sby);
        schedule();
        return;
      }
      if (d.type === "describe") {
        // Best-effort text snippet inside a content-coordinate region so the
        // anchor chip can read like a quote instead of raw coordinates.
        // Rect captures aggregate intersecting text rects in left/top-first
        // order so multi-block selections do not collapse to one heading.
        // Point captures collapse to a tiny region. The reply text is untrusted
        // output for the parent (capped, rendered as plain text only) exactly
        // like every other bridge payload.
        var dx = Number(d.x);
        var dy = Number(d.y);
        if (!isFinite(dx) || !isFinite(dy)) return;
        var dw = Number(d.w);
        var dh = Number(d.h);
        var text = describeRegion(dx, dy, isFinite(dw) && dw >= 0 ? dw : 0, isFinite(dh) && dh >= 0 ? dh : 0);
        try {
          window.parent.postMessage({
            slockAcBridge: 1,
            nonce: nonce,
            documentEpoch: documentEpoch,
            type: "described",
            requestId: d.requestId,
            text: text
          }, parentOrigin);
        } catch (e) {}
      }
      if (d.type === "locate") {
        // Re-find a previously captured region by its stored quote text in the
        // CURRENT layout, so html-region markers track content reflow on resize
        // (#29). The quote is an echo of our own stored data, used only for a
        // string match — never eval'd or inserted as markup. The reply is pure
        // numeric content coordinates (a smaller surface than describe's text);
        // the parent still treats it as untrusted and clamps it.
        var lq = typeof d.quote === "string" ? d.quote.replace(/\\s+/g, " ").trim() : "";
        var rx = -1, ry = -1, rw = 0, rh = 0;
        if (lq) {
          try {
            // describe (above) produced the quote from element-level innerText,
            // which can span multiple text nodes (inline <b>/<a>/<code> markup),
            // so we scan ELEMENTS — a text-node scan would miss any marked-up
            // paragraph and leave real HTML reports unfixed (John review #29).
            var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT, null);
            var el, cands = [], seen = 0;
            while ((el = walker.nextNode()) && seen < 5000) {
              seen++;
              var t = (el.textContent || "").replace(/\\s+/g, " ").trim();
              if (!t || t.indexOf(lq) === -1) continue;
              cands.push(el);
            }
            // Minimal containers only: every ancestor of a match also matches,
            // so drop any candidate that contains another candidate. What's
            // left is one element per distinct occurrence of the quote.
            var minimal = [];
            for (var i = 0; i < cands.length; i++) {
              var isMin = true;
              for (var j = 0; j < cands.length; j++) {
                if (i !== j && cands[i].contains(cands[j])) { isMin = false; break; }
              }
              if (isMin) minimal.push(cands[i]);
            }
            // Duplicate-quote disambiguation (#29 runtime verify red): when the
            // quote occurs more than once, prefer the occurrence closest to the
            // anchor's STORED y (nearY) instead of the smallest element, which
            // picked an arbitrary instance. nearY comes from our own stored
            // anchor data echoed back by the parent — still just a number.
            var nearY = typeof d.nearY === "number" && isFinite(d.nearY) ? d.nearY : null;
            var best = null, bestScore = Infinity;
            for (var k = 0; k < minimal.length; k++) {
              var r = minimal[k].getBoundingClientRect();
              if (!r || (r.width <= 0 && r.height <= 0)) continue;
              var cy = r.top + window.scrollY + r.height / 2;
              // No nearY (legacy caller) → keep the pre-patch smallest-text
              // pick; with nearY → nearest occurrence to the stored anchor.
              var score = nearY === null
                ? (minimal[k].textContent || "").replace(/\\s+/g, " ").trim().length
                : Math.abs(cy - nearY);
              if (score < bestScore) { bestScore = score; best = minimal[k]; }
            }
            if (best) {
              var br = best.getBoundingClientRect();
              rx = Math.round(br.left + window.scrollX);
              ry = Math.round(br.top + window.scrollY);
              rw = Math.round(br.width);
              rh = Math.round(br.height);
            }
          } catch (e) {}
        }
        try {
          window.parent.postMessage({
            slockAcBridge: 1,
            nonce: nonce,
            documentEpoch: documentEpoch,
            type: "located",
            requestId: d.requestId,
            x: rx, y: ry, w: rw, h: rh
          }, parentOrigin);
        } catch (e) {}
      }
    });
    document.addEventListener("DOMContentLoaded", send);
    window.addEventListener("load", send);
    setTimeout(send, 0);
  } catch (e) {}
})();</script>
`;

const HTML_PREVIEW_BRIDGE_SCAN_LIMIT_BYTES = 1024 * 1024;
const RAW_TEXT_HEAD_ELEMENTS = new Set(["script", "style", "title", "textarea", "noscript", "template"]);

type HtmlHeadScanResult =
  | { kind: "csp-meta"; start: number }
  | { kind: "head-closed" }
  | { kind: "need-more" };

function findTagEnd(html: string, tagStart: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = tagStart + 1; index < html.length; index += 1) {
    const ch = html[index];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return index;
  }
  return -1;
}

function readTagName(html: string, start: number): { name: string; end: number } | null {
  let end = start;
  while (end < html.length && /[A-Za-z0-9:-]/.test(html[end])) end += 1;
  if (end === start) return null;
  return { name: html.slice(start, end).toLowerCase(), end };
}

function metaDeclaresContentSecurityPolicy(tag: string): boolean {
  const match = /\bhttp-equiv\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return value.trim().toLowerCase() === "content-security-policy";
}

/**
 * Scan only the parser-active head. CSP meta tags inside comments, raw-text
 * elements, templates, or the body do not constrain the preview and must not
 * become injection points.
 */
export function findHtmlPreviewCspMetaStart(bytes: Buffer): HtmlHeadScanResult {
  const html = bytes.toString("latin1");
  const lower = html.toLowerCase();
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) return { kind: "need-more" };

    if (lower.startsWith("<!--", tagStart)) {
      const commentEnd = lower.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) return { kind: "need-more" };
      cursor = commentEnd + 3;
      continue;
    }

    if (lower.startsWith("<!", tagStart) || lower.startsWith("<?", tagStart)) {
      const declarationEnd = findTagEnd(html, tagStart);
      if (declarationEnd < 0) return { kind: "need-more" };
      cursor = declarationEnd + 1;
      continue;
    }

    let nameStart = tagStart + 1;
    const closing = html[nameStart] === "/";
    if (closing) nameStart += 1;
    while (nameStart < html.length && /\s/.test(html[nameStart])) nameStart += 1;
    const parsedName = readTagName(html, nameStart);
    if (!parsedName) {
      cursor = tagStart + 1;
      continue;
    }
    const tagEnd = findTagEnd(html, tagStart);
    if (tagEnd < 0) return { kind: "need-more" };

    if (closing) {
      if (parsedName.name === "head") return { kind: "head-closed" };
      cursor = tagEnd + 1;
      continue;
    }

    if (parsedName.name === "body" || parsedName.name === "frameset") {
      return { kind: "head-closed" };
    }
    if (parsedName.name === "meta" && metaDeclaresContentSecurityPolicy(html.slice(tagStart, tagEnd + 1))) {
      return { kind: "csp-meta", start: tagStart };
    }

    if (RAW_TEXT_HEAD_ELEMENTS.has(parsedName.name)) {
      const closingStart = lower.indexOf(`</${parsedName.name}`, tagEnd + 1);
      if (closingStart < 0) return { kind: "need-more" };
      const closingEnd = findTagEnd(html, closingStart);
      if (closingEnd < 0) return { kind: "need-more" };
      cursor = closingEnd + 1;
      continue;
    }

    cursor = tagEnd + 1;
  }

  return { kind: "need-more" };
}

/**
 * Preserve streaming for large HTML attachments while holding only the head
 * prefix needed to place the bridge before an attachment-owned CSP meta tag.
 */
export function createAttachmentPreviewBridgeTransform(
  scanLimitBytes = HTML_PREVIEW_BRIDGE_SCAN_LIMIT_BYTES,
): Transform {
  let pending = Buffer.alloc(0);
  let scanComplete = false;
  let bridgeInserted = false;
  const bridge = Buffer.from(ATTACHMENT_PREVIEW_BRIDGE_SCRIPT, "utf8");

  return new Transform({
    transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      if (scanComplete) {
        this.push(bytes);
        callback();
        return;
      }

      pending = Buffer.concat([pending, bytes]);
      const result = findHtmlPreviewCspMetaStart(pending);
      if (result.kind === "csp-meta") {
        this.push(pending.subarray(0, result.start));
        this.push(bridge);
        this.push(pending.subarray(result.start));
        pending = Buffer.alloc(0);
        bridgeInserted = true;
        scanComplete = true;
      } else if (result.kind === "head-closed" || pending.length >= scanLimitBytes) {
        this.push(pending);
        pending = Buffer.alloc(0);
        scanComplete = true;
      }
      callback();
    },
    flush(callback: TransformCallback) {
      if (!scanComplete) {
        const result = findHtmlPreviewCspMetaStart(pending);
        if (result.kind === "csp-meta") {
          this.push(pending.subarray(0, result.start));
          this.push(bridge);
          this.push(pending.subarray(result.start));
          bridgeInserted = true;
        } else {
          this.push(pending);
        }
      }
      if (!bridgeInserted) this.push(bridge);
      callback();
    },
  });
}
