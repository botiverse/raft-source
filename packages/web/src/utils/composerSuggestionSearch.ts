import { composerGeneratedPinyin } from "../generated/composerPinyinData";

const COMPOSER_SUGGESTION_MAX_RESULTS = 30;

export interface ComposerSuggestionSearchField {
  raw: string;
  priority: number;
}

export interface ComposerSuggestionSearchEntry<T> {
  index: number;
  suggestion: T;
  fields: ComposerSuggestionSearchField[];
}

interface ComposerSuggestionScore {
  rank: number;
  fieldPriority: number;
  position: number;
  gap: number;
}

interface ComposerSuggestionQueryKey {
  rawLowercase: string;
  compact: string;
  tokens: string[];
  pinyinFull: string;
  pinyinInitials: string;
  variants: string[];
  isBlank: boolean;
  enablesFuzzy: boolean;
}

interface ComposerNormalizedSearchText {
  tokens: string[];
  compact: string;
}

export function rankComposerSuggestions<T>(query: string, entries: ComposerSuggestionSearchEntry<T>[]): T[] {
  const queryKey = buildComposerSuggestionQueryKey(query);
  if (queryKey.isBlank) return entries.map((entry) => entry.suggestion);

  return entries
    .map((entry) => {
      const score = minScore(entry.fields.map((field) => scoreComposerSuggestionField(field, queryKey)));
      return score ? { index: entry.index, suggestion: entry.suggestion, score } : null;
    })
    .filter((entry): entry is { index: number; suggestion: T; score: ComposerSuggestionScore } => entry != null)
    .sort((a, b) => compareRankedSuggestion(a, b))
    .slice(0, COMPOSER_SUGGESTION_MAX_RESULTS)
    .map((entry) => entry.suggestion);
}

export function rankBasicComposerSuggestions<T>(query: string, entries: ComposerSuggestionSearchEntry<T>[]): T[] {
  const normalizedQuery = query.trim().replace(/^[@#]/, "").toLowerCase();
  if (!normalizedQuery) return entries.map((entry) => entry.suggestion);

  return entries
    .map((entry) => {
      const matches = entry.fields
        .map((field) => {
          const raw = field.raw.toLowerCase();
          const position = raw.indexOf(normalizedQuery);
          if (position < 0) return null;
          const rank = raw === normalizedQuery ? 0 : position === 0 ? 1 : 2;
          return { rank, fieldPriority: field.priority, position };
        })
        .filter((match): match is { rank: number; fieldPriority: number; position: number } => match != null)
        .sort((a, b) => a.rank - b.rank || a.fieldPriority - b.fieldPriority || a.position - b.position);
      const score = matches[0];
      return score ? { index: entry.index, suggestion: entry.suggestion, score } : null;
    })
    .filter((entry): entry is { index: number; suggestion: T; score: { rank: number; fieldPriority: number; position: number } } => entry != null)
    .sort((a, b) => a.score.rank - b.score.rank
      || a.score.fieldPriority - b.score.fieldPriority
      || a.score.position - b.score.position
      || a.index - b.index)
    .slice(0, COMPOSER_SUGGESTION_MAX_RESULTS)
    .map((entry) => entry.suggestion);
}

export function normalizeComposerSearchText(raw: string): ComposerNormalizedSearchText {
  const tokens: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };

  for (const char of raw) {
    const normalized = char.toLowerCase();
    if (isComposerSearchTokenChar(normalized)) {
      current += normalized;
    } else {
      flush();
    }
  }
  flush();

  return { tokens, compact: tokens.join("") };
}

export function toComposerPinyinFull(raw: string): string {
  let result = "";
  for (const char of raw) {
    const pinyin = composerGeneratedPinyin(char);
    if (pinyin) {
      result += pinyin;
      continue;
    }
    const latin = composerLatinSearchChar(char);
    if (latin) result += latin;
  }
  return result;
}

export function toComposerPinyinInitials(raw: string): string {
  let result = "";
  let previousWasToken = false;
  for (const char of raw) {
    const pinyin = composerGeneratedPinyin(char);
    if (pinyin) {
      result += pinyin[0];
      previousWasToken = false;
      continue;
    }
    if (isAsciiLetterOrDigit(char)) {
      if (!previousWasToken) result += char.toLowerCase();
      previousWasToken = true;
    } else {
      previousWasToken = false;
    }
  }
  return result;
}

function buildComposerSuggestionQueryKey(query: string): ComposerSuggestionQueryKey {
  const clean = query.trim().replace(/^[@#]/, "");
  const normalized = normalizeComposerSearchText(clean);
  const pinyinFull = toComposerPinyinFull(clean);
  const variants = [...new Set([normalized.compact, pinyinFull].map((variant) => variant.trim()).filter(Boolean))];
  return {
    rawLowercase: clean.toLowerCase(),
    compact: normalized.compact,
    tokens: normalized.tokens,
    pinyinFull,
    pinyinInitials: toComposerPinyinInitials(clean),
    variants,
    isBlank: clean.toLowerCase().trim().length === 0,
    enablesFuzzy: normalized.compact.length >= 2,
  };
}

function scoreComposerSuggestionField(
  field: ComposerSuggestionSearchField,
  query: ComposerSuggestionQueryKey,
): ComposerSuggestionScore | null {
  const rawLowercase = field.raw.toLowerCase();
  const normalized = normalizeComposerSearchText(field.raw);
  const pinyinFull = toComposerPinyinFull(field.raw);
  const pinyinInitials = toComposerPinyinInitials(field.raw);

  if (!normalized.compact && !pinyinFull && !pinyinInitials) return null;

  return exactScore(field, query, normalized, pinyinFull)
    ?? prefixScore(field, query, normalized)
    ?? tokenPrefixScore(field, query, normalized)
    ?? substringScore(field, query, normalized)
    ?? pinyinFullScore(field, query, pinyinFull)
    ?? pinyinInitialsScore(field, query, pinyinInitials)
    ?? fuzzySubsequenceScore(field, query, normalized, pinyinFull)
    ?? legacySubstringScore(field, query, rawLowercase);
}

function exactScore(
  field: ComposerSuggestionSearchField,
  query: ComposerSuggestionQueryKey,
  normalized: ComposerNormalizedSearchText,
  pinyinFull: string,
): ComposerSuggestionScore | null {
  return query.variants.some((variant) => normalized.compact === variant || pinyinFull === variant)
    ? { rank: 0, fieldPriority: field.priority, position: 0, gap: 0 }
    : null;
}

function prefixScore(
  field: ComposerSuggestionSearchField,
  query: ComposerSuggestionQueryKey,
  normalized: ComposerNormalizedSearchText,
): ComposerSuggestionScore | null {
  const variant = query.variants.find((candidate) => normalized.compact.startsWith(candidate));
  return variant
    ? { rank: 1, fieldPriority: field.priority, position: 0, gap: normalized.compact.length - variant.length }
    : null;
}

function tokenPrefixScore(
  field: ComposerSuggestionSearchField,
  query: ComposerSuggestionQueryKey,
  normalized: ComposerNormalizedSearchText,
): ComposerSuggestionScore | null {
  if (query.tokens.length === 0 || normalized.tokens.length === 0) return null;
  const matchIndex = normalized.tokens.findIndex((token) => token.startsWith(query.tokens[0] ?? ""));
  if (matchIndex < 0) return null;

  let candidateIndex = matchIndex;
  for (const queryToken of query.tokens) {
    while (candidateIndex < normalized.tokens.length && !normalized.tokens[candidateIndex]?.startsWith(queryToken)) {
      candidateIndex += 1;
    }
    if (candidateIndex >= normalized.tokens.length) return null;
    candidateIndex += 1;
  }

  return {
    rank: 2,
    fieldPriority: field.priority,
    position: matchIndex,
    gap: candidateIndex - matchIndex - query.tokens.length,
  };
}

function substringScore(
  field: ComposerSuggestionSearchField,
  query: ComposerSuggestionQueryKey,
  normalized: ComposerNormalizedSearchText,
): ComposerSuggestionScore | null {
  const bestPosition = minNumber(query.variants.map((variant) => normalized.compact.indexOf(variant)).filter((index) => index >= 0));
  return bestPosition == null
    ? null
    : { rank: 3, fieldPriority: field.priority, position: bestPosition, gap: 0 };
}

function pinyinFullScore(
  field: ComposerSuggestionSearchField,
  query: ComposerSuggestionQueryKey,
  pinyinFull: string,
): ComposerSuggestionScore | null {
  if (field.priority > 1 || !query.enablesFuzzy) return null;
  const bestPosition = minNumber(query.variants.map((variant) => pinyinFull.indexOf(variant)).filter((index) => index >= 0));
  return bestPosition == null
    ? null
    : { rank: 4, fieldPriority: field.priority, position: bestPosition, gap: 0 };
}

function pinyinInitialsScore(
  field: ComposerSuggestionSearchField,
  query: ComposerSuggestionQueryKey,
  pinyinInitials: string,
): ComposerSuggestionScore | null {
  if (field.priority > 1 || !query.enablesFuzzy || query.compact.length < 2) return null;
  const position = pinyinInitials.indexOf(query.compact);
  return position < 0 ? null : { rank: 5, fieldPriority: field.priority, position, gap: 0 };
}

function fuzzySubsequenceScore(
  field: ComposerSuggestionSearchField,
  query: ComposerSuggestionQueryKey,
  normalized: ComposerNormalizedSearchText,
  pinyinFull: string,
): ComposerSuggestionScore | null {
  if (field.priority > 1 || !query.enablesFuzzy || query.compact.length < 3) return null;
  const compactScore = boundedSubsequenceScore(normalized.compact, query.compact);
  const pinyinScore = boundedSubsequenceScore(pinyinFull, query.compact);
  const score = minScore([compactScore, pinyinScore]);
  return score ? { ...score, rank: 6, fieldPriority: field.priority } : null;
}

function legacySubstringScore(
  field: ComposerSuggestionSearchField,
  query: ComposerSuggestionQueryKey,
  rawLowercase: string,
): ComposerSuggestionScore | null {
  if (!query.rawLowercase) return null;
  const position = rawLowercase.indexOf(query.rawLowercase);
  return position < 0 ? null : { rank: 7, fieldPriority: field.priority, position, gap: 0 };
}

function boundedSubsequenceScore(candidate: string, query: string): ComposerSuggestionScore | null {
  if (!candidate || !query) return null;
  let searchFrom = 0;
  let first = -1;
  let last = -1;
  for (const char of query) {
    const index = candidate.indexOf(char, searchFrom);
    if (index < 0) return null;
    if (first < 0) first = index;
    last = index;
    searchFrom = index + 1;
  }
  const span = last - first + 1;
  const gap = span - query.length;
  const allowedGap = Math.max(2, query.length * 2);
  return gap > allowedGap ? null : { rank: 6, fieldPriority: 0, position: first, gap };
}

function compareRankedSuggestion<T>(
  a: { index: number; score: ComposerSuggestionScore; suggestion: T },
  b: { index: number; score: ComposerSuggestionScore; suggestion: T },
): number {
  return a.score.rank - b.score.rank
    || a.score.fieldPriority - b.score.fieldPriority
    || a.score.position - b.score.position
    || a.score.gap - b.score.gap
    || a.index - b.index;
}

function minScore(scores: Array<ComposerSuggestionScore | null>): ComposerSuggestionScore | null {
  return scores
    .filter((score): score is ComposerSuggestionScore => score != null)
    .sort((a, b) => a.rank - b.rank || a.fieldPriority - b.fieldPriority || a.position - b.position || a.gap - b.gap)[0] ?? null;
}

function minNumber(values: number[]): number | null {
  return values.length > 0 ? Math.min(...values) : null;
}

function composerLatinSearchChar(char: string): string | null {
  const normalized = char.toLowerCase();
  return isAsciiLetterOrDigit(normalized) ? normalized : null;
}

function isComposerSearchTokenChar(char: string): boolean {
  return isLetterOrDigit(char) || isBasicCjk(char);
}

function isLetterOrDigit(char: string): boolean {
  return /^\p{L}$|^\p{N}$/u.test(char);
}

function isAsciiLetterOrDigit(char: string): boolean {
  return /^[a-z0-9]$/i.test(char);
}

function isBasicCjk(char: string): boolean {
  const code = char.codePointAt(0);
  return code != null && code >= 0x4e00 && code <= 0x9fff;
}
