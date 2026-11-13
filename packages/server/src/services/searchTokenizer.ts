// The platform's search tokenizer: jieba-wasm over text with Markdown noise
// and URLs removed, tokens lowercased when they hold ASCII letters, for
// indexes fed to `to_tsvector('simple', ...)`. Two sides, never mixed up:
//
// - QUERY side: tokenizeSearchText (jieba `cut`, whole words). Every search
//   tokenizes the user's query with it.
// - INDEX side: buildSearchIndexText (jieba `cut_for_search`: every word
//   `cut` finds plus its dictionary sub-words, 财务报告 -> 财务 报告 财务报告),
//   so a query word that is part of a longer stored word still matches.
//   Artifacts' index uses it.
//
// Messages' search_text is the exception: it is still built with the query
// side (buildSearchText); moving it to the index side means recomputing
// every message's search_text, a separate change.
import { cut, cut_for_search } from "jieba-wasm";

const INLINE_CODE_RE = /`([^`]+)`/g;
const FENCED_CODE_RE = /```([\s\S]*?)```/g;
const IMAGE_RE = /!\[([^\]]*)\]\([^)]+\)/g;
const LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const URL_RE = /https?:\/\/\S+/g;
const MARKDOWN_DECORATION_RE = /[*_~>|]/g;
const MULTISPACE_RE = /\s+/g;

function normalizeToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null;
  return /[A-Za-z]/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

export function preprocessSearchContent(content: string): string {
  return content
    .replace(FENCED_CODE_RE, " $1 ")
    .replace(INLINE_CODE_RE, " $1 ")
    .replace(IMAGE_RE, " $1 ")
    .replace(LINK_RE, " $1 ")
    .replace(URL_RE, " ")
    .replace(MARKDOWN_DECORATION_RE, " ")
    .replace(MULTISPACE_RE, " ")
    .trim();
}

/** QUERY side: the words of a search query (jieba `cut`). Not for building an index; see buildSearchIndexText. */
export function tokenizeSearchText(content: string): string[] {
  return cut(preprocessSearchContent(content))
    .map(normalizeToken)
    .filter((token): token is string => !!token);
}

/**
 * Messages' search_text: the query side's words joined by spaces. Kept for
 * messages only (see the header); a new index uses buildSearchIndexText.
 */
export function buildSearchText(content: string): string {
  return tokenizeSearchText(content).join(" ");
}

/**
 * INDEX side: what to store for `to_tsvector('simple', ...)` (jieba
 * `cut_for_search`: the query side's words and their sub-words, joined by
 * spaces), so every word tokenizeSearchText finds in a query also matches
 * part of a longer stored word. Never tokenize a query with this.
 */
export function buildSearchIndexText(content: string): string {
  return cut_for_search(preprocessSearchContent(content))
    .map(normalizeToken)
    .filter((token): token is string => !!token)
    .join(" ");
}
