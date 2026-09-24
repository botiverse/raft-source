import { createHash, createHmac } from "node:crypto";
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
import { translationBatchItemSchema, translationBatchResultSchema } from "../types.js";
import { TranslationProviderError } from "../errors.js";

const DEFAULT_VOLCENGINE_API_VERSION = "2020-06-01";
const DEFAULT_VOLCENGINE_POLICY_VERSION = "volcengine-translate-v1";
const DEFAULT_VOLCENGINE_ENDPOINT = "https://translate.volcengineapi.com";
const DEFAULT_VOLCENGINE_REGION = "cn-north-1";
const VOLCENGINE_TRANSLATE_SERVICE = "translate";
const VOLCENGINE_TRANSLATE_ACTION = "TranslateText";
const VOLCENGINE_MAX_BATCH_ITEMS = 16;
const VOLCENGINE_MAX_BATCH_CHARS = 5_000;

const VOLCENGINE_LANGUAGE_ALIASES: Record<string, string> = {
  "zh-cn": "zh",
  "zh-sg": "zh",
  "zh-hans": "zh",
  "zh-tw": "zh-Hant",
  "zh-hk": "zh-Hant",
  "zh-mo": "zh-Hant",
  "zh-hant": "zh-Hant",
};

const volcengineTranslationResponseSchema = z.object({
  ResponseMetadata: z.object({
    Error: z.object({
      Code: z.string().optional(),
      Message: z.string().optional(),
    }).nullable().optional(),
  }).optional(),
  TranslationList: z.array(z.object({
    Translation: z.string(),
    DetectedSourceLanguage: z.string().optional(),
  })).optional(),
});

export type VolcengineTranslatorFetch = (
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

export interface VolcengineTranslationProviderOptions {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  region?: string;
  apiVersion?: string;
  policyVersion?: string;
  timeoutMs?: number;
  fetchImpl?: VolcengineTranslatorFetch;
  placeholderPolicy?: TranslationPlaceholderPolicy;
  now?: () => Date;
}

function normalizeVolcengineEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function normalizeVolcengineLanguage(language: string): string {
  const trimmed = language.trim();
  return VOLCENGINE_LANGUAGE_ALIASES[trimmed.toLowerCase()] ?? trimmed;
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
      message: "Volcengine batch translation requires a single source language per batch",
      disposition: "content_driven",
    });
  }
  return [...languages][0] ?? null;
}

function classifyVolcengineHttpDisposition(status: number): "transient" | "content_driven" {
  if (status === 408 || status === 429 || status >= 500) return "transient";
  return "content_driven";
}

function classifyVolcengineProviderErrorDisposition(code?: string): "transient" | "content_driven" {
  if (!code) return "content_driven";
  if (/429|5\d\d/.test(code)) return "transient";
  return "content_driven";
}

function hmacHex(key: Buffer | string, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function hmacBuffer(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signVolcengineRequest(input: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  method: "POST";
  path: string;
  query: string;
  body: string;
  host: string;
  timestamp: Date;
}): Record<string, string> {
  const xDate = formatAmzDate(input.timestamp);
  const shortDate = xDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const headersToSign = [
    "content-type:application/json; charset=utf-8",
    `host:${input.host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${xDate}`,
  ].join("\n");
  const canonicalRequest = [
    input.method,
    input.path,
    input.query,
    `${headersToSign}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${shortDate}/${input.region}/${input.service}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const dateKey = hmacBuffer(input.secretAccessKey, shortDate);
  const regionKey = hmacBuffer(dateKey, input.region);
  const serviceKey = hmacBuffer(regionKey, input.service);
  const signingKey = hmacBuffer(serviceKey, "request");
  const signature = hmacHex(signingKey, stringToSign);

  return {
    "content-type": "application/json; charset=utf-8",
    host: input.host,
    "x-content-sha256": payloadHash,
    "x-date": xDate,
    authorization: `HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class VolcengineTranslationProvider implements TranslationProvider {
  readonly providerVersion: TranslationProviderVersion;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly endpoint: string;
  private readonly region: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: VolcengineTranslatorFetch;
  private readonly placeholderPolicy?: TranslationPlaceholderPolicy;
  private readonly now: () => Date;

  constructor(options: VolcengineTranslationProviderOptions) {
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.endpoint = normalizeVolcengineEndpoint(options.endpoint?.trim() || DEFAULT_VOLCENGINE_ENDPOINT);
    this.region = options.region?.trim() || DEFAULT_VOLCENGINE_REGION;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.placeholderPolicy = options.placeholderPolicy;
    this.now = options.now ?? (() => new Date());
    this.providerVersion = {
      provider: "volcengine-translate",
      apiVersion: options.apiVersion?.trim() || DEFAULT_VOLCENGINE_API_VERSION,
      policyVersion: options.policyVersion?.trim() || DEFAULT_VOLCENGINE_POLICY_VERSION,
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
    if (parsedItems.length > VOLCENGINE_MAX_BATCH_ITEMS) {
      throw new TranslationProviderError({
        providerVersion: this.providerVersion,
        code: "volcengine_batch_too_large",
        message: `Volcengine TranslateText supports at most ${VOLCENGINE_MAX_BATCH_ITEMS} texts per request`,
        disposition: "content_driven",
      });
    }
    const requestedChars = parsedItems.reduce((sum, item) => sum + item.sourceText.length, 0);
    if (requestedChars > VOLCENGINE_MAX_BATCH_CHARS) {
      throw new TranslationProviderError({
        providerVersion: this.providerVersion,
        code: "volcengine_batch_too_large",
        message: `Volcengine TranslateText supports at most ${VOLCENGINE_MAX_BATCH_CHARS} characters per request`,
        disposition: "content_driven",
      });
    }

    const body: {
      SourceLanguage?: string;
      TargetLanguage: string;
      TextList: string[];
    } = {
      TargetLanguage: normalizeVolcengineLanguage(requestedTargetLanguage),
      TextList: parsedItems.map((item) => item.sourceText),
    };
    const sourceLanguage = collectSourceLanguage(parsedItems, this.providerVersion);
    if (sourceLanguage) {
      body.SourceLanguage = normalizeVolcengineLanguage(sourceLanguage);
    }
    const bodyJson = JSON.stringify(body);

    const url = new URL(this.endpoint);
    url.searchParams.set("Action", VOLCENGINE_TRANSLATE_ACTION);
    url.searchParams.set("Version", this.providerVersion.apiVersion);
    url.searchParams.sort();
    const query = url.searchParams.toString();
    const path = url.pathname || "/";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: signVolcengineRequest({
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey,
          region: this.region,
          service: VOLCENGINE_TRANSLATE_SERVICE,
          method: "POST",
          path,
          query,
          body: bodyJson,
          host: url.host,
          timestamp: this.now(),
        }),
        body: bodyJson,
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseBody = await response.text().catch(() => "");
        throw new TranslationProviderError({
          providerVersion: this.providerVersion,
          code: "volcengine_http_error",
          message: `Volcengine TranslateText returned HTTP ${response.status}${responseBody ? `: ${responseBody.slice(0, 200)}` : ""}`,
          disposition: classifyVolcengineHttpDisposition(response.status),
        });
      }

      const payload = volcengineTranslationResponseSchema.parse(await response.json());
      const providerError = payload.ResponseMetadata?.Error;
      if (providerError) {
        throw new TranslationProviderError({
          providerVersion: this.providerVersion,
          code: providerError.Code ? `volcengine_${providerError.Code}` : "volcengine_response_error",
          message: providerError.Message || "Volcengine TranslateText returned an error",
          disposition: classifyVolcengineProviderErrorDisposition(providerError.Code),
        });
      }

      const translations = payload.TranslationList ?? [];
      if (translations.length !== parsedItems.length) {
        throw new TranslationProviderError({
          providerVersion: this.providerVersion,
          code: "volcengine_response_length_mismatch",
          message: `Volcengine TranslateText returned ${translations.length} rows for ${parsedItems.length} requested items`,
          disposition: "transient",
        });
      }

      const translatedItems: TranslationResultItem[] = parsedItems.map((item, index) => {
        const translatedText = translations[index]?.Translation ?? "";
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
          ...(translations[index]?.DetectedSourceLanguage
            ? { detectedSourceLanguage: translations[index].DetectedSourceLanguage }
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
        code: "volcengine_transport_error",
        message: "Volcengine TranslateText request failed",
        disposition: "transient",
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
