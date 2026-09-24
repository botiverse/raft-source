import jwt from "jsonwebtoken";
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

const DEFAULT_GOOGLE_TRANSLATE_API_VERSION = "v3";
const DEFAULT_GOOGLE_TRANSLATE_POLICY_VERSION = "google-cloud-translate-v1";
const DEFAULT_GOOGLE_TRANSLATE_ENDPOINT = "https://translate.googleapis.com";
const DEFAULT_GOOGLE_TRANSLATE_LOCATION = "global";
const GOOGLE_TRANSLATE_SCOPE = "https://www.googleapis.com/auth/cloud-translation";
const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const GOOGLE_LANGUAGE_ALIASES: Record<string, string> = {
  "zh-cn": "zh-CN",
  "zh-sg": "zh-CN",
  "zh-hans": "zh-CN",
  "zh-tw": "zh-TW",
  "zh-hk": "zh-TW",
  "zh-mo": "zh-TW",
  "zh-hant": "zh-TW",
  "pt-br": "pt-BR",
};

const googleTranslationResponseSchema = z.object({
  translations: z.array(z.object({
    translatedText: z.string(),
    detectedLanguageCode: z.string().trim().min(1).optional(),
  })),
});

const googleTokenResponseSchema = z.object({
  access_token: z.string().trim().min(1),
  expires_in: z.number().positive().optional(),
  token_type: z.string().optional(),
});

export type GoogleTranslatorFetch = (
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

export interface GoogleServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
}

export interface GoogleTranslationProviderOptions {
  projectId: string;
  location?: string;
  endpoint?: string;
  accessToken?: string;
  serviceAccount?: GoogleServiceAccountCredentials;
  quotaProjectId?: string;
  tokenEndpoint?: string;
  apiVersion?: string;
  policyVersion?: string;
  timeoutMs?: number;
  fetchImpl?: GoogleTranslatorFetch;
  placeholderPolicy?: TranslationPlaceholderPolicy;
  now?: () => Date;
}

function normalizeGoogleEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function normalizeGoogleLanguage(language: string): string {
  const trimmed = language.trim();
  return GOOGLE_LANGUAGE_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

function normalizeGoogleSourceLanguage(language: string): string | null {
  const trimmed = language.trim();
  // Local detection only emits broad Chinese `zh`; let Google detect script.
  if (trimmed.toLowerCase() === "zh") return null;
  return normalizeGoogleLanguage(trimmed);
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
      message: "Google Cloud Translation requires a single source language per batch",
      disposition: "content_driven",
    });
  }
  return [...languages][0] ?? null;
}

function classifyGoogleHttpDisposition(status: number): "transient" | "content_driven" {
  if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) return "transient";
  return "content_driven";
}

export function parseGoogleServiceAccountJson(value: string): GoogleServiceAccountCredentials {
  const trimmed = value.trim();
  const decoded = trimmed.startsWith("{")
    ? trimmed
    : Buffer.from(trimmed, "base64").toString("utf8");
  const parsed = z.object({
    client_email: z.string().trim().min(1),
    private_key: z.string().trim().min(1),
  }).parse(JSON.parse(decoded));
  return {
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
  };
}

export class GoogleTranslationProvider implements TranslationProvider {
  readonly providerVersion: TranslationProviderVersion;
  private readonly projectId: string;
  private readonly location: string;
  private readonly endpoint: string;
  private readonly accessToken: string | null;
  private readonly serviceAccount: GoogleServiceAccountCredentials | null;
  private readonly quotaProjectId: string;
  private readonly tokenEndpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: GoogleTranslatorFetch;
  private readonly placeholderPolicy?: TranslationPlaceholderPolicy;
  private readonly now: () => Date;
  private cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

  constructor(options: GoogleTranslationProviderOptions) {
    this.projectId = options.projectId.trim();
    this.location = options.location?.trim() || DEFAULT_GOOGLE_TRANSLATE_LOCATION;
    this.endpoint = normalizeGoogleEndpoint(options.endpoint?.trim() || DEFAULT_GOOGLE_TRANSLATE_ENDPOINT);
    this.accessToken = options.accessToken?.trim() || null;
    this.serviceAccount = options.serviceAccount ?? null;
    this.quotaProjectId = options.quotaProjectId?.trim() || this.projectId;
    this.tokenEndpoint = options.tokenEndpoint?.trim() || GOOGLE_OAUTH_TOKEN_ENDPOINT;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.placeholderPolicy = options.placeholderPolicy;
    this.now = options.now ?? (() => new Date());
    this.providerVersion = {
      provider: "google-cloud-translate",
      apiVersion: options.apiVersion?.trim() || DEFAULT_GOOGLE_TRANSLATE_API_VERSION,
      policyVersion: options.policyVersion?.trim() || DEFAULT_GOOGLE_TRANSLATE_POLICY_VERSION,
    };

    if (!this.projectId) {
      throw new Error("Google Cloud Translation projectId must be non-empty");
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;

    const nowMs = this.now().getTime();
    if (this.cachedAccessToken && this.cachedAccessToken.expiresAtMs - nowMs > 60_000) {
      return this.cachedAccessToken.token;
    }
    if (!this.serviceAccount) {
      throw new TranslationProviderError({
        providerVersion: this.providerVersion,
        code: "google_auth_not_configured",
        message: "Google Cloud Translation provider requires an access token or service account",
        disposition: "transient",
      });
    }

    const issuedAt = Math.floor(nowMs / 1000);
    const assertion = jwt.sign({
      iss: this.serviceAccount.clientEmail,
      scope: GOOGLE_TRANSLATE_SCOPE,
      aud: this.tokenEndpoint,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }, this.serviceAccount.privateKey, { algorithm: "RS256" });

    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new TranslationProviderError({
        providerVersion: this.providerVersion,
        code: "google_token_http_error",
        message: `Google OAuth token endpoint returned HTTP ${response.status}${responseBody ? `: ${responseBody.slice(0, 200)}` : ""}`,
        disposition: classifyGoogleHttpDisposition(response.status),
      });
    }

    const payload = googleTokenResponseSchema.parse(await response.json());
    this.cachedAccessToken = {
      token: payload.access_token,
      expiresAtMs: nowMs + Math.max(1, payload.expires_in ?? 3600) * 1000,
    };
    return payload.access_token;
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
    const googleTargetLanguage = normalizeGoogleLanguage(requestedTargetLanguage);
    const sourceLanguage = collectSourceLanguage(parsedItems, this.providerVersion);
    const googleSourceLanguage = sourceLanguage ? normalizeGoogleSourceLanguage(sourceLanguage) : null;

    const url = new URL(`${this.endpoint}/${this.providerVersion.apiVersion}/projects/${encodeURIComponent(this.projectId)}/locations/${encodeURIComponent(this.location)}:translateText`);
    const body = {
      contents: parsedItems.map((item) => item.sourceText),
      mimeType: "text/plain",
      targetLanguageCode: googleTargetLanguage,
      ...(googleSourceLanguage ? { sourceLanguageCode: googleSourceLanguage } : {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    try {
      const accessToken = await this.getAccessToken();
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
          "x-goog-user-project": this.quotaProjectId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseBody = await response.text().catch(() => "");
        throw new TranslationProviderError({
          providerVersion: this.providerVersion,
          code: "google_http_error",
          message: `Google Cloud Translation returned HTTP ${response.status}${responseBody ? `: ${responseBody.slice(0, 200)}` : ""}`,
          disposition: classifyGoogleHttpDisposition(response.status),
        });
      }

      const payload = googleTranslationResponseSchema.parse(await response.json());
      if (payload.translations.length !== parsedItems.length) {
        throw new TranslationProviderError({
          providerVersion: this.providerVersion,
          code: "google_response_length_mismatch",
          message: `Google Cloud Translation returned ${payload.translations.length} rows for ${parsedItems.length} requested items`,
          disposition: "transient",
        });
      }

      const translatedItems: TranslationResultItem[] = parsedItems.map((item, index) => {
        const translatedText = payload.translations[index]?.translatedText ?? "";
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
          ...(payload.translations[index]?.detectedLanguageCode
            ? { detectedSourceLanguage: payload.translations[index].detectedLanguageCode }
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
        code: "google_transport_error",
        message: "Google Cloud Translation request failed",
        disposition: "transient",
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
