import { createBundledHighlighter } from "shiki/core";
import type { ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { normalizeCodeLanguage } from "./codeBlockLanguages";
import type { NormalizedCodeLanguage } from "./codeBlockLanguages";

export const SHIKI_CODE_THEME = "github-dark-high-contrast";

const shikiLanguages = {
  bash: () => import("shiki/dist/langs/bash.mjs"),
  c: () => import("shiki/dist/langs/c.mjs"),
  clojure: () => import("shiki/dist/langs/clojure.mjs"),
  cpp: () => import("shiki/dist/langs/cpp.mjs"),
  csharp: () => import("shiki/dist/langs/csharp.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  dart: () => import("shiki/dist/langs/dart.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  dockerfile: () => import("shiki/dist/langs/dockerfile.mjs"),
  elixir: () => import("shiki/dist/langs/elixir.mjs"),
  go: () => import("shiki/dist/langs/go.mjs"),
  graphql: () => import("shiki/dist/langs/graphql.mjs"),
  haskell: () => import("shiki/dist/langs/haskell.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  java: () => import("shiki/dist/langs/java.mjs"),
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  jsonc: () => import("shiki/dist/langs/jsonc.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  kotlin: () => import("shiki/dist/langs/kotlin.mjs"),
  lua: () => import("shiki/dist/langs/lua.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  perl: () => import("shiki/dist/langs/perl.mjs"),
  php: () => import("shiki/dist/langs/php.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  ruby: () => import("shiki/dist/langs/ruby.mjs"),
  rust: () => import("shiki/dist/langs/rust.mjs"),
  scala: () => import("shiki/dist/langs/scala.mjs"),
  shellscript: () => import("shiki/dist/langs/shellscript.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
  swift: () => import("shiki/dist/langs/swift.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  xml: () => import("shiki/dist/langs/xml.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
} as const;

const shikiThemes = {
  [SHIKI_CODE_THEME]: () => import("shiki/dist/themes/github-dark-high-contrast.mjs"),
} as const;

export type CodeTokenLine = ThemedToken[];

const createHighlighter = createBundledHighlighter({
  langs: shikiLanguages,
  themes: shikiThemes,
  engine: () => createJavaScriptRegexEngine(),
});

type CodeHighlighter = Awaited<ReturnType<typeof createHighlighter>>;

let highlighterPromise: Promise<CodeHighlighter> | null = null;
let highlighterInstance: CodeHighlighter | null = null;
let themePromise: Promise<void> | null = null;
let isThemeLoaded = false;
const languageLoadPromises = new Map<Exclude<NormalizedCodeLanguage, "text">, Promise<void>>();
const loadedLanguages = new Set<Exclude<NormalizedCodeLanguage, "text">>();

type HighlightCacheEntry = {
  promise: Promise<CodeTokenLine[]>;
  lines?: CodeTokenLine[];
  size: number;
};

const DEFAULT_HIGHLIGHT_CACHE_MAX_ENTRIES = 128;
const DEFAULT_HIGHLIGHT_CACHE_MAX_CHARS = 2 * 1024 * 1024;
const highlightedCodeCache = new Map<string, HighlightCacheEntry>();
let highlightCacheMaxEntries = DEFAULT_HIGHLIGHT_CACHE_MAX_ENTRIES;
let highlightCacheMaxChars = DEFAULT_HIGHLIGHT_CACHE_MAX_CHARS;
let highlightedCodeCacheChars = 0;

const COMMON_PREFETCH_LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "json",
  "java",
] as const satisfies readonly Exclude<NormalizedCodeLanguage, "text">[];

function cacheEntrySize(code: string): number {
  return code.length;
}

function touchCacheEntry(key: string, entry: HighlightCacheEntry) {
  highlightedCodeCache.delete(key);
  highlightedCodeCache.set(key, entry);
}

function trimHighlightedCodeCache() {
  for (const [oldestKey, oldest] of highlightedCodeCache) {
    if (
      highlightedCodeCache.size <= highlightCacheMaxEntries &&
      highlightedCodeCacheChars <= highlightCacheMaxChars
    ) {
      return;
    }

    highlightedCodeCache.delete(oldestKey);
    highlightedCodeCacheChars -= oldest.size;
  }
}

function getHighlighter(): Promise<CodeHighlighter> {
  if (highlighterInstance) return Promise.resolve(highlighterInstance);
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({ themes: [], langs: [] }).then((highlighter) => {
      highlighterInstance = highlighter;
      return highlighter;
    });
  }
  return highlighterPromise;
}

function ensureThemeLoaded(highlighter: CodeHighlighter): Promise<void> {
  if (isThemeLoaded) return Promise.resolve();
  if (!themePromise) {
    themePromise = highlighter.loadTheme(SHIKI_CODE_THEME).then(() => {
      isThemeLoaded = true;
    });
  }
  return themePromise;
}

function ensureLanguageLoaded(
  highlighter: CodeHighlighter,
  language: Exclude<NormalizedCodeLanguage, "text">,
): Promise<void> {
  if (loadedLanguages.has(language)) return Promise.resolve();

  const existing = languageLoadPromises.get(language);
  if (existing) return existing;

  const promise = highlighter.loadLanguage(language).then(() => {
    loadedLanguages.add(language);
  });
  languageLoadPromises.set(language, promise);
  return promise;
}

function addHighlightCacheEntry(
  key: string,
  entry: HighlightCacheEntry,
): HighlightCacheEntry {
  highlightedCodeCache.set(key, entry);
  highlightedCodeCacheChars += entry.size;
  trimHighlightedCodeCache();
  return entry;
}

export async function highlightCode(code: string, language: string | null | undefined): Promise<CodeTokenLine[]> {
  const normalizedLanguage = normalizeCodeLanguage(language);
  if (normalizedLanguage === "text") return [[{ content: code, offset: 0 }]];

  return getHighlightedCode(code, normalizedLanguage);
}

export function getHighlightedCode(code: string, language: Exclude<NormalizedCodeLanguage, "text">): Promise<CodeTokenLine[]> {
  const key = `${SHIKI_CODE_THEME}:${language}:${code}`;
  const cached = highlightedCodeCache.get(key);
  if (cached) {
    touchCacheEntry(key, cached);
    return cached.promise;
  }

  const entry: HighlightCacheEntry = {
    promise: getHighlighter().then(async (highlighter) => {
      await ensureThemeLoaded(highlighter);
      await ensureLanguageLoaded(highlighter, language);
      const lines = highlighter.codeToTokensBase(code, { lang: language, theme: SHIKI_CODE_THEME });
      entry.lines = lines;
      return lines;
    }),
    size: cacheEntrySize(code),
  };
  return addHighlightCacheEntry(key, entry).promise;
}

export function tryHighlightCodeSync(
  code: string,
  language: string | null | undefined,
): CodeTokenLine[] | null {
  const normalizedLanguage = normalizeCodeLanguage(language);
  if (normalizedLanguage === "text") return null;

  const key = `${SHIKI_CODE_THEME}:${normalizedLanguage}:${code}`;
  const cached = highlightedCodeCache.get(key);
  if (cached?.lines) {
    touchCacheEntry(key, cached);
    return cached.lines;
  }

  if (!highlighterInstance || !isThemeLoaded || !loadedLanguages.has(normalizedLanguage)) {
    return null;
  }

  const lines = highlighterInstance.codeToTokensBase(code, {
    lang: normalizedLanguage,
    theme: SHIKI_CODE_THEME,
  });
  addHighlightCacheEntry(key, {
    promise: Promise.resolve(lines),
    lines,
    size: cacheEntrySize(code),
  });
  return lines;
}

export function prefetchCommonCodeLanguages(): Promise<unknown[]> {
  return Promise.all(
    COMMON_PREFETCH_LANGUAGES.map((language) => getHighlightedCode("", language).catch(() => undefined)),
  );
}

export function __getShikiHighlightedCodeCacheSizeForTests(): number {
  return highlightedCodeCache.size;
}

export function __getShikiHighlightedCodeCacheCharsForTests(): number {
  return highlightedCodeCacheChars;
}

export function __resetShikiHighlightedCodeCacheForTests(): void {
  highlightedCodeCache.clear();
  highlightedCodeCacheChars = 0;
  highlightCacheMaxEntries = DEFAULT_HIGHLIGHT_CACHE_MAX_ENTRIES;
  highlightCacheMaxChars = DEFAULT_HIGHLIGHT_CACHE_MAX_CHARS;
}

export function __setShikiHighlightedCodeCacheLimitsForTests(limits: {
  maxEntries?: number;
  maxChars?: number;
}): void {
  highlightCacheMaxEntries = limits.maxEntries ?? DEFAULT_HIGHLIGHT_CACHE_MAX_ENTRIES;
  highlightCacheMaxChars = limits.maxChars ?? DEFAULT_HIGHLIGHT_CACHE_MAX_CHARS;
  trimHighlightedCodeCache();
}
