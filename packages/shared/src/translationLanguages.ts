const SUPPORTED_TRANSLATION_LANGUAGE_CODES = [
  "en",
  "zh-cn",
  "zh-tw",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "pt-br",
  "it",
] as const;

export type SupportedTranslationLanguageCode = typeof SUPPORTED_TRANSLATION_LANGUAGE_CODES[number];

export const SUPPORTED_TRANSLATION_LANGUAGES: ReadonlyArray<{
  value: SupportedTranslationLanguageCode;
  label: string;
}> = [
  { value: "en", label: "English" },
  { value: "zh-cn", label: "Simplified Chinese" },
  { value: "zh-tw", label: "Traditional Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt-br", label: "Portuguese (Brazil)" },
  { value: "it", label: "Italian" },
];

const SUPPORTED_TRANSLATION_LANGUAGE_SET = new Set<string>(
  SUPPORTED_TRANSLATION_LANGUAGE_CODES,
);

const TRANSLATION_LANGUAGE_ALIASES: Record<string, SupportedTranslationLanguageCode> = {
  zh: "zh-cn",
  "zh-hans": "zh-cn",
  "zh-hant": "zh-tw",
};

export function normalizeTranslationLanguageCode(
  language: string | null | undefined,
): SupportedTranslationLanguageCode | null {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return null;
  const alias = TRANSLATION_LANGUAGE_ALIASES[normalized];
  if (alias) return alias;
  if (SUPPORTED_TRANSLATION_LANGUAGE_SET.has(normalized)) {
    return normalized as SupportedTranslationLanguageCode;
  }

  const base = normalized.split("-")[0];
  if (base && SUPPORTED_TRANSLATION_LANGUAGE_SET.has(base)) {
    return base as SupportedTranslationLanguageCode;
  }

  return null;
}
