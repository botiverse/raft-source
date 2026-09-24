import {
  TranslationPlaceholderValidationError,
} from "./errors.js";
import type { TranslationPlaceholderPolicy } from "./placeholderPolicy.js";
import type { TranslationProviderVersion } from "./types.js";

export interface TranslationPlaceholderValidationResult {
  readonly sourcePlaceholders: readonly string[];
  readonly translatedPlaceholders: readonly string[];
  readonly missingPlaceholders: readonly string[];
  readonly unexpectedPlaceholders: readonly string[];
  readonly ok: boolean;
}

function countPlaceholders(placeholders: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const placeholder of placeholders) {
    counts.set(placeholder, (counts.get(placeholder) ?? 0) + 1);
  }
  return counts;
}

export function validateTranslationPlaceholders(
  sourceText: string,
  translatedText: string,
  policy: TranslationPlaceholderPolicy,
): TranslationPlaceholderValidationResult {
  const sourcePlaceholders = [...policy.extract(sourceText)];
  const translatedPlaceholders = [...policy.extract(translatedText)];
  const sourceCounts = countPlaceholders(sourcePlaceholders);
  const translatedCounts = countPlaceholders(translatedPlaceholders);

  const missingPlaceholders: string[] = [];
  const unexpectedPlaceholders: string[] = [];

  for (const [placeholder, count] of sourceCounts) {
    const translatedCount = translatedCounts.get(placeholder) ?? 0;
    for (let i = translatedCount; i < count; i += 1) {
      missingPlaceholders.push(placeholder);
    }
  }

  for (const [placeholder, count] of translatedCounts) {
    const sourceCount = sourceCounts.get(placeholder) ?? 0;
    for (let i = sourceCount; i < count; i += 1) {
      unexpectedPlaceholders.push(placeholder);
    }
  }

  return {
    sourcePlaceholders,
    translatedPlaceholders,
    missingPlaceholders,
    unexpectedPlaceholders,
    ok: missingPlaceholders.length === 0 && unexpectedPlaceholders.length === 0,
  };
}

export function assertTranslationPlaceholders(args: {
  sourceText: string;
  translatedText: string;
  policy: TranslationPlaceholderPolicy;
  providerVersion: TranslationProviderVersion;
  itemKey: string;
}): void {
  const result = validateTranslationPlaceholders(
    args.sourceText,
    args.translatedText,
    args.policy,
  );
  if (result.ok) return;
  throw new TranslationPlaceholderValidationError({
    providerVersion: args.providerVersion,
    itemKey: args.itemKey,
    sourcePlaceholders: result.sourcePlaceholders,
    translatedPlaceholders: result.translatedPlaceholders,
    missingPlaceholders: result.missingPlaceholders,
    unexpectedPlaceholders: result.unexpectedPlaceholders,
  });
}
