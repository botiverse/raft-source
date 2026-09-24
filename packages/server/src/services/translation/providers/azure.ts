import { z } from "zod";
import { assertTranslationPlaceholders } from "../placeholderValidator.js";
import type { TranslationPlaceholderPolicy } from "../placeholderPolicy.js";
import type {
  TranslationBatchItem,
  TranslationBatchResult,
  TranslationProvider,
  TranslationProviderVersion,
  TranslationResultItem,
} from "../types.js";
import { translationBatchResultSchema, translationBatchItemSchema } from "../types.js";
import { TranslationProviderError } from "../errors.js";

const DEFAULT_AZURE_TRANSLATOR_API_VERSION = "3.0";
const DEFAULT_AZURE_TRANSLATOR_POLICY_VERSION = "azure-translator-v2";

const AZURE_LANGUAGE_ALIASES: Record<string, string> = {
  "zh-cn": "zh-Hans",
  "zh-sg": "zh-Hans",
  "zh-hans": "zh-Hans",
  "zh-tw": "zh-Hant",
  "zh-hk": "zh-Hant",
  "zh-mo": "zh-Hant",
  "zh-hant": "zh-Hant",
};

const azureTranslationResponseSchema = z.array(z.object({
  detectedLanguage: z.object({
    language: z.string().trim().min(1),
    score: z.number().optional(),
  }).optional(),
  translations: z.array(z.object({
    text: z.string(),
    to: z.string().trim().min(1),
  })).min(1),
}));

export type AzureTranslatorFetch = (
  input: string | URL,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface AzureTranslationProviderOptions {
  endpoint: string;
  apiKey: string;
  region?: string;
  apiVersion?: string;
  policyVersion?: string;
  timeoutMs?: number;
  fetchImpl?: AzureTranslatorFetch;
  placeholderPolicy?: TranslationPlaceholderPolicy;
}

function normalizeAzureEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function classifyAzureHttpDisposition(status: number): "transient" | "content_driven" {
  if (status === 429 || status >= 500) return "transient";
  return "content_driven";
}

function collectSourceLanguage(
  items: readonly TranslationBatchItem[],
  providerVersion: TranslationProviderVersion,
): string | null {
  const languages = new Set(
    items
      .map((item) => item.sourceLanguage?.trim())
      .filter((language): language is string => Boolean(language)),
  );
  if (languages.size === 0) return null;
  if (languages.size > 1) {
    throw new TranslationProviderError({
      providerVersion,
      code: "mixed_source_language_batch",
      message: "Azure batch translation requires a single source language per batch",
      disposition: "content_driven",
    });
  }
  return [...languages][0] ?? null;
}

function normalizeAzureTargetLanguage(language: string): string {
  const trimmed = language.trim();
  return AZURE_LANGUAGE_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function normalizeAzureSourceLanguage(language: string): string | null {
  const trimmed = language.trim();
  // Our local detector only emits broad Chinese "zh" and cannot distinguish
  // script. Let Azure detect the source instead of sending an invalid/ambiguous
  // `from=zh` parameter.
  if (trimmed.toLowerCase() === "zh") return null;
  return normalizeAzureTargetLanguage(trimmed);
}

function pickAzureTranslation(
  entry: z.infer<typeof azureTranslationResponseSchema>[number],
  targetLanguage: string,
): string {
  const normalizedTarget = targetLanguage.toLowerCase();
  return entry.translations.find((translation) => translation.to.toLowerCase() === normalizedTarget)?.text
    ?? entry.translations[0]?.text
    ?? "";
}

export class AzureTranslationProvider implements TranslationProvider {
  readonly providerVersion: TranslationProviderVersion;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly region: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: AzureTranslatorFetch;
  private readonly placeholderPolicy?: TranslationPlaceholderPolicy;

  constructor(options: AzureTranslationProviderOptions) {
    this.endpoint = normalizeAzureEndpoint(options.endpoint);
    this.apiKey = options.apiKey;
    this.region = options.region?.trim() || null;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.placeholderPolicy = options.placeholderPolicy;
    this.providerVersion = {
      provider: "azure-translator",
      apiVersion: options.apiVersion?.trim() || DEFAULT_AZURE_TRANSLATOR_API_VERSION,
      policyVersion: options.policyVersion?.trim() || DEFAULT_AZURE_TRANSLATOR_POLICY_VERSION,
    };
  }

  async translateBatch(
    items: readonly TranslationBatchItem[],
    targetLanguage: string,
  ): Promise<TranslationBatchResult> {
    const parsedItems = items.map((item) => translationBatchItemSchema.parse(item));
    const requestedTargetLanguage = targetLanguage.trim();
    if (!requestedTargetLanguage) {
      throw new TranslationProviderError({
        providerVersion: this.providerVersion,
        code: "invalid_target_language",
        message: "targetLanguage must be non-empty",
        disposition: "content_driven",
      });
    }
    const azureTargetLanguage = normalizeAzureTargetLanguage(requestedTargetLanguage);

    const url = new URL(`${this.endpoint}/translate`);
    url.searchParams.set("api-version", this.providerVersion.apiVersion);
    url.searchParams.set("to", azureTargetLanguage);

    const sourceLanguage = collectSourceLanguage(parsedItems, this.providerVersion);
    const azureSourceLanguage = sourceLanguage ? normalizeAzureSourceLanguage(sourceLanguage) : null;
    if (azureSourceLanguage) {
      url.searchParams.set("from", azureSourceLanguage);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Ocp-Apim-Subscription-Key": this.apiKey,
          ...(this.region ? { "Ocp-Apim-Subscription-Region": this.region } : {}),
        },
        body: JSON.stringify(parsedItems.map((item) => ({ text: item.sourceText }))),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new TranslationProviderError({
          providerVersion: this.providerVersion,
          code: "azure_http_error",
          message: `Azure translator returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
          disposition: classifyAzureHttpDisposition(response.status),
        });
      }

      const payload = azureTranslationResponseSchema.parse(await response.json());
      if (payload.length !== parsedItems.length) {
        throw new TranslationProviderError({
          providerVersion: this.providerVersion,
          code: "azure_response_length_mismatch",
          message: `Azure translator returned ${payload.length} rows for ${parsedItems.length} requested items`,
          disposition: "transient",
        });
      }

      const translatedItems: TranslationResultItem[] = parsedItems.map((item, index) => {
        const translatedText = pickAzureTranslation(payload[index], azureTargetLanguage);
        if (this.placeholderPolicy) {
          assertTranslationPlaceholders({
            sourceText: item.sourceText,
            translatedText,
            policy: this.placeholderPolicy,
            providerVersion: this.providerVersion,
            itemKey: item.key,
          });
        }
        return {
          key: item.key,
          sourceText: item.sourceText,
          translatedText,
          targetLanguage: requestedTargetLanguage,
          ...(item.sourceLanguage ? { sourceLanguage: item.sourceLanguage } : {}),
          ...(payload[index]?.detectedLanguage?.language
            ? { detectedSourceLanguage: payload[index].detectedLanguage.language }
            : {}),
        };
      });

      return translationBatchResultSchema.parse({
        providerVersion: this.providerVersion,
        items: translatedItems,
      });
    } catch (error) {
      if (error instanceof TranslationProviderError) {
        throw error;
      }
      throw new TranslationProviderError({
        providerVersion: this.providerVersion,
        code: "azure_transport_error",
        message: "Azure translator request failed",
        disposition: "transient",
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
