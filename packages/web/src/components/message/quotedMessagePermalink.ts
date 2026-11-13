import { parseRaftPermalink, visitOutsideMarkdownCode } from "@botiverse/raft-shared";
import type { ParsedRaftPermalink } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";
import type { MessageAttachment } from "../../store/messageStore";
import { webUrlFromRaftDeepLink } from "../../utils/raftDeepLinkWebUrl";

type FormatMessage = IntlShape["formatMessage"];

const CJK_URL_BOUNDARY_PUNCTUATION = "，。、；：！？）》」』】》〉”’（《「『【〈“‘";
// Raft Desktop's `raft:///s/…` links quote like the web link they stand for.
const URL_PATTERN = new RegExp(`(?:https?|(?<![\\p{L}\\p{N}_])raft):\\/\\/[^\\s<>"'${CJK_URL_BOUNDARY_PUNCTUATION}]+`, "gu");
const TRAILING_PUNCTUATION = /[),.!?;:，。！？；：]+$/;

export interface ExtractedQuotedMessagePermalink {
  rawUrl: string;
  parsed: ParsedRaftPermalink;
}

/**
 * `hostnames`: the hosts a Raft permalink is recognised on here, as the shared
 * parseRaftPermalink takes them (store/raftAppHosts raftPermalinkHostnames:
 * the page's own and the server's app hosts).
 */
export function matchesUnavailableQuotedPermalink(
  renderedHref: string,
  unavailableRawUrl: string | null | undefined,
  hostnames: string | readonly string[] | undefined,
): boolean {
  if (!unavailableRawUrl) return false;
  // Markdown preserves escaped query separators in the href prop, while the
  // plain-text extractor retains the original URL. Parse both forms and compare
  // the permalink identity instead of their renderer-specific serialization.
  const rendered = parseRaftPermalink(renderedHref.replaceAll("&amp;", "&"), hostnames);
  const unavailable = parseRaftPermalink(unavailableRawUrl, hostnames);
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

/** The first Raft permalink to a message of `currentServerSlug` in `content`, on `hostnames` (as matchesUnavailableQuotedPermalink's). */
export function extractFirstQuotedMessagePermalink(
  content: string,
  hostnames: string | readonly string[] | undefined,
  currentServerSlug: string | undefined,
): ExtractedQuotedMessagePermalink | null {
  if (!(content?.includes("http") || content?.includes("raft://")) || !currentServerSlug) return null;

  // Code is decided by the markdown parser (task #762), not by fence regexes.
  let found: ExtractedQuotedMessagePermalink | null = null;
  visitOutsideMarkdownCode(content, (chunk) => {
    if (found) return;
    for (const match of chunk.matchAll(URL_PATTERN)) {
      const raw = match[0];
      const start = match.index ?? -1;
      if (start < 0) continue;

      // Skip markdown links like [text](https://...)
      if (start > 0 && chunk[start - 1] === "(") continue;

      const trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? "";
      const written = trailing ? raw.slice(0, -trailing.length) : raw;
      const candidate = written.startsWith("raft:") ? webUrlFromRaftDeepLink(written) : written;
      if (!candidate) continue;
      const parsed = parseRaftPermalink(candidate, hostnames);
      if (!parsed || parsed.serverSlug !== currentServerSlug) continue;

      found = { rawUrl: candidate, parsed };
      return;
    }
  });
  if (found) return found;

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
