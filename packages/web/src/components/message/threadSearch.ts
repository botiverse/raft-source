import type { Root } from "mdast";
import { messageTokenNode, replaceTokensInTree, SKIP_CODE_AND_TOKENS } from "./remarkMessageTokens";
import type { Message } from "../../store/messageStore";
import { searchHighlightPattern } from "../../features/search/searchHighlightParts";
import type { SearchHighlightPart } from "../../features/search/searchHighlightParts";
import { isFindShortcut } from "../../utils/keyboardShortcuts";

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

/** ⌘F / Ctrl+F (isFindShortcut, shared with an Artifact's find in page). */
export function isThreadSearchShortcut(
  event: ThreadSearchShortcutEvent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  return isFindShortcut(event, platform);
}

export function normalizeThreadSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function normalizeThreadSearchSelectionText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Wrap every match of `pattern` (global) in `<mark>`, on the parsed message
 *  tree. Text inside refs, mentions and code is left alone (inline code is
 *  marked by its own renderer); link labels are marked like any other text. */
function markPatternInTree(tree: Root, pattern: RegExp): void {
  replaceTokensInTree(
    tree,
    [{ pattern, replace: (match) => messageTokenNode("mark", match[0]) }],
    undefined,
    SKIP_CODE_AND_TOKENS,
  );
}

function threadSearchPattern(query: string): RegExp | null {
  const normalizedQuery = normalizeThreadSearchQuery(query);
  if (!normalizedQuery) return null;
  return new RegExp(`(${normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "giu");
}

/** Every case-insensitive hit of the thread-search query (task #762). */
export function highlightThreadSearchInTree(tree: Root, query: string): void {
  const pattern = threadSearchPattern(query);
  if (pattern) markPatternInTree(tree, pattern);
}

/**
 * The hits of the search an opened result came from (task #83), with the
 * result rows' matcher (searchHighlightParts.ts: a mark takes a directly preceding
 * `@` / `#`).
 */
export function highlightSearchHitInTree(tree: Root, query: string): void {
  const pattern = searchHighlightPattern(query);
  if (pattern) markPatternInTree(tree, pattern);
}

/** Thread search's split of a plain string (inline code) into hit / non-hit
 *  parts, the counterpart of `splitSearchHighlight`. */
export function splitThreadSearchHighlight(text: string, query: string): SearchHighlightPart[] {
  const pattern = threadSearchPattern(query);
  if (!pattern || !text) return [{ text, hit: false }];
  return text
    .split(pattern)
    .map((part, index) => ({ text: part, hit: index % 2 === 1 }))
    .filter((part) => part.text.length > 0);
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
