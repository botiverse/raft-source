import { parseRaftPermalink } from "@botiverse/raft-shared";
import { alias } from "drizzle-orm/pg-core";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { channels, messages } from "../db/schema.js";
import * as serverService from "./serverService.js";
import { isMessageShortId, messageIdShortPrefixConditions } from "../lib/messageId.js";
import { getAppPermalinkHostnames } from "../config/appUrl.js";

const CJK_URL_BOUNDARY_PUNCTUATION = "，。、；：！？）》」』】》〉”’（《「『【〈“‘";
const URL_PATTERN = new RegExp(`https?:\\/\\/[^\\s<>"'${CJK_URL_BOUNDARY_PUNCTUATION}]+`, "g");
const TRAILING_PUNCTUATION = /[),.!?;:，。！？；：]+$/;
const FENCED_CODE_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /``[^`]+``|`[^`]+`/g;
const FULL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MessagePermalinkRow {
  messageId: string;
  channelName: string;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  parentMessageId: string | null;
  parentChannelName: string | null;
  parentChannelType: "channel" | "private" | "joint" | "dm" | "thread" | null;
}

interface ParsedMatch {
  rawUrl: string;
  parsed: NonNullable<ReturnType<typeof parseRaftPermalink>>;
}

interface ProtectedMarkdownCode {
  text: string;
  restore: (value: string) => string;
}

export function formatCanonicalAgentMessageRef(row: MessagePermalinkRow): string | null {
  const msgShort = row.messageId.slice(0, 8);

  if (row.channelType === "channel" || row.channelType === "private" || row.channelType === "joint") {
    return `#${row.channelName} msg=${msgShort}`;
  }

  if (row.channelType === "dm") {
    return `dm:@${row.channelName} msg=${msgShort}`;
  }

  if (!row.parentMessageId || !row.parentChannelName || !row.parentChannelType) {
    return null;
  }

  const parentShort = row.parentMessageId.slice(0, 8);
  const threadTarget = row.parentChannelType === "dm"
    ? `dm:@${row.parentChannelName}:${parentShort}`
    : `#${row.parentChannelName}:${parentShort}`;
  return `${threadTarget} msg=${msgShort}`;
}

function collectParsedMatches(text: string, serverSlug: string): ParsedMatch[] {
  if (!text.includes("http")) return [];

  const allowedHostnames = getAppPermalinkHostnames();
  const matches: ParsedMatch[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? "";
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    const parsed = parseRaftPermalink(candidate, allowedHostnames);
    if (!parsed || parsed.serverSlug !== serverSlug) continue;
    matches.push({ rawUrl: candidate, parsed });
  }
  return matches;
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
      value.replace(/\x00CODE(\d+)\x00/g, (_match, index) => placeholders[Number(index)] ?? ""),
  };
}

function replacePermalinkMatches(text: string, replacements: Map<string, string>): string {
  return text.replace(URL_PATTERN, (match) => {
    const trailing = match.match(TRAILING_PUNCTUATION)?.[0] ?? "";
    const candidate = trailing ? match.slice(0, -trailing.length) : match;
    const rendered = replacements.get(candidate);
    return rendered ? `${rendered}${trailing}` : match;
  });
}

export function replacePermalinksOutsideMarkdownCode(text: string, replacements: Map<string, string>): string {
  if (replacements.size === 0 || !text.includes("http")) return text;

  const protectedMarkdown = protectMarkdownCode(text);
  return protectedMarkdown.restore(replacePermalinkMatches(protectedMarkdown.text, replacements));
}

function parsedMatchKey(match: ParsedMatch): string {
  return [
    match.parsed.channelId,
    match.parsed.threadParentMessageId ?? "",
    match.parsed.messageId.toLowerCase(),
  ].join(":");
}

async function resolveShortMessageIdWithinParentChannelThread(
  serverId: string,
  parentChannelId: string,
  shortId: string,
): Promise<string | null> {
  if (!isMessageShortId(shortId)) return null;

  const db = getDb();
  const threadChannels = alias(channels, "thread_channels");
  const parentMessages = alias(messages, "parent_messages");
  const rows = await db
    .select({ messageId: messages.id })
    .from(messages)
    .innerJoin(threadChannels, eq(threadChannels.id, messages.channelId))
    .innerJoin(parentMessages, eq(parentMessages.id, threadChannels.parentMessageId))
    .innerJoin(channels, eq(channels.id, parentMessages.channelId))
    .where(and(
      eq(channels.serverId, serverId),
      isNull(channels.deletedAt),
      eq(parentMessages.channelId, parentChannelId),
      eq(threadChannels.type, "thread"),
      ...messageIdShortPrefixConditions(shortId),
    ))
    .limit(2);
  return rows.length === 1 ? rows[0].messageId : null;
}

async function loadResolvedMessageRefs(serverId: string, matches: ParsedMatch[]): Promise<Map<string, string>> {
  if (matches.length === 0) return new Map();

  const db = getDb();
  const messageIdsByKey = new Map<string, string>();
  const uniqueMatches = new Map<string, ParsedMatch>();
  for (const match of matches) {
    uniqueMatches.set(parsedMatchKey(match), match);
  }

  for (const [key, match] of uniqueMatches) {
    const rawMessageId = match.parsed.messageId.toLowerCase();
    if (FULL_UUID_PATTERN.test(rawMessageId)) {
      messageIdsByKey.set(key, rawMessageId);
      continue;
    }
    if (!isMessageShortId(rawMessageId)) continue;

    // User-facing permalinks often use the 8-character message id prefix.
    // Resolve that prefix inside the permalink's target channel before
    // touching UUID columns; otherwise Postgres rejects the short id as an
    // invalid UUID and the whole send path fails.
    if (!match.parsed.threadParentMessageId) {
      const rows = await db
        .select({ messageId: messages.id })
        .from(messages)
        .innerJoin(channels, eq(channels.id, messages.channelId))
        .where(and(
          eq(channels.serverId, serverId),
          isNull(channels.deletedAt),
          eq(messages.channelId, match.parsed.channelId),
          ...messageIdShortPrefixConditions(rawMessageId),
        ))
        .limit(2);
      if (rows.length === 1) {
        messageIdsByKey.set(key, rows[0].messageId);
      } else if (rows.length === 0) {
        const threadReplyId = await resolveShortMessageIdWithinParentChannelThread(
          serverId,
          match.parsed.channelId,
          rawMessageId,
        );
        if (threadReplyId) {
          messageIdsByKey.set(key, threadReplyId);
        }
      }
    }
  }

  const messageIds = [...new Set(messageIdsByKey.values())];
  if (messageIds.length === 0) return new Map();

  const parentMessages = alias(messages, "parent_messages");
  const parentChannels = alias(channels, "parent_channels");
  const rows = await db
    .select({
      messageId: messages.id,
      channelName: channels.name,
      channelType: channels.type,
      parentMessageId: channels.parentMessageId,
      parentChannelName: parentChannels.name,
      parentChannelType: parentChannels.type,
    })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .leftJoin(parentMessages, eq(parentMessages.id, channels.parentMessageId))
    .leftJoin(parentChannels, eq(parentChannels.id, parentMessages.channelId))
    .where(
      and(
        eq(channels.serverId, serverId),
        isNull(channels.deletedAt),
        inArray(messages.id, messageIds),
      ),
    );

  const resolved = new Map<string, string>();
  const refsByMessageId = new Map<string, string>();
  for (const row of rows) {
    const ref = formatCanonicalAgentMessageRef(row);
    if (ref) refsByMessageId.set(row.messageId, ref);
  }
  for (const [key, messageId] of messageIdsByKey) {
    const ref = refsByMessageId.get(messageId);
    if (ref) resolved.set(key, ref);
  }
  return resolved;
}

async function loadReplacementMap(serverId: string, text: string): Promise<Map<string, string>> {
  const server = await serverService.getServer(serverId);
  if (!server?.slug) return new Map();

  const parsedMatches = collectParsedMatches(text, server.slug);
  if (parsedMatches.length === 0) return new Map();

  const resolvedRefs = await loadResolvedMessageRefs(serverId, parsedMatches);

  const replacements = new Map<string, string>();
  for (const match of parsedMatches) {
    const rendered = resolvedRefs.get(parsedMatchKey(match));
    if (rendered) replacements.set(match.rawUrl, rendered);
  }
  return replacements;
}

export async function renderAgentReadablePermalinks(text: string, serverId: string): Promise<string> {
  if (!text.includes("http")) return text;

  let replacements: Map<string, string>;
  try {
    replacements = await loadReplacementMap(serverId, text);
  } catch (err) {
    console.warn("[AgentPermalinkRender] Failed to render permalinks; preserving original content", {
      errorClass: err instanceof Error ? err.name : typeof err,
    });
    return text;
  }
  if (replacements.size === 0) return text;

  return replacePermalinksOutsideMarkdownCode(text, replacements);
}

export async function renderAgentReadablePermalinksInTexts(
  texts: string[],
  serverId: string,
): Promise<string[]> {
  if (texts.length === 0 || texts.every((text) => !text.includes("http"))) return texts;

  try {
    const server = await serverService.getServer(serverId);
    if (!server?.slug) return texts;

    const parsedMatchesByText = texts.map((text) => collectParsedMatches(text, server.slug));
    const resolvedRefs = await loadResolvedMessageRefs(serverId, parsedMatchesByText.flat());

    return texts.map((text, index) => {
      const matches = parsedMatchesByText[index];
      if (matches.length === 0) return text;

      const replacements = new Map<string, string>();
      for (const match of matches) {
        const rendered = resolvedRefs.get(parsedMatchKey(match));
        if (rendered) replacements.set(match.rawUrl, rendered);
      }
      if (replacements.size === 0) return text;

      return replacePermalinksOutsideMarkdownCode(text, replacements);
    });
  } catch (err) {
    console.warn("[AgentPermalinkRender] Failed to render permalink batch; preserving original content", {
      errorClass: err instanceof Error ? err.name : typeof err,
    });
    return texts;
  }
}
