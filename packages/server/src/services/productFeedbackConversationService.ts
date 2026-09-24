import { createHmac, timingSafeEqual } from "node:crypto";
import { clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TICKET_KINDS = new Set(["feedback", "bug", "crash"]);
const TICKET_STATUSES = new Set(["open", "in_progress", "resolved", "closed"]);
const CLOSURE_REASONS = new Set([
  "completed",
  "no_longer_needed",
  "not_planned",
  "cannot_reproduce",
  "duplicate",
]);
const AUTHOR_TYPES = new Set(["reporter", "staff", "system"]);
const CURSOR_MAX_BYTES = 4_096;
const HANDS_CURSOR_MAX_BYTES = 2_048;
const CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const CURSOR_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const REPORTER_SESSION_SCOPES = ["feedback:comment", "feedback:read"] as const;
const REPORTER_SESSION_TOKEN_MAX_BYTES = 4_096;
const REPORTER_SESSION_RESPONSE_MAX_BYTES = 8_192;
const REPORTER_SESSION_MAX_LIFETIME_MS = 60_000;
const REPORTER_SESSION_EXPIRY_MARGIN_MS = 5_000;
const REPORTER_SESSION_CACHE_MAX_ENTRIES = 10_000;
export const PRODUCT_FEEDBACK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

type OperationClass = "read" | "comment" | "attachment";
type BreakerFailure = "integration" | "service";

export type ProductFeedbackTicket = {
  id: string;
  kind: "feedback" | "bug" | "crash";
  status: "open" | "in_progress" | "resolved" | "closed";
  closure_reason: "completed" | "no_longer_needed" | "not_planned"
    | "cannot_reproduce" | "duplicate" | null;
  duplicate_of_ticket_id: string | null;
  message: string;
  version_name: string | null;
  channel: string | null;
  created_at: number;
  updated_at: number;
  attachment_count: number;
  comment_count: number;
  latest_comment_at: number | null;
  unread: boolean;
  unread_count: number;
};

export type ProductFeedbackComment = {
  id: string;
  author_type: "reporter" | "staff" | "system";
  body: string;
  created_at: number;
};

export type ProductFeedbackAttachmentMetadata = {
  id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  created_at: number;
};

export type ProductFeedbackList = {
  tickets: ProductFeedbackTicket[];
  next_cursor: string | null;
  unread_total: number;
};

export type ProductFeedbackDetail = {
  ticket: ProductFeedbackTicket;
  comments: ProductFeedbackComment[];
  next_comment_cursor: string | null;
  attachments: ProductFeedbackAttachmentMetadata[];
  unread_total: number;
};

export type ProductFeedbackConversationFailureStage =
  | "unclassified"
  | "configuration"
  | "breaker_open"
  | "reporter_session_transport"
  | "reporter_session_response"
  | "reporter_session_receipt"
  | "reporter_session_capacity"
  | "upstream_transport"
  | "upstream_response"
  | "close_receipt";

export type ProductFeedbackConversationDiagnostic = {
  stage: ProductFeedbackConversationFailureStage;
  upstreamStatus: number | null;
  breakerFailures: number | null;
  breakerOpen: boolean | null;
};

function conversationDiagnostic(
  stage: ProductFeedbackConversationFailureStage,
  options: Partial<Omit<ProductFeedbackConversationDiagnostic, "stage">> = {},
): ProductFeedbackConversationDiagnostic {
  return {
    stage,
    upstreamStatus: options.upstreamStatus ?? null,
    breakerFailures: options.breakerFailures ?? null,
    breakerOpen: options.breakerOpen ?? null,
  };
}

export class ProductFeedbackConversationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: "feedback_invalid" | "feedback_not_found"
      | "feedback_comment_conflict" | "feedback_rate_limited"
      | "feedback_integration_unavailable" | "feedback_service_unavailable",
    public readonly retryAfterSeconds: number | null = null,
    public readonly diagnostic: ProductFeedbackConversationDiagnostic = conversationDiagnostic("unclassified"),
  ) {
    super(code);
    this.name = "ProductFeedbackConversationError";
  }
}

export function productFeedbackConversationFailureLog(
  operation: "close",
  error: ProductFeedbackConversationError,
): Record<string, string | number | boolean | null> {
  return {
    operation,
    code: error.code,
    failure_stage: error.diagnostic.stage,
    upstream_status: error.diagnostic.upstreamStatus,
    breaker_failures: error.diagnostic.breakerFailures,
    breaker_open: error.diagnostic.breakerOpen,
  };
}

type Config = {
  baseUrl: string;
  appId: string;
  appToken: string;
  credentialRevision: string;
  reporterIntegrationId: string | null;
  reporterSessionEnabled: boolean;
  cursorKey: string;
};

function readConfig(env: NodeJS.ProcessEnv): Config {
  const baseUrl = env.HANDS_FEEDBACK_BASE_URL?.trim();
  const appId = env.HANDS_FEEDBACK_APP_ID?.trim();
  const appToken = env.HANDS_FEEDBACK_CONVERSATION_APP_TOKEN?.trim();
  const credentialRevision = env.HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION?.trim();
  const reporterIntegrationId = env.HANDS_FEEDBACK_REPORTER_INTEGRATION_ID?.trim() || null;
  const reporterSessionEnabled = env.HANDS_FEEDBACK_CONVERSATION_SESSION_ENABLED === "true";
  const cursorKey = env.HANDS_FEEDBACK_CURSOR_SECRET?.trim();
  if (
    !baseUrl || !appId || !appToken || !credentialRevision || !cursorKey || !isCanonicalUuid(appId)
    || (reporterSessionEnabled && (!reporterIntegrationId || !isCanonicalUuid(reporterIntegrationId)))
  ) {
    throw new ProductFeedbackConversationError(
      503,
      "feedback_integration_unavailable",
      null,
      conversationDiagnostic("configuration"),
    );
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    appId,
    appToken,
    credentialRevision,
    reporterIntegrationId,
    reporterSessionEnabled,
    cursorKey,
  };
}

export function isProductFeedbackConversationConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    readConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function isCanonicalUuid(value: string): boolean {
  return FULL_UUID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEpochMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseTicket(value: unknown): ProductFeedbackTicket | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" || !isCanonicalUuid(value.id)
    || typeof value.kind !== "string" || !TICKET_KINDS.has(value.kind)
    || typeof value.status !== "string" || !TICKET_STATUSES.has(value.status)
    || !(value.closure_reason === null
      || (typeof value.closure_reason === "string" && CLOSURE_REASONS.has(value.closure_reason)))
    || !(value.duplicate_of_ticket_id === null
      || (typeof value.duplicate_of_ticket_id === "string"
        && isCanonicalUuid(value.duplicate_of_ticket_id)))
    || (value.status !== "closed"
      && (value.closure_reason !== null || value.duplicate_of_ticket_id !== null))
    || (value.closure_reason !== "duplicate" && value.duplicate_of_ticket_id !== null)
    || typeof value.message !== "string"
    || !(typeof value.version_name === "string" || value.version_name === null)
    || !(typeof value.channel === "string" || value.channel === null)
    || !isEpochMs(value.created_at) || !isEpochMs(value.updated_at)
    || !isCount(value.attachment_count) || !isCount(value.comment_count)
    || !(value.latest_comment_at === null || isEpochMs(value.latest_comment_at))
    || typeof value.unread !== "boolean" || !isCount(value.unread_count)
    || value.unread !== (value.unread_count > 0)
  ) return null;
  return {
    id: value.id,
    kind: value.kind as ProductFeedbackTicket["kind"],
    status: value.status as ProductFeedbackTicket["status"],
    closure_reason: value.closure_reason as ProductFeedbackTicket["closure_reason"],
    duplicate_of_ticket_id: value.duplicate_of_ticket_id,
    message: value.message,
    version_name: value.version_name,
    channel: value.channel,
    created_at: value.created_at,
    updated_at: value.updated_at,
    attachment_count: value.attachment_count,
    comment_count: value.comment_count,
    latest_comment_at: value.latest_comment_at,
    unread: value.unread,
    unread_count: value.unread_count,
  };
}

function parseComment(value: unknown): ProductFeedbackComment | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" || !isCanonicalUuid(value.id)
    || typeof value.author_type !== "string" || !AUTHOR_TYPES.has(value.author_type)
    || typeof value.body !== "string"
    || !isEpochMs(value.created_at)
  ) return null;
  return {
    id: value.id,
    author_type: value.author_type as ProductFeedbackComment["author_type"],
    body: value.body,
    created_at: value.created_at,
  };
}

function parseAttachment(value: unknown): ProductFeedbackAttachmentMetadata | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" || !isCanonicalUuid(value.id)
    || typeof value.filename !== "string" || !value.filename
    || !(typeof value.content_type === "string" || value.content_type === null)
    || !isCount(value.size_bytes) || !isEpochMs(value.created_at)
  ) return null;
  return {
    id: value.id,
    filename: safeProductFeedbackFilename(value.filename),
    content_type: value.content_type,
    size_bytes: value.size_bytes,
    created_at: value.created_at,
  };
}

type CursorRoute = "ticket_list" | "ticket_comments";
type CursorPayload = {
  v: 1;
  route: CursorRoute;
  user_binding: string;
  ticket_id: string | null;
  hands_cursor: string;
  issued_at_ms: number;
};

// RFC 8785 for this closed payload subset: JSON primitives plus objects whose
// keys are lexicographically sorted by UTF-16 code units.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite canonical JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("unsupported canonical JSON value");
}

function userBinding(userId: string, cursorKey: string): string {
  return createHmac("sha256", cursorKey)
    .update(`feedback-cursor-user:${userId}`, "utf8")
    .digest("base64url");
}

export function encodeProductFeedbackCursor(
  input: { route: CursorRoute; userId: string; ticketId: string | null; handsCursor: string; issuedAtMs?: number },
  cursorKey: string,
): string {
  if (!input.handsCursor || Buffer.byteLength(input.handsCursor, "utf8") > HANDS_CURSOR_MAX_BYTES) {
    throw new ProductFeedbackConversationError(400, "feedback_invalid");
  }
  const payload: CursorPayload = {
    v: 1,
    route: input.route,
    user_binding: userBinding(input.userId, cursorKey),
    ticket_id: input.ticketId,
    hands_cursor: input.handsCursor,
    issued_at_ms: input.issuedAtMs ?? currentTimeMs(),
  };
  const bytes = canonicalJson(payload);
  const token = `${Buffer.from(bytes).toString("base64url")}.${createHmac("sha256", cursorKey).update(bytes).digest("base64url")}`;
  if (Buffer.byteLength(token, "utf8") > CURSOR_MAX_BYTES) {
    throw new ProductFeedbackConversationError(400, "feedback_invalid");
  }
  return token;
}

export function decodeProductFeedbackCursor(
  token: string,
  expected: { route: CursorRoute; userId: string; ticketId: string | null; nowMs?: number },
  cursorKey: string,
): string {
  try {
    if (!token || Buffer.byteLength(token, "utf8") > CURSOR_MAX_BYTES) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 2) throw new Error();
    const [payloadSegment, macSegment] = parts as [string, string];
    if (!/^[A-Za-z0-9_-]+$/.test(payloadSegment) || !/^[A-Za-z0-9_-]+$/.test(macSegment)) throw new Error();
    const bytes = Buffer.from(payloadSegment, "base64url");
    const supplied = Buffer.from(macSegment, "base64url");
    if (bytes.toString("base64url") !== payloadSegment || supplied.toString("base64url") !== macSegment) throw new Error();
    const expectedMac = createHmac("sha256", cursorKey).update(bytes).digest();
    if (supplied.length !== expectedMac.length || !timingSafeEqual(supplied, expectedMac)) throw new Error();
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!isRecord(value) || canonicalJson(value) !== bytes.toString("utf8")) throw new Error();
    const expectedKeys = ["hands_cursor", "issued_at_ms", "route", "ticket_id", "user_binding", "v"];
    if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) throw new Error();
    if (
      value.v !== 1 || value.route !== expected.route
      || value.user_binding !== userBinding(expected.userId, cursorKey)
      || value.ticket_id !== expected.ticketId
      || typeof value.hands_cursor !== "string" || !value.hands_cursor
      || Buffer.byteLength(value.hands_cursor, "utf8") > HANDS_CURSOR_MAX_BYTES
      || !isEpochMs(value.issued_at_ms)
    ) throw new Error();
    const now = expected.nowMs ?? currentTimeMs();
    if (value.issued_at_ms > now + CURSOR_FUTURE_SKEW_MS || now - value.issued_at_ms > CURSOR_MAX_AGE_MS) {
      throw new Error();
    }
    return value.hands_cursor;
  } catch {
    throw new ProductFeedbackConversationError(400, "feedback_invalid");
  }
}

type BreakerState = {
  failures: number[];
  openUntil: number;
  halfOpenInFlight: boolean;
  openCode: "feedback_integration_unavailable" | "feedback_service_unavailable";
};
type BreakerSnapshot = {
  failures: number;
  open: boolean;
};
const breakers = new Map<string, BreakerState>();

export function resetProductFeedbackBreakersForTest(): void {
  breakers.clear();
}

function breakerKey(config: Config, operation: OperationClass): string {
  return `${config.appId}:${config.credentialRevision}:${operation}`;
}

function beforeBreaker(config: Config, operation: OperationClass, now: number): void {
  const key = breakerKey(config, operation);
  const state = breakers.get(key);
  if (!state) return;
  if (state.openUntil > now) {
    throw new ProductFeedbackConversationError(
      503,
      state.openCode,
      null,
      conversationDiagnostic("breaker_open", {
        breakerFailures: state.failures.length,
        breakerOpen: true,
      }),
    );
  }
  if (state.openUntil > 0) {
    if (state.halfOpenInFlight) {
      throw new ProductFeedbackConversationError(
        503,
        state.openCode,
        null,
        conversationDiagnostic("breaker_open", {
          breakerFailures: state.failures.length,
          breakerOpen: true,
        }),
      );
    }
    state.halfOpenInFlight = true;
  }
}

function breakerSuccess(config: Config, operation: OperationClass): void {
  breakers.delete(breakerKey(config, operation));
}

function breakerFailure(
  config: Config,
  operation: OperationClass,
  now: number,
  code: "feedback_integration_unavailable" | "feedback_service_unavailable" = "feedback_service_unavailable",
): BreakerSnapshot {
  const key = breakerKey(config, operation);
  const state = breakers.get(key) ?? {
    failures: [], openUntil: 0, halfOpenInFlight: false, openCode: code,
  };
  state.failures = state.failures.filter((time) => now - time <= 60_000);
  state.failures.push(now);
  state.halfOpenInFlight = false;
  if (state.openUntil > 0 || state.failures.length >= 3) {
    state.openUntil = now + 30_000;
    state.openCode = code;
  }
  breakers.set(key, state);
  return {
    failures: state.failures.length,
    open: state.openUntil > now,
  };
}

function withBreakerSnapshot(
  error: ProductFeedbackConversationError,
  snapshot: BreakerSnapshot,
): ProductFeedbackConversationError {
  return new ProductFeedbackConversationError(
    error.status,
    error.code,
    error.retryAfterSeconds,
    {
      ...error.diagnostic,
      breakerFailures: snapshot.failures,
      breakerOpen: snapshot.open,
    },
  );
}

function breakerNonCount(config: Config, operation: OperationClass): void {
  const state = breakers.get(breakerKey(config, operation));
  if (state) state.halfOpenInFlight = false;
}

function normalizeRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  let seconds: number;
  if (/^\d+$/.test(trimmed)) seconds = Number(trimmed);
  else {
    const timestamp = Date.parse(trimmed);
    if (!Number.isFinite(timestamp)) return null;
    seconds = Math.ceil((timestamp - now) / 1_000);
  }
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  return Math.max(1, Math.min(300, seconds));
}

type ReporterSessionCacheEntry = {
  token: string;
  expiresAtMs: number;
  lastAccess: number;
};

type ReporterAuthorization = {
  bearer: string;
  cacheKey: string | null;
  mintServerTiming: string | null;
};

const reporterSessionCache = new Map<string, ReporterSessionCacheEntry>();
const reporterSessionMints = new Map<string, Promise<ReporterAuthorization>>();
let reporterSessionAccessSequence = 0;

export function resetProductFeedbackReporterSessionCacheForTest(): void {
  reporterSessionCache.clear();
  reporterSessionMints.clear();
  reporterSessionAccessSequence = 0;
}

function reporterSessionCacheKey(config: Config, reporterId: string): string {
  return JSON.stringify([
    config.baseUrl,
    config.appId,
    config.credentialRevision,
    config.reporterIntegrationId,
    reporterId,
    REPORTER_SESSION_SCOPES,
  ]);
}

function pruneReporterSessionCache(now: number): void {
  for (const [key, entry] of reporterSessionCache) {
    if (entry.expiresAtMs - REPORTER_SESSION_EXPIRY_MARGIN_MS <= now) {
      reporterSessionCache.delete(key);
    }
  }
  if (reporterSessionCache.size < REPORTER_SESSION_CACHE_MAX_ENTRIES) return;
  const oldest = [...reporterSessionCache.entries()]
    .sort((left, right) => left[1].lastAccess - right[1].lastAccess);
  for (const [key] of oldest) {
    reporterSessionCache.delete(key);
    if (reporterSessionCache.size < REPORTER_SESSION_CACHE_MAX_ENTRIES) break;
  }
}

function reporterSessionMintError(response: Response, now: number): ProductFeedbackConversationError {
  const diagnostic = conversationDiagnostic("reporter_session_response", {
    upstreamStatus: response.status,
  });
  if (response.status === 429) {
    return new ProductFeedbackConversationError(
      429,
      "feedback_rate_limited",
      normalizeRetryAfter(response.headers.get("retry-after"), now),
      diagnostic,
    );
  }
  if ([400, 401, 403, 404].includes(response.status)) {
    return new ProductFeedbackConversationError(
      503,
      "feedback_integration_unavailable",
      null,
      diagnostic,
    );
  }
  return new ProductFeedbackConversationError(503, "feedback_service_unavailable", null, diagnostic);
}

async function readBoundedReporterSessionResponse(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > REPORTER_SESSION_RESPONSE_MAX_BYTES)
  ) {
    throw new ProductFeedbackConversationError(
      503,
      "feedback_service_unavailable",
      null,
      conversationDiagnostic("reporter_session_receipt", { upstreamStatus: response.status }),
    );
  }
  if (!response.body) {
    throw new ProductFeedbackConversationError(
      503,
      "feedback_service_unavailable",
      null,
      conversationDiagnostic("reporter_session_receipt", { upstreamStatus: response.status }),
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > REPORTER_SESSION_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new ProductFeedbackConversationError(
          503,
          "feedback_service_unavailable",
          null,
          conversationDiagnostic("reporter_session_receipt", { upstreamStatus: response.status }),
        );
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof ProductFeedbackConversationError) throw error;
    throw new ProductFeedbackConversationError(
      503,
      "feedback_service_unavailable",
      null,
      conversationDiagnostic("reporter_session_transport", { upstreamStatus: response.status }),
    );
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString("utf8"));
  } catch {
    throw new ProductFeedbackConversationError(
      503,
      "feedback_service_unavailable",
      null,
      conversationDiagnostic("reporter_session_receipt", { upstreamStatus: response.status }),
    );
  }
}

async function mintReporterSession(input: {
  config: Config;
  reporterId: string;
  fetchImpl: typeof fetch;
  now: () => number;
  signal?: AbortSignal;
  cacheKey: string;
}): Promise<ReporterAuthorization> {
  let response: Response;
  try {
    response = await input.fetchImpl(
      `${input.config.baseUrl}/api/apps/${encodeURIComponent(input.config.appId)}/reporter-feedback/session`,
      {
        method: "POST",
        signal: input.signal,
        headers: {
          Authorization: `Bearer ${input.config.appToken}`,
          "Content-Type": "application/json",
          "X-Hands-Reporter-Id": input.reporterId,
        },
        body: JSON.stringify({ scopes: REPORTER_SESSION_SCOPES }),
      },
    );
  } catch {
    throw new ProductFeedbackConversationError(
      503,
      "feedback_service_unavailable",
      null,
      conversationDiagnostic("reporter_session_transport"),
    );
  }
  const now = input.now();
  if (!response.ok) throw reporterSessionMintError(response, now);
  if (response.status !== 201) {
    throw new ProductFeedbackConversationError(
      503,
      "feedback_service_unavailable",
      null,
      conversationDiagnostic("reporter_session_response", { upstreamStatus: response.status }),
    );
  }
  const value = await readBoundedReporterSessionResponse(response);
  const expectedKeys = ["expires_at", "reporter_integration_id", "scopes", "session_token"];
  if (
    !isRecord(value)
    || Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")
    || typeof value.session_token !== "string"
    || !value.session_token.startsWith("hrps_v1_")
    || Buffer.byteLength(value.session_token, "utf8") > REPORTER_SESSION_TOKEN_MAX_BYTES
    || !Number.isSafeInteger(value.expires_at)
    || Number(value.expires_at) < 0
    || value.reporter_integration_id !== input.config.reporterIntegrationId
    || !Array.isArray(value.scopes)
    || value.scopes.length !== REPORTER_SESSION_SCOPES.length
    || value.scopes.some((scope, index) => scope !== REPORTER_SESSION_SCOPES[index])
  ) {
    throw new ProductFeedbackConversationError(
      503,
      "feedback_service_unavailable",
      null,
      conversationDiagnostic("reporter_session_receipt", { upstreamStatus: response.status }),
    );
  }
  const expiresAtMs = Number(value.expires_at) * 1_000;
  if (
    !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs - REPORTER_SESSION_EXPIRY_MARGIN_MS <= now
    || expiresAtMs - now > REPORTER_SESSION_MAX_LIFETIME_MS + REPORTER_SESSION_EXPIRY_MARGIN_MS
  ) {
    throw new ProductFeedbackConversationError(
      503,
      "feedback_service_unavailable",
      null,
      conversationDiagnostic("reporter_session_receipt", { upstreamStatus: response.status }),
    );
  }
  reporterSessionCache.set(input.cacheKey, {
    token: value.session_token,
    expiresAtMs,
    lastAccess: ++reporterSessionAccessSequence,
  });
  return {
    bearer: value.session_token,
    cacheKey: input.cacheKey,
    mintServerTiming: response.headers.get("server-timing"),
  };
}

async function reporterAuthorization(input: {
  config: Config;
  reporterId: string;
  fetchImpl: typeof fetch;
  now: () => number;
  signal?: AbortSignal;
}): Promise<ReporterAuthorization> {
  if (!input.config.reporterSessionEnabled) {
    return { bearer: input.config.appToken, cacheKey: null, mintServerTiming: null };
  }
  const now = input.now();
  pruneReporterSessionCache(now);
  const cacheKey = reporterSessionCacheKey(input.config, input.reporterId);
  const cached = reporterSessionCache.get(cacheKey);
  if (cached && cached.expiresAtMs - REPORTER_SESSION_EXPIRY_MARGIN_MS > now) {
    cached.lastAccess = ++reporterSessionAccessSequence;
    return { bearer: cached.token, cacheKey, mintServerTiming: null };
  }
  reporterSessionCache.delete(cacheKey);
  const inFlight = reporterSessionMints.get(cacheKey);
  if (inFlight) return inFlight;
  if (reporterSessionMints.size >= REPORTER_SESSION_CACHE_MAX_ENTRIES) {
    throw new ProductFeedbackConversationError(
      503,
      "feedback_service_unavailable",
      null,
      conversationDiagnostic("reporter_session_capacity"),
    );
  }
  const mint = mintReporterSession({ ...input, cacheKey });
  reporterSessionMints.set(cacheKey, mint);
  try {
    return await mint;
  } finally {
    if (reporterSessionMints.get(cacheKey) === mint) reporterSessionMints.delete(cacheKey);
  }
}

function combineHandsServerTiming(...values: Array<string | null>): string | null {
  const present = values.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return present.length > 0 ? present.join(", ") : null;
}

async function handsRequest(
  path: string,
  input: {
    config: Config;
    reporterId: string;
    operation: OperationClass;
    init?: RequestInit;
    fetchImpl?: typeof fetch;
    now?: () => number;
    signal?: AbortSignal;
    onUpstreamServerTiming?: (value: string | null) => void;
  },
): Promise<Response> {
  const nowValue = input.now?.() ?? currentTimeMs();
  const now = input.now ?? (() => currentTimeMs());
  beforeBreaker(input.config, input.operation, nowValue);
  let authorization: ReporterAuthorization;
  try {
    authorization = await reporterAuthorization({
      config: input.config,
      reporterId: input.reporterId,
      fetchImpl: input.fetchImpl ?? globalThis.fetch,
      now,
      signal: input.signal ?? input.init?.signal ?? undefined,
    });
  } catch (error) {
    if (error instanceof ProductFeedbackConversationError) {
      if (error.code === "feedback_rate_limited") {
        breakerNonCount(input.config, input.operation);
        throw error;
      } else {
        const snapshot = breakerFailure(
          input.config,
          input.operation,
          now(),
          error.code === "feedback_integration_unavailable"
            ? "feedback_integration_unavailable"
            : "feedback_service_unavailable",
        );
        throw withBreakerSnapshot(error, snapshot);
      }
    }
    const snapshot = breakerFailure(input.config, input.operation, now());
    throw new ProductFeedbackConversationError(
      503,
      "feedback_service_unavailable",
      null,
      conversationDiagnostic("reporter_session_transport", {
        breakerFailures: snapshot.failures,
        breakerOpen: snapshot.open,
      }),
    );
  }
  let response: Response;
  try {
    response = await (input.fetchImpl ?? globalThis.fetch)(`${input.config.baseUrl}${path}`, {
      ...input.init,
      signal: input.signal ?? input.init?.signal,
      headers: {
        Authorization: `Bearer ${authorization.bearer}`,
        "X-Hands-Reporter-Id": input.reporterId,
        ...input.init?.headers,
      },
    });
  } catch {
    const snapshot = breakerFailure(input.config, input.operation, input.now?.() ?? currentTimeMs());
    throw new ProductFeedbackConversationError(
      503,
      "feedback_service_unavailable",
      null,
      conversationDiagnostic("upstream_transport", {
        breakerFailures: snapshot.failures,
        breakerOpen: snapshot.open,
      }),
    );
  }
  input.onUpstreamServerTiming?.(combineHandsServerTiming(
    authorization.mintServerTiming,
    response.headers.get("server-timing"),
  ));
  if (response.ok) return response;
  if (response.status === 400) {
    breakerNonCount(input.config, input.operation);
    throw new ProductFeedbackConversationError(400, "feedback_invalid");
  }
  if (response.status === 404) {
    breakerNonCount(input.config, input.operation);
    throw new ProductFeedbackConversationError(404, "feedback_not_found");
  }
  if (response.status === 409) {
    breakerNonCount(input.config, input.operation);
    throw new ProductFeedbackConversationError(409, "feedback_comment_conflict");
  }
  if (response.status === 429) {
    breakerNonCount(input.config, input.operation);
    throw new ProductFeedbackConversationError(
      429,
      "feedback_rate_limited",
      normalizeRetryAfter(response.headers.get("retry-after"), input.now?.() ?? currentTimeMs()),
    );
  }
  const failure: BreakerFailure = response.status === 401 || response.status === 403 ? "integration" : "service";
  if (failure === "integration" && authorization.cacheKey) {
    reporterSessionCache.delete(authorization.cacheKey);
  }
  const code = failure === "integration"
    ? "feedback_integration_unavailable"
    : "feedback_service_unavailable";
  const snapshot = breakerFailure(
    input.config,
    input.operation,
    input.now?.() ?? currentTimeMs(),
    code,
  );
  throw new ProductFeedbackConversationError(
    503,
    code,
    null,
    conversationDiagnostic("upstream_response", {
      upstreamStatus: response.status,
      breakerFailures: snapshot.failures,
      breakerOpen: snapshot.open,
    }),
  );
}

function queryPath(config: Config, suffix: string): string {
  return `/api/apps/${encodeURIComponent(config.appId)}/reporter-feedback${suffix}`;
}

export async function listProductFeedbackTickets(input: {
  userId: string;
  reporterId: string;
  limit: number;
  cursor?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onUpstreamServerTiming?: (value: string | null) => void;
}): Promise<ProductFeedbackList> {
  const config = readConfig(input.env ?? process.env);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw new ProductFeedbackConversationError(400, "feedback_invalid");
  }
  const handsCursor = input.cursor
    ? decodeProductFeedbackCursor(input.cursor, { route: "ticket_list", userId: input.userId, ticketId: null, nowMs: input.now?.() }, config.cursorKey)
    : null;
  const params = new URLSearchParams({ limit: String(input.limit) });
  if (handsCursor) params.set("cursor", handsCursor);
  const response = await handsRequest(queryPath(config, `?${params}`), {
    config,
    reporterId: input.reporterId,
    operation: "read",
    fetchImpl: input.fetchImpl,
    now: input.now,
    onUpstreamServerTiming: input.onUpstreamServerTiming,
  });
  const value = await response.json().catch(() => null);
  if (
    !isRecord(value) || !Array.isArray(value.tickets)
    || !(typeof value.next_cursor === "string" || value.next_cursor === null)
    || !isCount(value.unread_total)
  ) {
    breakerFailure(config, "read", input.now?.() ?? currentTimeMs());
    throw new ProductFeedbackConversationError(503, "feedback_service_unavailable");
  }
  const tickets = value.tickets.map(parseTicket);
  if (tickets.some((ticket) => ticket === null)) {
    breakerFailure(config, "read", input.now?.() ?? currentTimeMs());
    throw new ProductFeedbackConversationError(503, "feedback_service_unavailable");
  }
  const nextCursor = value.next_cursor
    ? encodeProductFeedbackCursor({ route: "ticket_list", userId: input.userId, ticketId: null, handsCursor: value.next_cursor, issuedAtMs: input.now?.() }, config.cursorKey)
    : null;
  breakerSuccess(config, "read");
  return {
    tickets: tickets as ProductFeedbackTicket[],
    next_cursor: nextCursor,
    unread_total: value.unread_total,
  };
}

export async function getProductFeedbackTicket(input: {
  userId: string;
  reporterId: string;
  ticketId: string;
  commentLimit: number;
  commentCursor?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onUpstreamServerTiming?: (value: string | null) => void;
}): Promise<ProductFeedbackDetail> {
  if (!isCanonicalUuid(input.ticketId)) throw new ProductFeedbackConversationError(404, "feedback_not_found");
  const config = readConfig(input.env ?? process.env);
  if (!Number.isInteger(input.commentLimit) || input.commentLimit < 1 || input.commentLimit > 100) {
    throw new ProductFeedbackConversationError(400, "feedback_invalid");
  }
  const handsCursor = input.commentCursor
    ? decodeProductFeedbackCursor(input.commentCursor, {
      route: "ticket_comments", userId: input.userId, ticketId: input.ticketId, nowMs: input.now?.(),
    }, config.cursorKey)
    : null;
  const params = new URLSearchParams({ comment_limit: String(input.commentLimit) });
  if (handsCursor) params.set("comment_cursor", handsCursor);
  const response = await handsRequest(queryPath(config, `/${input.ticketId}?${params}`), {
    config, reporterId: input.reporterId, operation: "read", fetchImpl: input.fetchImpl, now: input.now,
    onUpstreamServerTiming: input.onUpstreamServerTiming,
  });
  const value = await response.json().catch(() => null);
  if (
    !isRecord(value) || !Array.isArray(value.comments) || !Array.isArray(value.attachments)
    || !(typeof value.next_comment_cursor === "string" || value.next_comment_cursor === null)
    || !isCount(value.unread_total)
  ) {
    breakerFailure(config, "read", input.now?.() ?? currentTimeMs());
    throw new ProductFeedbackConversationError(503, "feedback_service_unavailable");
  }
  const ticket = parseTicket(value.ticket);
  const comments = value.comments.map(parseComment);
  const attachments = value.attachments.map(parseAttachment);
  if (!ticket || comments.some((comment) => !comment) || attachments.some((attachment) => !attachment)) {
    breakerFailure(config, "read", input.now?.() ?? currentTimeMs());
    throw new ProductFeedbackConversationError(503, "feedback_service_unavailable");
  }
  const nextCursor = value.next_comment_cursor
    ? encodeProductFeedbackCursor({
      route: "ticket_comments", userId: input.userId, ticketId: input.ticketId,
      handsCursor: value.next_comment_cursor, issuedAtMs: input.now?.(),
    }, config.cursorKey)
    : null;
  breakerSuccess(config, "read");
  return {
    ticket,
    comments: comments as ProductFeedbackComment[],
    next_comment_cursor: nextCursor,
    attachments: attachments as ProductFeedbackAttachmentMetadata[],
    unread_total: value.unread_total,
  };
}

export type ProductFeedbackCommentAttachment = {
  buffer: Buffer;
  filename: string;
  contentType: string;
};

export async function commentOnProductFeedbackTicket(input: {
  reporterId: string;
  ticketId: string;
  body: string;
  submissionId: string;
  attachments?: ProductFeedbackCommentAttachment[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<{ status: 200 | 201; comment: ProductFeedbackComment }> {
  if (!isCanonicalUuid(input.ticketId)) throw new ProductFeedbackConversationError(404, "feedback_not_found");
  if (!isCanonicalUuid(input.submissionId)) throw new ProductFeedbackConversationError(400, "feedback_invalid");
  const body = input.body.trim();
  if (!body || [...body].length > 10_000) throw new ProductFeedbackConversationError(400, "feedback_invalid");
  const config = readConfig(input.env ?? process.env);
  const attachments = input.attachments ?? [];
  if (attachments.length > 3 || attachments.some((attachment) => (
    attachment.buffer.byteLength > PRODUCT_FEEDBACK_ATTACHMENT_MAX_BYTES
    || !SAFE_CONTENT_TYPES.has(attachment.contentType.toLowerCase())
  ))) {
    throw new ProductFeedbackConversationError(400, "feedback_invalid");
  }
  const form = new FormData();
  form.set("body", body);
  form.set("submission_id", input.submissionId);
  for (const attachment of attachments) {
    form.append(
      "attachments",
      new Blob([Uint8Array.from(attachment.buffer)], {
        type: attachment.contentType.toLowerCase(),
      }),
      attachment.filename,
    );
  }
  const response = await handsRequest(queryPath(config, `/${input.ticketId}/comments`), {
    config,
    reporterId: input.reporterId,
    operation: "comment",
    fetchImpl: input.fetchImpl,
    now: input.now,
    init: {
      method: "POST",
      body: form,
    },
  });
  const value = await response.json().catch(() => null);
  if (
    !isRecord(value)
    || typeof value.id !== "string" || !isCanonicalUuid(value.id)
    || value.ticket_id !== input.ticketId
    || !isEpochMs(value.created_at)
    || typeof value.idempotent_replay !== "boolean"
    || (response.status !== 200 && response.status !== 201)
    || (response.status === 200 && value.idempotent_replay !== true)
    || (response.status === 201 && value.idempotent_replay !== false)
  ) {
    breakerFailure(config, "comment", input.now?.() ?? currentTimeMs());
    throw new ProductFeedbackConversationError(503, "feedback_service_unavailable");
  }
  breakerSuccess(config, "comment");
  return {
    status: response.status,
    comment: {
      id: value.id,
      author_type: "reporter",
      body,
      created_at: value.created_at,
    },
  };
}

export async function closeProductFeedbackTicket(input: {
  reporterId: string;
  ticketId: string;
  reason: "completed" | "no_longer_needed";
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<{
  status: "closed";
  closure_reason: "completed" | "no_longer_needed";
  duplicate_of_ticket_id: null;
  updated_at: number | null;
  changed: boolean;
}> {
  if (!isCanonicalUuid(input.ticketId)) {
    throw new ProductFeedbackConversationError(404, "feedback_not_found");
  }
  const config = readConfig(input.env ?? process.env);
  const response = await handsRequest(queryPath(config, `/${input.ticketId}/close`), {
    config,
    reporterId: input.reporterId,
    operation: "comment",
    fetchImpl: input.fetchImpl,
    now: input.now,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: input.reason }),
    },
  });
  const value = await response.json().catch(() => null);
  if (
    !isRecord(value)
    || Object.keys(value).sort().join("\0") !== [
      "changed",
      "closure_reason",
      "duplicate_of_ticket_id",
      "id",
      "status",
      "updated_at",
    ].join("\0")
    || value.id !== input.ticketId
    || value.status !== "closed"
    || value.closure_reason !== input.reason
    || value.duplicate_of_ticket_id !== null
    || typeof value.changed !== "boolean"
    || !(value.updated_at === null || isEpochMs(value.updated_at))
    || (value.changed !== (value.updated_at !== null))
  ) {
    const snapshot = breakerFailure(config, "comment", input.now?.() ?? currentTimeMs());
    throw new ProductFeedbackConversationError(
      503,
      "feedback_service_unavailable",
      null,
      conversationDiagnostic("close_receipt", {
        upstreamStatus: response.status,
        breakerFailures: snapshot.failures,
        breakerOpen: snapshot.open,
      }),
    );
  }
  breakerSuccess(config, "comment");
  return {
    status: "closed",
    closure_reason: input.reason,
    duplicate_of_ticket_id: null,
    updated_at: value.updated_at,
    changed: value.changed,
  };
}

function validContentType(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\r\n]*"))*$/.test(value);
}

const SAFE_CONTENT_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export function safeProductFeedbackContentType(value: string | null): string {
  if (!value || /[\r\n\x00-\x1f\x7f]/.test(value) || !validContentType(value)) {
    throw new ProductFeedbackConversationError(503, "feedback_service_unavailable");
  }
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  return SAFE_CONTENT_TYPES.has(mediaType) ? mediaType : "application/octet-stream";
}

export function safeProductFeedbackFilename(value: string): string {
  const cleaned = [...value]
    .filter((char) => !/[\u0000-\u001f\u007f/\\]/u.test(char))
    .slice(0, 120)
    .join("")
    .trim()
    || "attachment";
  return cleaned;
}

export async function getProductFeedbackAttachment(input: {
  userId: string;
  reporterId: string;
  ticketId: string;
  attachmentId: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<{
  response: Response;
  metadata: ProductFeedbackAttachmentMetadata;
  contentType: string;
  filename: string;
  abort: () => void;
}> {
  if (!isCanonicalUuid(input.ticketId) || !isCanonicalUuid(input.attachmentId)) {
    throw new ProductFeedbackConversationError(404, "feedback_not_found");
  }
  const config = readConfig(input.env ?? process.env);
  const controller = new AbortController();
  const headersTimer = setClockTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await handsRequest(queryPath(config, `/${input.ticketId}/attachments/${input.attachmentId}`), {
      config, reporterId: input.reporterId, operation: "attachment", fetchImpl: input.fetchImpl,
      now: input.now, signal: controller.signal,
    });
  } finally {
    clearClockTimeout(headersTimer);
  }
  const lengthValue = response.headers.get("content-length");
  const length = lengthValue && /^\d+$/.test(lengthValue) ? Number(lengthValue) : Number.NaN;
  if (!Number.isSafeInteger(length) || length > PRODUCT_FEEDBACK_ATTACHMENT_MAX_BYTES) {
    controller.abort();
    breakerFailure(config, "attachment", input.now?.() ?? currentTimeMs());
    throw new ProductFeedbackConversationError(503, "feedback_service_unavailable");
  }
  if (!response.body) {
    controller.abort();
    breakerFailure(config, "attachment", input.now?.() ?? currentTimeMs());
    throw new ProductFeedbackConversationError(503, "feedback_service_unavailable");
  }
  let contentType: string;
  try {
    contentType = safeProductFeedbackContentType(response.headers.get("content-type"));
  } catch (error) {
    controller.abort();
    breakerFailure(config, "attachment", input.now?.() ?? currentTimeMs());
    throw error;
  }
  const disposition = response.headers.get("content-disposition");
  const filenameMatch = disposition?.match(/^attachment;\s*filename="([^"\r\n]*)"$/i);
  if (!filenameMatch?.[1]) {
    controller.abort();
    breakerFailure(config, "attachment", input.now?.() ?? currentTimeMs());
    throw new ProductFeedbackConversationError(503, "feedback_service_unavailable");
  }
  const filename = safeProductFeedbackFilename(filenameMatch[1]);
  const metadata: ProductFeedbackAttachmentMetadata = {
    id: input.attachmentId,
    filename,
    content_type: response.headers.get("content-type"),
    size_bytes: length,
    created_at: 0,
  };
  const bodyTimer = setClockTimeout(() => controller.abort(), 60_000);
  breakerSuccess(config, "attachment");
  return {
    response,
    metadata,
    contentType,
    filename,
    abort: () => {
      clearClockTimeout(bodyTimer);
      controller.abort();
    },
  };
}
