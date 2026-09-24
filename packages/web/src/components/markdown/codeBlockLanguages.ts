const PLAIN_TEXT_LANGUAGE = "text";

export const SUPPORTED_CODE_LANGUAGES = [
  "bash",
  "c",
  "clojure",
  "cpp",
  "csharp",
  "css",
  "dart",
  "diff",
  "dockerfile",
  "elixir",
  "go",
  "graphql",
  "haskell",
  "html",
  "java",
  "javascript",
  "json",
  "jsonc",
  "jsx",
  "kotlin",
  "lua",
  "markdown",
  "perl",
  "php",
  "python",
  "ruby",
  "rust",
  "scala",
  "shellscript",
  "sql",
  "swift",
  "tsx",
  "typescript",
  "xml",
  "yaml",
] as const;

export type SupportedCodeLanguage = typeof SUPPORTED_CODE_LANGUAGES[number];
export type NormalizedCodeLanguage = SupportedCodeLanguage | typeof PLAIN_TEXT_LANGUAGE;

const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_CODE_LANGUAGES);

const LANGUAGE_ALIASES: Record<string, SupportedCodeLanguage> = {
  "c++": "cpp",
  cc: "cpp",
  cjs: "javascript",
  clj: "clojure",
  cljs: "clojure",
  cs: "csharp",
  cxx: "cpp",
  docker: "dockerfile",
  ex: "elixir",
  exs: "elixir",
  gql: "graphql",
  hs: "haskell",
  js: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  lhs: "haskell",
  md: "markdown",
  mjs: "javascript",
  pl: "perl",
  perl5: "perl",
  py: "python",
  rb: "ruby",
  sh: "shellscript",
  shell: "shellscript",
  ts: "typescript",
  yml: "yaml",
  zsh: "shellscript",
};

export function normalizeCodeLanguage(language: string | null | undefined): NormalizedCodeLanguage {
  const normalized = (language || "").trim().toLowerCase().replace(/^language-/, "");
  if (!normalized || normalized === "txt" || normalized === "plaintext" || normalized === "plain") {
    return PLAIN_TEXT_LANGUAGE;
  }
  if (normalized in LANGUAGE_ALIASES) return LANGUAGE_ALIASES[normalized];
  if (SUPPORTED_LANGUAGE_SET.has(normalized)) return normalized as SupportedCodeLanguage;
  return PLAIN_TEXT_LANGUAGE;
}

export function codeLanguageClass(language: string | null | undefined): string | undefined {
  const normalized = (language || "").trim().toLowerCase().replace(/^language-/, "");
  return normalized ? `language-${normalized}` : undefined;
}

export function shouldHighlightCode(language: string | null | undefined): boolean {
  return normalizeCodeLanguage(language) !== PLAIN_TEXT_LANGUAGE;
}
