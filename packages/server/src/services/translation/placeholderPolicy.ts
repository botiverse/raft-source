export interface TranslationPlaceholderPolicy {
  readonly name: string;
  extract(text: string): readonly string[];
}

export interface RegexPlaceholderPolicyOptions {
  name: string;
  pattern: RegExp;
  normalizeToken?: (token: string) => string;
}

export function createRegexPlaceholderPolicy(
  options: RegexPlaceholderPolicyOptions,
): TranslationPlaceholderPolicy {
  const normalizeToken = options.normalizeToken ?? ((token: string) => token);

  return {
    name: options.name,
    extract(text: string): readonly string[] {
      const pattern = new RegExp(
        options.pattern.source,
        options.pattern.flags.includes("g") ? options.pattern.flags : `${options.pattern.flags}g`,
      );
      return Array.from(text.matchAll(pattern), (match) => normalizeToken(match[0] ?? ""));
    },
  };
}

export const bracePlaceholderPolicy: TranslationPlaceholderPolicy = createRegexPlaceholderPolicy({
  name: "brace-placeholder-v1",
  pattern: /\{[A-Z0-9_:-]+\}/g,
});
