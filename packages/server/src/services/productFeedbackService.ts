import { createHmac } from "node:crypto";

export type ProductFeedbackKind = "idea" | "problem";

export type ProductFeedbackAttachment = {
  buffer: Buffer;
  filename: string;
  contentType: string;
};

export type ProductFeedbackClientKind = "web" | "ios" | "android";

export type ProductFeedbackMetadata = {
  trustedClientKind?: unknown;
  clientKind?: unknown;
  platform?: unknown;
  clientVersion?: unknown;
  webVersion?: unknown;
  locale?: unknown;
  browser?: unknown;
  osVersion?: unknown;
  viewport?: unknown;
};

export type ProductFeedbackNormalizedMetadata = {
  clientKind: ProductFeedbackClientKind;
  platform: ProductFeedbackClientKind;
  clientVersion?: string;
  webVersion?: string;
  locale?: string;
  browser?: string;
  osVersion?: string;
  viewport?: string;
};

export type ProductFeedbackSubmission = {
  submissionId: string;
  kind: ProductFeedbackKind;
  message: string;
  contact: string | null;
  userId: string;
  metadata: ProductFeedbackNormalizedMetadata;
  attachments: ProductFeedbackAttachment[];
};

export type ProductFeedbackReceipt = {
  id: string;
  status: string;
  reference: string | null;
  attachments: number;
};

export class ProductFeedbackConfigurationError extends Error {
  constructor() {
    super("Hands product feedback is not configured");
    this.name = "ProductFeedbackConfigurationError";
  }
}

export class ProductFeedbackUpstreamError extends Error {
  constructor(
    public readonly upstreamStatus: number | null,
    public readonly retryAfter: string | null = null,
    public readonly upstreamError: string | null = null,
  ) {
    super(upstreamStatus === null
      ? "Hands product feedback request failed"
      : `Hands product feedback returned HTTP ${upstreamStatus}`);
    this.name = "ProductFeedbackUpstreamError";
  }
}

const UPSTREAM_ERROR_BODY_MAX_BYTES = 4 * 1024;
const UPSTREAM_ERROR_MESSAGE_MAX_CHARS = 256;

async function readUpstreamError(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" || !response.body) return null;

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > UPSTREAM_ERROR_BODY_MAX_BYTES) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > UPSTREAM_ERROR_BODY_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const error = (parsed as Record<string, unknown>).error;
    if (typeof error !== "string") return null;
    const normalized = error.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    return normalized ? normalized.slice(0, UPSTREAM_ERROR_MESSAGE_MAX_CHARS) : null;
  } catch {
    return null;
  }
}

export class ProductFeedbackValidationError extends Error {
  constructor() {
    super("Invalid product feedback attribution");
    this.name = "ProductFeedbackValidationError";
  }
}

type ProductFeedbackServiceConfig = {
  baseUrl: string;
  appSlug: string;
  clientKey: string;
  appToken: string;
  reporterIdSecret: string;
};

export function isProductFeedbackConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.HANDS_FEEDBACK_BASE_URL?.trim()
    && env.HANDS_FEEDBACK_APP_SLUG?.trim()
    && env.HANDS_FEEDBACK_CLIENT_KEY?.trim()
    && env.HANDS_FEEDBACK_APP_TOKEN?.trim()
    && env.HANDS_FEEDBACK_REPORTER_ID_SECRET?.trim(),
  );
}

function readConfig(env: NodeJS.ProcessEnv): ProductFeedbackServiceConfig {
  const baseUrl = env.HANDS_FEEDBACK_BASE_URL?.trim();
  const appSlug = env.HANDS_FEEDBACK_APP_SLUG?.trim();
  const clientKey = env.HANDS_FEEDBACK_CLIENT_KEY?.trim();
  const appToken = env.HANDS_FEEDBACK_APP_TOKEN?.trim();
  const reporterIdSecret = env.HANDS_FEEDBACK_REPORTER_ID_SECRET?.trim();
  if (!baseUrl || !appSlug || !clientKey || !appToken || !reporterIdSecret) {
    throw new ProductFeedbackConfigurationError();
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    appSlug,
    clientKey,
    appToken,
    reporterIdSecret,
  };
}

export function productFeedbackReporterId(userId: string, secret: string): string {
  return createHmac("sha256", secret).update(`raft-web-feedback:${userId}`).digest("base64url");
}

function bounded(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function optionalBounded(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ProductFeedbackValidationError();
  return bounded(value, maxLength);
}

function requiredBounded(value: unknown, maxLength: number): string {
  const normalized = optionalBounded(value, maxLength);
  if (!normalized) throw new ProductFeedbackValidationError();
  return normalized;
}

function optionalClientKind(value: unknown): ProductFeedbackClientKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "web" || value === "ios" || value === "android") return value;
  throw new ProductFeedbackValidationError();
}

function disallowWebOnlyNativeFields(input: ProductFeedbackMetadata): void {
  if (input.webVersion !== undefined || input.browser !== undefined || input.viewport !== undefined) {
    throw new ProductFeedbackValidationError();
  }
}

export function normalizeProductFeedbackMetadata(input: ProductFeedbackMetadata): ProductFeedbackNormalizedMetadata {
  const trustedClientKind = optionalClientKind(input.trustedClientKind) ?? "web";
  const clientKind = optionalClientKind(input.clientKind) ?? trustedClientKind;
  if (clientKind !== trustedClientKind) throw new ProductFeedbackValidationError();
  const platform = optionalClientKind(input.platform) ?? clientKind;
  if (platform !== clientKind) throw new ProductFeedbackValidationError();

  const locale = optionalBounded(input.locale, 64);
  const osVersion = optionalBounded(input.osVersion, 256);
  if (clientKind === "web") {
    const webVersion = optionalBounded(input.webVersion, 128);
    return {
      clientKind,
      platform,
      clientVersion: optionalBounded(input.clientVersion, 128) ?? webVersion,
      webVersion,
      locale,
      browser: optionalBounded(input.browser, 512),
      osVersion,
      viewport: optionalBounded(input.viewport, 64),
    };
  }

  disallowWebOnlyNativeFields(input);
  return {
    clientKind,
    platform,
    clientVersion: requiredBounded(input.clientVersion, 128),
    locale,
    osVersion,
  };
}

function buildMetadata(input: ProductFeedbackSubmission): Record<string, unknown> {
  const attribution = input.metadata;
  const metadata: Record<string, unknown> = {
    product_type: attribution.clientKind,
    client_kind: attribution.clientKind,
    platform: attribution.platform,
    surface: "settings.feedback",
    feedback_type: input.kind,
    contact_consent: input.contact !== null,
  };

  if (attribution.clientVersion) metadata.client_version = attribution.clientVersion;
  if (attribution.webVersion) metadata.web_version = attribution.webVersion;
  if (attribution.locale) metadata.locale = attribution.locale;
  if (attribution.browser) metadata.browser = attribution.browser;
  if (attribution.osVersion) metadata.os_version = attribution.osVersion;
  if (attribution.viewport) metadata.viewport = attribution.viewport;
  return metadata;
}

function parseReceipt(value: unknown): ProductFeedbackReceipt | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.status !== "string") return null;
  return {
    id: candidate.id,
    status: candidate.status,
    reference: typeof candidate.reference === "string" && candidate.reference.trim()
      ? candidate.reference.trim()
      : null,
    attachments: typeof candidate.attachments === "number" && Number.isFinite(candidate.attachments)
      ? candidate.attachments
      : 0,
  };
}

export async function submitProductFeedback(
  input: ProductFeedbackSubmission,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    onUpstreamServerTiming?: (value: string | null) => void;
  } = {},
): Promise<ProductFeedbackReceipt> {
  const config = readConfig(options.env ?? process.env);
  const body = new FormData();
  body.set("message", input.message);
  body.set("kind", input.kind === "idea" ? "feedback" : "bug");
  body.set("submission_id", input.submissionId);
  body.set("metadata", JSON.stringify(buildMetadata(input)));
  if (input.contact) body.set("contact", input.contact);
  for (const attachment of input.attachments) {
    body.append(
      "attachments",
      new Blob([Uint8Array.from(attachment.buffer)], { type: attachment.contentType }),
      attachment.filename,
    );
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? globalThis.fetch)(
      `${config.baseUrl}/public/v2/apps/${encodeURIComponent(config.appSlug)}/feedback`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.appToken}`,
          "X-Hands-Client-Key": config.clientKey,
          "X-Hands-Reporter-Id": productFeedbackReporterId(input.userId, config.reporterIdSecret),
        },
        body,
      },
    );
  } catch {
    throw new ProductFeedbackUpstreamError(null);
  }
  options.onUpstreamServerTiming?.(response.headers.get("server-timing"));

  if (!response.ok) {
    throw new ProductFeedbackUpstreamError(
      response.status,
      response.headers.get("retry-after"),
      await readUpstreamError(response),
    );
  }

  const receipt = parseReceipt(await response.json().catch(() => null));
  if (!receipt) throw new ProductFeedbackUpstreamError(502);
  return receipt;
}
