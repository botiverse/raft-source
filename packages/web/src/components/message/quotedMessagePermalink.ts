import { parseRaftPermalink } from "@botiverse/raft-shared";
import type { ParsedRaftPermalink } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";
import type { MessageAttachment } from "../../store/messageStore";

type FormatMessage = IntlShape["formatMessage"];

const CJK_URL_BOUNDARY_PUNCTUATION = "，。、；：！？）》」』】》〉”’（《「『【〈“‘";
const URL_PATTERN = new RegExp(`https?:\\/\\/[^\\s<>"'${CJK_URL_BOUNDARY_PUNCTUATION}]+`, "g");
const TRAILING_PUNCTUATION = /[),.!?;:，。！？；：]+$/;
const FENCED_CODE_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /``[^`]+``|`[^`]+`/g;

interface ProtectedMarkdownCode {
  text: string;
  restore: (value: string) => string;
}

export interface ExtractedQuotedMessagePermalink {
  rawUrl: string;
  parsed: ParsedRaftPermalink;
}

export function matchesUnavailableQuotedPermalink(
  renderedHref: string,
  unavailableRawUrl: string | null | undefined,
  currentHostname: string | undefined,
): boolean {
  if (!unavailableRawUrl) return false;
  // Markdown preserves escaped query separators in the href prop, while the
  // plain-text extractor retains the original URL. Parse both forms and compare
  // the permalink identity instead of their renderer-specific serialization.
  const rendered = parseRaftPermalink(renderedHref.replaceAll("&amp;", "&"), currentHostname);
  const unavailable = parseRaftPermalink(unavailableRawUrl, currentHostname);
  return Boolean(
    rendered
      && unavailable
      && rendered.serverSlug === unavailable.serverSlug
      && rendered.routeKind === unavailable.routeKind
      && rendered.channelId === unavailable.channelId
      && rendered.threadParentMessageId === unavailable.threadParentMessageId
      && rendered.messageId === unavailable.messageId,
  );
}

function protectMarkdownCode(text: string): ProtectedMarkdownCode {
  const placeholders: string[] = [];
  const protect = (pattern: RegExp, value: string) =>
    value.replace(pattern, (match) => {
      const index = placeholders.length;
      placeholders.push(match);
      return `\x00CODE${index}\x00`;
    });

  const protectedText = protect(INLINE_CODE_PATTERN, protect(FENCED_CODE_PATTERN, text));

  return {
    text: protectedText,
    restore: (value: string) =>
      // oxlint-disable-next-line no-control-regex -- NUL (\u0000) is an intentional private sentinel wrapping placeholder tokens; it never appears in user markdown, so matching it is safe and deliberate
      value.replace(/\x00CODE(\d+)\x00/g, (_match, index) => placeholders[Number(index)] ?? ""),
  };
}

export function extractFirstQuotedMessagePermalink(
  content: string,
  currentHostname: string | undefined,
  currentServerSlug: string | undefined,
): ExtractedQuotedMessagePermalink | null {
  if (!content?.includes("http") || !currentServerSlug) return null;

  const protectedMarkdown = protectMarkdownCode(content);
  for (const match of protectedMarkdown.text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? -1;
    if (start < 0) continue;

    // Skip markdown links like [text](https://...)
    if (start > 0 && protectedMarkdown.text[start - 1] === "(") continue;

    const trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? "";
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    const parsed = parseRaftPermalink(candidate, currentHostname);
    if (!parsed || parsed.serverSlug !== currentServerSlug) continue;

    return {
      rawUrl: candidate,
      parsed,
    };
  }

  return null;
}

export function buildQuotedMessageAttachmentLabel(
  attachments: MessageAttachment[] | undefined,
  formatMessage: FormatMessage,
): string | null {
  if (!attachments || attachments.length === 0) return null;

  const imageCount = attachments.filter((attachment) => attachment.mimeType.startsWith("image/")).length;
  if (attachments.length === 1) {
    return imageCount === 1
      ? formatMessage({ id: "message.quote.oneImage" })
      : formatMessage({ id: "message.quote.oneFile" });
  }
  if (imageCount === attachments.length) {
    return formatMessage({ id: "message.quote.nImages" }, { count: imageCount });
  }
  return formatMessage({ id: "message.quote.nAttachments" }, { count: attachments.length });
}
