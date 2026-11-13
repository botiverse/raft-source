// Compact, human/agent-readable label for an attachment-comment anchor
// (task #37): agents receive comments as plain thread messages, so the agent
// projection prefixes a scope line built from the ref + this label. Lives in
// its own module because BOTH attachmentCommentService (live delivery, before
// the ref row exists) and messageService (history enrichment) need it, and
// attachmentCommentService already imports messageService — importing the
// comment service back from messageService would cycle.
//
// Contract (Dozy/Bugen review gates): the human-facing anchor label may carry
// a capped quote preview. The Agent scope header is structural only because
// its following blockquote carries the complete selection (bounded by the
// anchor payload limit). Empty/invalid anchors get an honest fallback, never
// a pretend-located label.

const QUOTE_CAP = 80;

// One normalization for every text that enters the one-line scope header:
// whitespace collapsed (multi-line input must not break the line) and capped.
function collapseAndCap(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > QUOTE_CAP ? `${collapsed.slice(0, QUOTE_CAP)}…` : collapsed;
}

function cappedQuote(data: Record<string, unknown>): string | null {
  return collapseAndCap(data.quote);
}

function htmlRegionPosition(data: Record<string, unknown>): string | null {
  const x = data.x;
  const y = data.y;
  const w = data.w;
  const h = data.h;
  const docW = data.documentWidth;
  const docH = data.documentHeight;
  if (
    typeof x !== "number" || typeof y !== "number" ||
    typeof w !== "number" || typeof h !== "number" ||
    !Number.isFinite(x) || !Number.isFinite(y) ||
    !Number.isFinite(w) || !Number.isFinite(h)
  ) {
    return null;
  }
  if (typeof docW === "number" && typeof docH === "number" && docW > 0 && docH > 0) {
    const pctX = Math.round((x / docW) * 100);
    const pctY = Math.round((y / docH) * 100);
    return `(${pctX}%, ${pctY}%, ${Math.round(w)}×${Math.round(h)}px)`;
  }
  return `(${Math.round(x)}, ${Math.round(y)}, ${Math.round(w)}×${Math.round(h)}px)`;
}

function intRange(data: Record<string, unknown>, prefix: string): string | null {
  const start = data.start;
  const end = data.end;
  if (typeof start !== "number" || !Number.isInteger(start)) return null;
  if (typeof end === "number" && Number.isInteger(end) && end !== start) {
    // "L3–L7" repeats the letter prefix; "row 3–7" reads better without.
    const endPrefix = prefix === "L" ? "L" : "";
    return `${prefix}${start}–${endPrefix}${end}`;
  }
  return `${prefix}${start}`;
}

/**
 * Render a one-line location label for an anchor, or null when there is no
 * usable anchor at all (unanchored comment → the scope line carries only the
 * filename).
 */
export function renderAnchorLabel(
  anchorType: string | null | undefined,
  anchorData: unknown,
): string | null {
  if (!anchorType || typeof anchorData !== "object" || anchorData === null || Array.isArray(anchorData)) {
    return null;
  }
  const data = anchorData as Record<string, unknown>;
  const quote = cappedQuote(data);

  switch (anchorType) {
    case "lines": {
      const range = intRange(data, "L");
      const base = range ?? "lines";
      return quote ? `${base} ·「${quote}」` : base;
    }
    case "csv-rows": {
      const range = intRange(data, "row ");
      const base = range ?? "rows";
      return quote ? `${base} ·「${quote}」` : base;
    }
    case "md-section": {
      // Same normalization as the quote (Dozy review on PR #2856): a raw
      // multiline/long headingTitle would break the one-line header and make
      // the capped quote unequal to the raw title, duplicating the text.
      const title = collapseAndCap(data.headingTitle);
      const base = title ? `§ ${title}` : "section";
      return quote && quote !== title ? `${base} ·「${quote}」` : base;
    }
    case "html-region": {
      const regionPos = htmlRegionPosition(data);
      if (quote && regionPos) return `region ${regionPos} ·「${quote}」`;
      if (quote) return `「${quote}」`;
      return regionPos ? `region ${regionPos}` : "HTML region";
    }
    case "video-timestamp": {
      const time = typeof data.time === "number" && Number.isFinite(data.time) ? data.time : null;
      if (time === null) return "timestamp";
      const h = Math.floor(time / 3600);
      const m = Math.floor((time % 3600) / 60);
      const s = Math.floor(time % 60);
      return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
    }
    default:
      return null;
  }
}

/**
 * The full scope line the agent projection prepends to a scoped comment's
 * content, e.g. `[re: report.html · L3–7]`. The selected text is deliberately
 * absent from this header because the complete quotation immediately follows
 * as a blockquote. Filename alone when the comment is unanchored — the
 * attachment scope itself was the part agents never saw (tasks #37/#158).
 */
export type AgentCommentScopeProjection = {
  filename: string;
  anchorLabel: string | null;
  anchorQuote: string | null;
};

function renderScopeLine(scope: AgentCommentScopeProjection): string {
  return scope.anchorLabel
    ? `[re: ${scope.filename} · ${scope.anchorLabel}]`
    : `[re: ${scope.filename}]`;
}

export function renderAgentCommentScopeLine(
  filename: string,
  anchorType: string | null | undefined,
  anchorData: unknown,
): string {
  return renderScopeLine(projectAgentCommentScope(filename, anchorType, anchorData));
}

/**
 * Preserve the complete selected text for the Agent projection. The Agent
 * header is location-only; this value becomes the durable, untruncated
 * blockquote that follows it (task #158).
 */
export function readFullAnchorQuote(anchorData: unknown): string | null {
  if (!anchorData || typeof anchorData !== "object" || Array.isArray(anchorData)) return null;
  const quote = (anchorData as Record<string, unknown>).quote;
  if (typeof quote !== "string") return null;
  const trimmed = quote.trim();
  return trimmed || null;
}

function withoutAnchorQuote(anchorData: unknown): unknown {
  if (!anchorData || typeof anchorData !== "object" || Array.isArray(anchorData)) return anchorData;
  const locationData = { ...(anchorData as Record<string, unknown>) };
  delete locationData.quote;
  return locationData;
}

export function projectAgentCommentScope(
  filename: string,
  anchorType: string | null | undefined,
  anchorData: unknown,
): AgentCommentScopeProjection {
  return {
    filename,
    // Agent headers identify location only. The full selected text has one
    // canonical home in the blockquote below, never a duplicate 80-char
    // preview in the header (task #158, Cindy 2026-09-26).
    anchorLabel: renderAnchorLabel(anchorType, withoutAnchorQuote(anchorData)),
    anchorQuote: readFullAnchorQuote(anchorData),
  };
}

/**
 * One canonical Agent-visible scope block shared by live delivery, thread
 * context, history reads, and search results.
 */
export function renderAgentCommentScopeBlock(scope: AgentCommentScopeProjection): string {
  const scopeLine = renderScopeLine(scope);
  if (!scope.anchorQuote) return scopeLine;
  const quoteBlock = scope.anchorQuote
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `${scopeLine}\n${quoteBlock}`;
}

export function renderAgentCommentScopedContent(
  content: string,
  scope: AgentCommentScopeProjection | null | undefined,
): string {
  return scope ? `${renderAgentCommentScopeBlock(scope)}\n${content}` : content;
}
