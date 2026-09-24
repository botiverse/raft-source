import type { TranslationProviderVersion } from "./types.js";

export type TranslationFailureDisposition = "transient" | "content_driven";

export class TranslationProviderError extends Error {
  readonly providerVersion: TranslationProviderVersion;
  readonly code: string;
  readonly disposition: TranslationFailureDisposition;
  readonly cause?: unknown;

  constructor(args: {
    providerVersion: TranslationProviderVersion;
    code: string;
    message: string;
    disposition: TranslationFailureDisposition;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = "TranslationProviderError";
    this.providerVersion = args.providerVersion;
    this.code = args.code;
    this.disposition = args.disposition;
    this.cause = args.cause;
  }
}

export class TranslationPlaceholderValidationError extends TranslationProviderError {
  readonly sourcePlaceholders: readonly string[];
  readonly translatedPlaceholders: readonly string[];
  readonly missingPlaceholders: readonly string[];
  readonly unexpectedPlaceholders: readonly string[];
  readonly itemKey: string;

  constructor(args: {
    providerVersion: TranslationProviderVersion;
    itemKey: string;
    sourcePlaceholders: readonly string[];
    translatedPlaceholders: readonly string[];
    missingPlaceholders: readonly string[];
    unexpectedPlaceholders: readonly string[];
  }) {
    const missing = args.missingPlaceholders.join(", ") || "none";
    const unexpected = args.unexpectedPlaceholders.join(", ") || "none";
    super({
      providerVersion: args.providerVersion,
      code: "placeholder_validation_failed",
      message: `Placeholder validation failed for item ${args.itemKey} (missing: ${missing}; unexpected: ${unexpected})`,
      disposition: "content_driven",
    });
    this.name = "TranslationPlaceholderValidationError";
    this.itemKey = args.itemKey;
    this.sourcePlaceholders = args.sourcePlaceholders;
    this.translatedPlaceholders = args.translatedPlaceholders;
    this.missingPlaceholders = args.missingPlaceholders;
    this.unexpectedPlaceholders = args.unexpectedPlaceholders;
  }
}
