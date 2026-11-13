// The one search snippet cut: message previews (server `buildSnippet`) and the
// channel-description subtitle of a destination hit (web) both cut here, so
// the clients show the same edges.
//
// The window keeps context around the first hit by DISPLAY WIDTH, not by
// characters: a CJK / fullwidth character takes two columns, so 70 characters
// of Chinese before the hit pushed it past the clients' two-line clamp. A
// phone-width hit line holds about 17 CJK characters, so 24 columns (12 CJK
// or 24 Latin characters) plus "…" keep the hit on the first line; the 160
// column total matches the old 70 + 90 characters for Latin text.
//
// The edges are then polished without ever moving past the hit: a cut inside
// a Latin word moves to the nearest space within a few characters (a longer
// word keeps the plain cut), leading separators / punctuation left by the cut
// ("，", ";", " ") are dropped, and an elided side is marked with "…" (U+2026,
// the design system's ellipsis), never "...".

export const SEARCH_SNIPPET_WIDTH_BEFORE_HIT = 24;
export const SEARCH_SNIPPET_WIDTH_AFTER_HIT = 136;
/** A snippet with no hit keeps its first 180 characters. */
export const SEARCH_SNIPPET_MAX_LENGTH_WITHOUT_HIT = 180;
/** How far (in UTF-16 units) a cut may move to reach a word boundary. */
export const SEARCH_SNIPPET_WORD_BOUNDARY_REACH = 12;
export const SEARCH_SNIPPET_ELLIPSIS = "…";

/** East Asian Wide / Fullwidth code points take two columns, everything else one. */
export function searchSnippetCharWidth(codePoint: number): 1 | 2 {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) // Hangul Jamo initials
    || (codePoint >= 0x2e80 && codePoint <= 0x303e) // CJK radicals, Kangxi, CJK symbols and punctuation
    || (codePoint >= 0x3041 && codePoint <= 0x33ff) // kana, Bopomofo, Hangul compatibility, CJK compatibility
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf) // CJK extension A
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff) // CJK unified ideographs
    || (codePoint >= 0xa000 && codePoint <= 0xa4cf) // Yi
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3) // Hangul syllables
    || (codePoint >= 0xf900 && codePoint <= 0xfaff) // CJK compatibility ideographs
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f) // CJK compatibility forms
    || (codePoint >= 0xff00 && codePoint <= 0xff60) // fullwidth forms
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6) // fullwidth signs
    || (codePoint >= 0x1f300 && codePoint <= 0x1f64f) // emoji pictographs
    || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) // supplemental symbols and pictographs
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK extensions B and later
  ) {
    return 2;
  }
  return 1;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Steps back from `index` over whole code points while they fit in `budget` columns. */
function snippetStartBefore(text: string, index: number, budget: number): number {
  let start = index;
  let width = 0;
  while (start > 0) {
    const previous = start >= 2 && isLowSurrogate(text.charCodeAt(start - 1)) && isHighSurrogate(text.charCodeAt(start - 2))
      ? start - 2
      : start - 1;
    width += searchSnippetCharWidth(text.codePointAt(previous) ?? 0);
    if (width > budget) break;
    start = previous;
  }
  return start;
}

/** Steps forward from `index` over whole code points while they fit in `budget` columns. */
function snippetEndAfter(text: string, index: number, budget: number): number {
  let end = index;
  let width = 0;
  while (end < text.length) {
    const codePoint = text.codePointAt(end) ?? 0;
    width += searchSnippetCharWidth(codePoint);
    if (width > budget) break;
    end += codePoint > 0xffff ? 2 : 1;
  }
  return end;
}

const NARROW_WORD_CHAR_RE = /[\p{L}\p{N}\p{M}_'’-]/u;
const SPACE_RE = /\s/;
// What a cut can leave at the start of the kept text: spaces, separators and
// closing / sentence punctuation. `@` and `#` are not here: they belong to a
// following handle or channel name.
const LEADING_DROP_RE = /[\s，。、；：！？,.;:!?）)\]】」』》〉”’"…·]/;
// What a cut can leave at the end before "…": spaces and separators.
const TRAILING_DROP_RE = /[\s，、；：,;:·]/;

/** A narrow (Latin-like) letter or digit: a cut between two of these is inside a word. */
function isNarrowWordChar(char: string | undefined): boolean {
  if (!char) return false;
  const codePoint = char.codePointAt(0) ?? 0;
  return searchSnippetCharWidth(codePoint) === 1 && NARROW_WORD_CHAR_RE.test(char);
}

/** Moves a start cut inside a word forward past the next space (within reach, never past `limit`). */
function startOnWordBoundary(text: string, start: number, limit: number): number {
  if (start <= 0 || !isNarrowWordChar(text[start - 1]) || !isNarrowWordChar(text[start])) return start;
  const reach = Math.min(limit, start + SEARCH_SNIPPET_WORD_BOUNDARY_REACH);
  for (let index = start; index < reach; index += 1) {
    if (SPACE_RE.test(text[index] ?? "")) return index + 1;
  }
  return start;
}

/** Moves an end cut inside a word back to the previous space (within reach, never before `limit`). */
function endOnWordBoundary(text: string, end: number, limit: number): number {
  if (end >= text.length || !isNarrowWordChar(text[end - 1]) || !isNarrowWordChar(text[end])) return end;
  const reach = Math.max(limit, end - SEARCH_SNIPPET_WORD_BOUNDARY_REACH);
  for (let index = end - 1; index >= reach; index -= 1) {
    if (SPACE_RE.test(text[index] ?? "")) return index;
  }
  return end;
}

function dropLeading(text: string, start: number, limit: number): number {
  let next = start;
  while (next < limit && LEADING_DROP_RE.test(text[next] ?? "")) next += 1;
  return next;
}

function dropTrailing(text: string, end: number, limit: number): number {
  let next = end;
  while (next > limit && TRAILING_DROP_RE.test(text[next - 1] ?? "")) next -= 1;
  return next;
}

/** The index (and token) of the first case-insensitive hit of any token, or -1. */
function findFirstHit(text: string, tokens: readonly string[]): { index: number; length: number } {
  const lower = text.toLowerCase();
  let index = -1;
  let length = 0;
  for (const token of tokens) {
    if (!token) continue;
    const at = lower.indexOf(token.toLowerCase());
    if (at >= 0 && (index === -1 || at < index)) {
      index = at;
      length = token.length;
    }
  }
  return { index, length };
}

/**
 * The search result snippet of `content` for `tokens`: whitespace collapsed,
 * the first hit kept whole and in view with the display-width context around
 * it, edges on word boundaries and elided sides marked with "…". Content with
 * no hit keeps its start (up to 180 characters).
 */
export function buildSearchSnippet(content: string, tokens: readonly string[]): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "";

  const hit = findFirstHit(compact, tokens);
  if (hit.index === -1) {
    if (compact.length <= SEARCH_SNIPPET_MAX_LENGTH_WITHOUT_HIT) return compact;
    let end = SEARCH_SNIPPET_MAX_LENGTH_WITHOUT_HIT - 1;
    if (isHighSurrogate(compact.charCodeAt(end - 1))) end -= 1;
    end = dropTrailing(compact, endOnWordBoundary(compact, end, 0), 0);
    return `${compact.slice(0, end)}${SEARCH_SNIPPET_ELLIPSIS}`;
  }

  const hitStart = hit.index;
  const hitEnd = hit.index + hit.length;
  let start = snippetStartBefore(compact, hitStart, SEARCH_SNIPPET_WIDTH_BEFORE_HIT);
  if (start > 0) start = dropLeading(compact, startOnWordBoundary(compact, start, hitStart), hitStart);
  let end = snippetEndAfter(compact, hitEnd, SEARCH_SNIPPET_WIDTH_AFTER_HIT);
  if (end < compact.length) end = dropTrailing(compact, endOnWordBoundary(compact, end, hitEnd), hitEnd);
  const prefix = start > 0 ? SEARCH_SNIPPET_ELLIPSIS : "";
  const suffix = end < compact.length ? SEARCH_SNIPPET_ELLIPSIS : "";
  return `${prefix}${compact.slice(start, end)}${suffix}`;
}
