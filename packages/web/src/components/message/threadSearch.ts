import type { Message } from "../../store/messageStore";

export interface ThreadSearchMessage {
  id: string;
  content?: string | null;
  senderName?: string | null;
}

export interface ThreadSearchMatch {
  messageId: string;
}

export interface ThreadSearchShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

function isApplePlatform(platform: string | null | undefined): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "");
}

export function isThreadSearchShortcut(
  event: ThreadSearchShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (event.key.toLowerCase() !== "f") return false;
  if (event.altKey || event.shiftKey) return false;
  return isApplePlatform(platform)
    ? !!event.metaKey && !event.ctrlKey
    : !!event.ctrlKey && !event.metaKey;
}

export function normalizeThreadSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function normalizeThreadSearchSelectionText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeThreadSearchHtmlEntity(entity: string): string | null {
  switch (entity) {
    case "&amp;":
      return "&";
    case "&lt;":
      return "<";
    case "&gt;":
      return ">";
    case "&quot;":
      return "\"";
    case "&#39;":
    case "&apos;":
      return "'";
    default:
      return null;
  }
}

function highlightThreadSearchTextChunk(chunk: string, normalizedQuery: string): string {
  if (!chunk || !normalizedQuery) return chunk;

  const visibleChars: Array<{ value: string; start: number; end: number }> = [];
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] === "&") {
      const entityEnd = chunk.indexOf(";", index + 1);
      if (entityEnd !== -1) {
        const entity = chunk.slice(index, entityEnd + 1);
        const decoded = decodeThreadSearchHtmlEntity(entity);
        if (decoded !== null) {
          visibleChars.push({ value: decoded, start: index, end: entityEnd + 1 });
          index = entityEnd;
          continue;
        }
      }
    }
    visibleChars.push({ value: chunk[index], start: index, end: index + 1 });
  }

  const visibleText = visibleChars.map((entry) => entry.value).join("");
  const lowerChunk = visibleText.toLocaleLowerCase();
  const parts: string[] = [];
  let sourceCursor = 0;
  let visibleCursor = 0;
  let index = lowerChunk.indexOf(normalizedQuery, visibleCursor);
  while (index !== -1) {
    const sourceStart = visibleChars[index]?.start;
    const sourceEnd = visibleChars[index + normalizedQuery.length - 1]?.end;
    if (sourceStart === undefined || sourceEnd === undefined) break;
    parts.push(chunk.slice(sourceCursor, sourceStart));
    parts.push(`<mark>${chunk.slice(sourceStart, sourceEnd)}</mark>`);
    sourceCursor = sourceEnd;
    visibleCursor = index + normalizedQuery.length;
    index = lowerChunk.indexOf(normalizedQuery, visibleCursor);
  }
  parts.push(chunk.slice(sourceCursor));
  return parts.join("");
}

export function highlightThreadSearchMarkdownFragments(source: string, query: string): string {
  const normalizedQuery = normalizeThreadSearchQuery(query);
  if (!source || !normalizedQuery) return source;

  // oxlint-disable-next-line no-control-regex -- NUL (\u0000) is the existing private sentinel for protected markdown code tokens.
  const protectedTokenPattern = /(<[^>]+>|\x00CODE\d+\x00)/g;
  const parts: string[] = [];
  let cursor = 0;
  let controlledHtmlDepth = 0;
  for (const match of source.matchAll(protectedTokenPattern)) {
    const index = match.index ?? 0;
    const token = match[0];
    const textChunk = source.slice(cursor, index);
    parts.push(
      controlledHtmlDepth > 0
        ? textChunk
        : highlightThreadSearchTextChunk(textChunk, normalizedQuery),
    );
    parts.push(token);
    if (/^<(a|span)\b/i.test(token)) {
      controlledHtmlDepth += 1;
    } else if (/^<\/(a|span)>/i.test(token)) {
      controlledHtmlDepth = Math.max(0, controlledHtmlDepth - 1);
    }
    cursor = index + match[0].length;
  }
  const tailChunk = source.slice(cursor);
  parts.push(
    controlledHtmlDepth > 0
      ? tailChunk
      : highlightThreadSearchTextChunk(tailChunk, normalizedQuery),
  );
  return parts.join("");
}

function getThreadSearchText(message: ThreadSearchMessage): string {
  return `${message.senderName ?? ""}\n${message.content ?? ""}`.toLocaleLowerCase();
}

export function buildThreadSearchMatches(
  messages: ThreadSearchMessage[],
  query: string,
): ThreadSearchMatch[] {
  const normalizedQuery = normalizeThreadSearchQuery(query);
  if (!normalizedQuery) return [];

  const matches: ThreadSearchMatch[] = [];
  for (const message of messages) {
    if (!message.id) continue;
    if (getThreadSearchText(message).includes(normalizedQuery)) {
      matches.push({ messageId: message.id });
    }
  }
  return matches;
}

export function getThreadSearchableMessages(
  parentMessage: Message | null,
  replies: Message[],
): ThreadSearchMessage[] {
  return parentMessage ? [parentMessage, ...replies] : replies;
}
