import { agentInboxPreview } from "./agentInboxApp";

/**
 * Ephemeral viewer-scoped quote resolution attached by the server on read
 * (never persisted in DB, never expanded in agent CLI reads, never attached
 * to room-wide real-time WS broadcasts).
 */
export interface ResolvedInlineQuote {
  /** Canonical UUID of the quoted message (used for jumping). */
  messageId: string;
  /** 8-character short ID matching `> msg=<shortId>`. */
  shortId: string;
  /** Target author display info verified by the server for this reader. */
  author: {
    name: string;
    type: "user" | "agent" | "external_projection" | "system";
  };
  /** Target message ISO-8601 creation timestamp. */
  createdAt: string;
  /** True when quoting a specific passage rather than the whole message opening. */
  isPartial: boolean;
}

/** Map keyed by stringified 0-based `blockIndex` among quote blocks in the message. */
export type ResolvedInlineQuotesMap = Record<string, ResolvedInlineQuote>;

export interface ParsedQuoteBlock {
  kind: "quote_block";
  /** 0-based index among same-conversation quote blocks in this message. */
  blockIndex: number;
  /** Excerpt lines (without leading `> ` markers and without the trailing `msg=<id>` line). */
  excerpt: string;
  /** Lowercased 8-char hex short ID or full UUID from the trailing `msg=<id>` line. */
  refId: string;
  /** Original raw Markdown lines of the blockquote. */
  rawMarkdown: string;
}

export type ParsedMessageQuoteSegment =
  | { kind: "text"; text: string }
  | ParsedQuoteBlock;

const SAME_CONV_QUOTE_REF_RE =
  /^msg=([0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const BLOCKQUOTE_LINE_RE = /^\s{0,3}> ?(.*)$/;
const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Fast O(1) pre-check so normal messages without `msg=` skip line scanning entirely.
 */
export function hasSameConversationQuoteRef(content: string): boolean {
  if (!content || !content.includes("msg=") || !content.includes(">")) return false;
  return /(?:^|\n)\s{0,3}>\s*msg=[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\s*(?:\r?\n|$)/i.test(
    content,
  );
}

/**
 * Parse a message's Markdown content into interleaved `text` and same-conversation
 * `quote_block` segments (`> <excerpt>\n> msg=<8-char-id>`), skipping fenced code
 * blocks so code examples containing `> msg=...` are never misparsed.
 */
export function parseMessageQuoteSegments(content: string): ParsedMessageQuoteSegment[] {
  if (!hasSameConversationQuoteRef(content)) {
    return content ? [{ kind: "text", text: content }] : [];
  }

  const lines = content.split(/\r?\n/);
  const segments: ParsedMessageQuoteSegment[] = [];
  let textLines: string[] = [];
  let quoteRawLines: string[] = [];
  let quoteInnerLines: string[] = [];
  let activeFenceChar: "`" | "~" | null = null;
  let activeFenceLen = 0;
  let nextBlockIndex = 0;

  const flushText = () => {
    if (textLines.length === 0) return;
    const joined = textLines.join("\n");
    if (joined.trim().length > 0) {
      segments.push({ kind: "text", text: joined.replace(/^\n+|\n+$/g, "") });
    }
    textLines = [];
  };

  const flushQuote = () => {
    if (quoteRawLines.length === 0) return;

    // Trim trailing blank quoted lines (e.g. a bare `>`) before inspecting the last line.
    let lastNonEmpty = quoteInnerLines.length - 1;
    while (lastNonEmpty >= 0 && quoteInnerLines[lastNonEmpty].trim().length === 0) {
      lastNonEmpty -= 1;
    }

    const lastLine = lastNonEmpty >= 0 ? quoteInnerLines[lastNonEmpty].trim() : "";
    const match = SAME_CONV_QUOTE_REF_RE.exec(lastLine);
    if (match && lastNonEmpty > 0) {
      // Trim leading/trailing empty lines from the excerpt itself.
      let excerptEnd = lastNonEmpty - 1;
      while (excerptEnd >= 0 && quoteInnerLines[excerptEnd].trim().length === 0) {
        excerptEnd -= 1;
      }
      let excerptStart = 0;
      while (excerptStart <= excerptEnd && quoteInnerLines[excerptStart].trim().length === 0) {
        excerptStart += 1;
      }
      if (excerptStart <= excerptEnd) {
        const excerpt = quoteInnerLines.slice(excerptStart, excerptEnd + 1).join("\n");
        flushText();
        segments.push({
          kind: "quote_block",
          blockIndex: nextBlockIndex++,
          excerpt,
          refId: match[1].toLowerCase(),
          rawMarkdown: quoteRawLines.join("\n"),
        });
        quoteRawLines = [];
        quoteInnerLines = [];
        return;
      }
    }

    // Not a same-conversation quote block: keep verbatim inside surrounding text.
    textLines.push(...quoteRawLines);
    quoteRawLines = [];
    quoteInnerLines = [];
  };

  for (const line of lines) {
    if (activeFenceChar !== null) {
      textLines.push(line);
      const closeRe = new RegExp(`^\\s{0,3}${activeFenceChar}{${activeFenceLen},}\\s*$`);
      if (closeRe.test(line)) {
        activeFenceChar = null;
        activeFenceLen = 0;
      }
      continue;
    }

    const bqMatch = BLOCKQUOTE_LINE_RE.exec(line);
    if (bqMatch) {
      quoteRawLines.push(line);
      quoteInnerLines.push(bqMatch[1]);
      continue;
    }

    flushQuote();

    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen) {
      const marker = fenceOpen[1];
      const ch = marker[0] as "`" | "~";
      // Backtick info strings cannot contain backticks (CommonMark spec).
      if (ch === "~" || !line.slice(fenceOpen.index + fenceOpen[0].length).includes("`")) {
        activeFenceChar = ch;
        activeFenceLen = marker.length;
      }
    }

    textLines.push(line);
  }

  flushQuote();
  flushText();
  return segments;
}

/** Extract all same-conversation quote blocks (`> ...\n> msg=<id>`) in message order. */
export function extractSameConversationQuoteBlocks(content: string): ParsedQuoteBlock[] {
  if (!hasSameConversationQuoteRef(content)) return [];
  const out: ParsedQuoteBlock[] = [];
  for (const seg of parseMessageQuoteSegments(content)) {
    if (seg.kind === "quote_block") out.push(seg);
  }
  return out;
}

/**
 * Render an excerpt as a plain Markdown blockquote (without the trailing `msg=<id>` line).
 * Used on the Web display layer when a same-conversation quote block degrades so
 * humans see a clean blockquote while `messages.content` and agent reads stay verbatim.
 */
export function formatPlainBlockquote(excerpt: string): string {
  return excerpt
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * Strip leading same-conversation quote blocks from a message when deriving a
 * whole-message quote excerpt so quoting a reply quotes its own words, not its ancestor.
 */
export function stripLeadingQuoteReplyBlocks(content: string): string {
  if (!hasSameConversationQuoteRef(content)) return content;
  const segments = parseMessageQuoteSegments(content);
  let start = 0;
  while (start < segments.length && segments[start].kind === "quote_block") {
    start += 1;
  }
  if (start === 0) return content;
  const rest = segments
    .slice(start)
    .map((seg) => (seg.kind === "text" ? seg.text : seg.rawMarkdown))
    .join("\n\n")
    .trim();
  return rest;
}

/**
 * Single-line preview truncation delegated to `agentInboxPreview` (first
 * non-blank line, folded to one line, max 120 chars, surrogate-safe).
 * Appends `…` when truncated.
 */
export function buildWholeMessageQuoteExcerpt(content: string): { excerpt: string; truncated: boolean } {
  const source = stripLeadingQuoteReplyBlocks(content).trim() || content.trim();
  const { preview, previewTruncated } = agentInboxPreview(source);
  if (!preview) return { excerpt: "", truncated: false };
  return {
    excerpt: previewTruncated ? `${preview.trimEnd()}…` : preview,
    truncated: previewTruncated,
  };
}

/**
 * Serialize a Web composer Quote Reply into the unified read/write Markdown format:
 *   > <excerpt>
 *   > msg=<8-char-shortId>
 *
 *   <replyBody>
 */
export function serializeInlineQuoteReply(
  excerpt: string,
  targetMessageId: string,
  replyBody: string,
): string {
  const shortId = targetMessageId.trim().slice(0, 8).toLowerCase();
  const cleanExcerpt = excerpt.replace(/\r\n?/g, "\n").trim();
  const quoteLines = cleanExcerpt
    .split("\n")
    .map((line) => (line.trim().length > 0 ? `> ${line.trim()}` : ">"))
    .join("\n");
  const body = replyBody.trim();
  return body ? `${quoteLines}\n> msg=${shortId}\n\n${body}` : `${quoteLines}\n> msg=${shortId}`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripLightMarkdown(text: string): string {
  return text
    // Inline links [label](url) -> label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Fenced/inline code markers, bold/italic/strike markers, heading/list/blockquote prefixes
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/g, "$1")
    .replace(/[`*_~]/g, "");
}

/**
 * Anti-spoofing excerpt check used by the server before attaching a target author
 * name and jump link. Normalizes whitespace and light Markdown so text selected
 * from rendered HTML matches the stored Markdown source, while forged/paraphrased
 * quotes fail verification and degrade cleanly to plain blockquotes.
 */
export function verifyQuoteExcerptInContent(
  excerpt: string,
  targetContent: string,
): { verified: boolean; isPartial: boolean } {
  const trimmedExcerpt = excerpt.trim();
  const trimmedTarget = targetContent.trim();
  if (!trimmedExcerpt || !trimmedTarget) {
    return { verified: false, isPartial: false };
  }

  // Whole-message quotes may carry a trailing `…` (or `...`) from 120-char truncation.
  const withoutEllipsis = trimmedExcerpt.endsWith("…")
    ? trimmedExcerpt.slice(0, -1).trim()
    : trimmedExcerpt.endsWith("...")
      ? trimmedExcerpt.slice(0, -3).trim()
      : trimmedExcerpt;
  if (!withoutEllipsis) {
    return { verified: false, isPartial: false };
  }

  const rawNormTarget = normalizeWhitespace(trimmedTarget);
  const rawNormExcerpt = normalizeWhitespace(withoutEllipsis);
  const strippedNormTarget = normalizeWhitespace(stripLightMarkdown(trimmedTarget));
  const strippedNormExcerpt = normalizeWhitespace(stripLightMarkdown(withoutEllipsis));

  const matched =
    (rawNormExcerpt.length > 0 && rawNormTarget.includes(rawNormExcerpt)) ||
    (strippedNormExcerpt.length > 0 && strippedNormTarget.includes(strippedNormExcerpt));

  if (!matched) {
    return { verified: false, isPartial: false };
  }

  const bodyOnly = stripLeadingQuoteReplyBlocks(trimmedTarget).trim() || trimmedTarget;
  const wholePreview = buildWholeMessageQuoteExcerpt(trimmedTarget).excerpt.replace(/…$/, "").trim();
  const normBodyRaw = normalizeWhitespace(bodyOnly);
  const normBodyStripped = normalizeWhitespace(stripLightMarkdown(bodyOnly));
  const normWholeRaw = normalizeWhitespace(wholePreview);
  const normWholeStripped = normalizeWhitespace(stripLightMarkdown(wholePreview));

  const isWhole =
    rawNormExcerpt === rawNormTarget ||
    strippedNormExcerpt === strippedNormTarget ||
    rawNormExcerpt === normBodyRaw ||
    strippedNormExcerpt === normBodyStripped ||
    (normWholeRaw.length > 0 && rawNormExcerpt === normWholeRaw) ||
    (normWholeStripped.length > 0 && strippedNormExcerpt === normWholeStripped);

  return { verified: true, isPartial: !isWhole };
}
