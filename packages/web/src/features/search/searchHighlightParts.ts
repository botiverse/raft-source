// Query → hit marking for search result text (message snippets, entity titles
// and subtitles). A query token marks every case-insensitive occurrence, and a
// mark also takes a directly preceding `@` / `#`, so "remy" marks the whole
// handle in "@Remy" and "#remy" still marks "remy" in a channel title.

export function searchHighlightTokens(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of query.trim().split(/\s+/)) {
    const token = part.replace(/^[@#]+/, "");
    const key = token.toLowerCase();
    if (!token || seen.has(key)) continue;
    seen.add(key);
    tokens.push(token);
  }
  return tokens;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SearchHighlightPart {
  text: string;
  hit: boolean;
}

/**
 * The global, case-insensitive pattern of a query's hits (one capture group:
 * the whole hit, with a directly preceding `@` / `#`), or null for a query
 * with no tokens. Shared by the result rows and the opened message's marks.
 */
export function searchHighlightPattern(query: string): RegExp | null {
  const tokens = searchHighlightTokens(query);
  if (tokens.length === 0) return null;
  // Longest first, so "remy-dev" wins over "remy" at the same position.
  const alternatives = [...tokens].sort((left, right) => right.length - left.length).map(escapeRegExp);
  return new RegExp(`([@#]?(?:${alternatives.join("|")}))`, "ig");
}

export function splitSearchHighlight(text: string, query: string): SearchHighlightPart[] {
  const re = searchHighlightPattern(query);
  if (!re || !text) return [{ text, hit: false }];
  // One capture group: split puts every match at an odd index.
  return text
    .split(re)
    .map((part, index) => ({ text: part, hit: index % 2 === 1 }))
    .filter((part) => part.text.length > 0);
}

export function findSearchHit(text: string, query: string): number {
  const lower = text.toLowerCase();
  let first = -1;
  for (const token of searchHighlightTokens(query)) {
    const index = lower.indexOf(token.toLowerCase());
    if (index >= 0 && (first === -1 || index < first)) first = index;
  }
  return first;
}
