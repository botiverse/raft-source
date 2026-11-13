import { createHash, timingSafeEqual } from "node:crypto";
import { currentTimeMs } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { integrationSecretCommitments } from "../db/schema";
import { getBoundedRedis } from "../redis";
import { isPrivacyModeOn } from "../config/privacyMode";
import { addTraceEvent, withTraceChildSpan } from "../tracing/semanticTrace";
import { handsTraceHeaders } from "./handsTraceHeaders";
import { productFeedbackReporterId } from "./productFeedbackService";
import {
  feedbackRouteTuple,
  mintProductFeedbackRouteSubject,
  ProductFeedbackRouteSubjectError,
} from "./productFeedbackRouteSubject";

const COMMITMENT_LABEL = "hands-feedback-route-subject:v1";
// The per-source apps share their own root (productFeedbackApps), committed
// under a separate label so it never collides with the legacy root.
const MULTI_COMMITMENT_LABEL = "hands-feedback-route-subject:multi:v1";
const CACHE_MAX = 10_000;
// A binding is reused for 30 minutes. The web unread poll lists tickets every
// minute per tab, and each list first ensures the binding, so 5 minutes made
// every active reporter re-bind with Hands every 5 minutes (#triage:#111).
// There is no unbind or rebind path in this server (Hands only offers the
// PUT), and anything that moves a binding changes its cache key instead: the
// key holds the credential revision, the subject key id, the root commitment,
// the app id, the reporter integration id and the reporter id (which is derived
// from the reporter-id secret). A Hands 401 or 403 on a later call drops the
// entry at once (forgetProductFeedbackRouteBinding), so a binding Hands no
// longer honours (e.g. a token rotated without a revision bump) is not reused.
const CACHE_TTL_MS = 30 * 60_000;
// Hands answers a route-subject PUT in well under a second. Without an explicit
// bound a stalled connect waited for undici's 10s connect timeout, which is what
// reporters saw right after each deploy (Eric, 2026-10-15).
const HANDS_REQUEST_TIMEOUT_MS = 4_000;
const HANDS_RETRY_DELAY_MS = 250;
// Circuit breaker on the Hands host, the same shape as the conversation
// service's (productFeedbackConversationService): at least 3 transient failures
// within a minute, and no fewer failures than successes in that minute, open it
// for 30s, then one trial call decides. While it is open a binding fails at once
// instead of holding a request for the 4s timeout. A slow Hands saw ~1,350
// timeouts in minutes on 2026-10-23, each also retried. The success share keeps
// a fresh task's first minute from opening it: every active reporter binds at
// once, and a few of those hundreds of calls time out while the rest succeed
// (v1.21.32 deploy: 10 timeouts opened it and 28 bindings were refused; AndyLok).
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 30_000;
const BREAKER_MAX_SAMPLES = 1_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ProductFeedbackRouteBindingError extends Error {
  /**
   * Fixed operator-log code (a status number at most); never a value.
   * `upstreamCode` is Hands' own error code from a non-2xx body, when it sent
   * one that passes `readHandsErrorCode` (e.g. REPORTER_BACKEND_UNAVAILABLE).
   */
  constructor(readonly reason: string = "unknown", readonly upstreamCode: string | null = null) {
    super("feedback integration unavailable");
    this.name = "ProductFeedbackRouteBindingError";
  }
}

const HANDS_ERROR_BODY_MAX_BYTES = 4_096;
const HANDS_ERROR_BODY_MAX_MS = 1_000;
const HANDS_ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;

/**
 * Hands' error code from a non-2xx response body (`{"code": "..."}`), or null.
 * Reads at most 4 KiB for at most 1 s (a stalled error body must not hold the
 * failure) and keeps only an identifier-shaped code, never other body text, so
 * a failure line can tell a classified Hands 503 from an unhandled 500.
 */
export async function readHandsErrorCode(response: Response, maxMs: number = HANDS_ERROR_BODY_MAX_MS): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const timer = setTimeout(() => { void reader.cancel().catch(() => undefined); }, maxMs);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < HANDS_ERROR_BODY_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    const bytes = new Uint8Array(Math.min(size, HANDS_ERROR_BODY_MAX_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.byteLength, bytes.byteLength - offset);
      bytes.set(chunk.subarray(0, take), offset);
      offset += take;
      if (offset >= bytes.byteLength) break;
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { code?: unknown } | null;
    const code = parsed && typeof parsed === "object" ? parsed.code : undefined;
    return typeof code === "string" && HANDS_ERROR_CODE_RE.test(code) ? code : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type ProductFeedbackRouteConfig = {
  baseUrl: string;
  appId: string;
  appToken: string;
  credentialRevision: string;
  reporterIntegrationId: string;
  keyId: "v1";
  root: string;
  commitmentLabel: string;
  reporterIdSecret: string;
};

const successes = new Map<string, number>();

/**
 * Bindings made by any task, shared through Redis for the same 30 minutes.
 * The in-process cache alone made every new task (a deploy replaces all of
 * them) re-bind every active reporter with Hands in its first minute: those
 * calls queued for seconds on the fresh task before reaching Hands, timed
 * out at 4s, and the timeouts opened the breaker for 30s (v1.21.45 deploy,
 * 2026-11-02: 26 timeouts and 46 `circuit_open` refusals on 7 new tasks,
 * #botiverse-raft-deployment:b3f8dae6). Best effort: Redis down or slow
 * means asking Hands, as before. The key is a hash of the cache key (no
 * reporter id in Redis).
 */
export type SharedRouteBindingStore = {
  /** Remaining lifetime in ms of a binding another task made, or null. */
  remainingMs(key: string): Promise<number | null>;
  remember(key: string, ttlMs: number): Promise<void>;
  forget(key: string): Promise<void>;
};
const SHARED_STORE_DEADLINE_MS = 200;
const sharedKey = (key: string) => `pf:route-binding:v1:${createHash("sha256").update(key).digest("base64url")}`;
const redisSharedStore: SharedRouteBindingStore = {
  async remainingMs(key) {
    const redis = getBoundedRedis(SHARED_STORE_DEADLINE_MS);
    if (!redis) return null;
    const ttl = await redis.pttl(sharedKey(key));
    return ttl > 0 ? ttl : null;
  },
  async remember(key, ttlMs) {
    await getBoundedRedis(SHARED_STORE_DEADLINE_MS)?.set(sharedKey(key), "1", "PX", ttlMs);
  },
  async forget(key) {
    await getBoundedRedis(SHARED_STORE_DEADLINE_MS)?.del(sharedKey(key));
  },
};
let sharedStore: SharedRouteBindingStore = redisSharedStore;
export function setSharedRouteBindingStoreForTest(store: SharedRouteBindingStore | null): void {
  sharedStore = store ?? redisSharedStore;
}
async function sharedBest<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}
// A fresh task starts with an empty success cache, so every active reporter's
// first request after a deploy binds at once. Concurrent bindings of the same
// tuple share one Hands call.
const inFlight = new Map<string, Promise<void>>();
// The root commitment never changes once written (rotating the root is a
// separate, explicit procedure), so one successful check per process is enough;
// re-checking wrote and read the database on every feedback request.
const verifiedCommitments = new Set<string>();

type HandsBreaker = { failures: number[]; successes: number[]; openUntil: number; halfOpenInFlight: boolean };
const handsBreakers = new Map<string, HandsBreaker>();

export function resetProductFeedbackRouteBindingCacheForTest(): void {
  successes.clear();
  inFlight.clear();
  verifiedCommitments.clear();
  handsBreakers.clear();
}

export function readProductFeedbackRouteConfig(env: NodeJS.ProcessEnv = process.env): ProductFeedbackRouteConfig {
  const baseUrl = env.HANDS_FEEDBACK_BASE_URL?.trim();
  const appId = env.HANDS_FEEDBACK_APP_ID?.trim();
  const appToken = env.HANDS_FEEDBACK_CONVERSATION_APP_TOKEN?.trim();
  const credentialRevision = env.HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION?.trim();
  const reporterIntegrationId = env.HANDS_FEEDBACK_REPORTER_INTEGRATION_ID?.trim();
  const keyId = env.HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID?.trim();
  const root = env.HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT?.trim();
  const reporterIdSecret = env.HANDS_FEEDBACK_REPORTER_ID_SECRET?.trim();
  const commitmentLabel = env.HANDS_FEEDBACK_ROUTE_SUBJECT_COMMITMENT_SCOPE === "multi"
    ? MULTI_COMMITMENT_LABEL
    : COMMITMENT_LABEL;
  if (
    isPrivacyModeOn()
    || !baseUrl || !appId || !appToken || !credentialRevision || !reporterIntegrationId
    || keyId !== "v1" || !root || !reporterIdSecret
    || !UUID_RE.test(appId)
    || (!UUID_RE.test(reporterIntegrationId) && reporterIntegrationId !== `legacy-feedback:${appId}`)
  ) throw new ProductFeedbackRouteBindingError("config_invalid");
  try {
    const decoded = Buffer.from(root, "base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(root) || decoded.length !== 32 || decoded.toString("base64url") !== root) throw new Error();
  } catch {
    throw new ProductFeedbackRouteBindingError("root_invalid");
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""), appId, appToken, credentialRevision,
    reporterIntegrationId, keyId, root, commitmentLabel, reporterIdSecret,
  };
}

export function isProductFeedbackRouteConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    readProductFeedbackRouteConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function productFeedbackRouteRootCommitment(root: string, label: string = COMMITMENT_LABEL): Buffer {
  return createHash("sha256").update(feedbackRouteTuple(label, Buffer.from(root, "base64url"))).digest();
}

export async function assertProductFeedbackRouteRootCommitment(
  config: ProductFeedbackRouteConfig,
  executor: DatabaseExecutor = getDb(),
): Promise<Buffer> {
  const commitment = productFeedbackRouteRootCommitment(config.root, config.commitmentLabel);
  await executor.insert(integrationSecretCommitments).values({
    label: config.commitmentLabel,
    commitment,
  }).onConflictDoNothing();
  const [row] = await executor.select({ commitment: integrationSecretCommitments.commitment })
    .from(integrationSecretCommitments)
    .where(eq(integrationSecretCommitments.label, config.commitmentLabel));
  if (!row || row.commitment.length !== commitment.length || !timingSafeEqual(row.commitment, commitment)) {
    throw new ProductFeedbackRouteBindingError("root_commitment_mismatch");
  }
  return commitment;
}

function routeBindingCacheKey(config: ProductFeedbackRouteConfig, commitment: Buffer, reporterId: string): string {
  return feedbackRouteTuple(
    config.credentialRevision, config.keyId, commitment, config.appId,
    config.reporterIntegrationId, reporterId,
  ).toString("base64url");
}

/** Whether a Hands answer status means Hands no longer accepts this reporter's credentials or binding. */
export function isHandsAuthRejectionStatus(status: number | null | undefined): boolean {
  return status === 401 || status === 403;
}

/**
 * Drop this reporter's cached binding, so the next request PUTs the route
 * subject again. Called when Hands answers a later call with 401 or 403. Same
 * key as ensureProductFeedbackRouteBinding (the commitment is a pure hash of
 * the root, equal to the verified one). A missing or invalid configuration has
 * nothing cached, so it is a no-op; it never throws.
 */
export function forgetProductFeedbackRouteBinding(input: {
  env?: NodeJS.ProcessEnv;
  /** The reporter id the binding was made for; derived from userId when absent. */
  reporterId?: string;
  userId?: string;
}): void {
  try {
    const config = readProductFeedbackRouteConfig(input.env);
    const reporterId = input.reporterId
      ?? (UUID_RE.test(input.userId ?? "") ? productFeedbackReporterId(input.userId!, config.reporterIdSecret) : null);
    if (!reporterId) return;
    const commitment = productFeedbackRouteRootCommitment(config.root, config.commitmentLabel);
    const key = routeBindingCacheKey(config, commitment, reporterId);
    successes.delete(key);
    // Every other task must stop reusing it too, or a binding Hands refused
    // stays in use for up to 30 minutes on all of them.
    void sharedBest(() => sharedStore.forget(key), undefined);
  } catch {
    // Not configured: nothing was cached.
  }
}

function remember(key: string, expiresAt: number): void {
  if (successes.size >= CACHE_MAX && !successes.has(key)) {
    const oldest = successes.keys().next().value as string | undefined;
    if (oldest) successes.delete(oldest);
  }
  successes.delete(key);
  successes.set(key, expiresAt);
}

async function verifiedRootCommitment(
  config: ProductFeedbackRouteConfig,
  executor: DatabaseExecutor | undefined,
): Promise<Buffer> {
  const commitment = productFeedbackRouteRootCommitment(config.root, config.commitmentLabel);
  const key = `${config.commitmentLabel}\0${commitment.toString("hex")}`;
  if (verifiedCommitments.has(key)) return commitment;
  await withTraceChildSpan(
    "server.product_feedback.route_commitment",
    { surface: "server", kind: "internal" },
    async () => {
      try {
        await assertProductFeedbackRouteRootCommitment(config, executor);
      } catch (error) {
        if (error instanceof ProductFeedbackRouteBindingError) throw error;
        throw new ProductFeedbackRouteBindingError("commitment_failed");
      }
    },
    { onError: (error) => ({ reason: handsFailureReason(error) }) },
  );
  verifiedCommitments.add(key);
  return commitment;
}

/** A fixed reason code for a failed Hands call: timeout, an upstream status, or the low-level error code. */
function handsFailureReason(error: unknown): string {
  if (error instanceof ProductFeedbackRouteBindingError) return error.reason;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : undefined;
  const code = typeof cause?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(cause.code) ? cause.code : null;
  return code ? `network_${code}` : "request_failed";
}

/** Hands did not answer: these count toward the breaker. A 4xx or an unexpected body is an answer. */
export function isTransientHandsFailure(reason: string): boolean {
  return reason === "timeout" || reason.startsWith("network_") || reason === "request_failed" || /^hands_status_5\d\d$/.test(reason);
}

/**
 * Worth one immediate retry: a connection that failed fast (a reused socket the
 * deploy closed, a refused connect). Not a timeout of any kind (request or
 * connect) or a 5xx: those mean Hands or the path to it is slow or failing, and
 * a retry doubles the load on it.
 */
function isFastRetryableHandsFailure(reason: string): boolean {
  if (reason.endsWith("TIMEOUT")) return false;
  return reason.startsWith("network_") || reason === "request_failed";
}

/** Throws `circuit_open` while the breaker for this Hands host is open, or a half-open trial is in flight. */
function beforeHandsCall(key: string, now: number): void {
  const state = handsBreakers.get(key);
  if (!state) return;
  if (state.openUntil > now) throw new ProductFeedbackRouteBindingError("circuit_open");
  if (state.openUntil > 0) {
    if (state.halfOpenInFlight) throw new ProductFeedbackRouteBindingError("circuit_open");
    state.halfOpenInFlight = true;
  }
}

/** Times within the breaker window, newest last, at most BREAKER_MAX_SAMPLES of them. */
function recentSamples(samples: number[], now: number): number[] {
  const recent = samples.filter((time) => now - time <= BREAKER_WINDOW_MS);
  return recent.length > BREAKER_MAX_SAMPLES ? recent.slice(-BREAKER_MAX_SAMPLES) : recent;
}

function handsCallSucceeded(key: string, now: number): void {
  const state = handsBreakers.get(key);
  if (!state) {
    handsBreakers.set(key, { failures: [], successes: [now], openUntil: 0, halfOpenInFlight: false });
    return;
  }
  // A successful half-open trial closes the breaker.
  if (state.openUntil > 0) {
    handsBreakers.delete(key);
    return;
  }
  state.failures = recentSamples(state.failures, now);
  state.successes = recentSamples([...state.successes, now], now);
}

function handsCallAnswered(key: string): void {
  const state = handsBreakers.get(key);
  if (state) state.halfOpenInFlight = false;
}

/** Records a transient failure; returns whether the breaker is now open. */
function handsCallFailed(key: string, now: number): boolean {
  const state = handsBreakers.get(key) ?? { failures: [], successes: [], openUntil: 0, halfOpenInFlight: false };
  state.failures = recentSamples([...state.failures, now], now);
  state.successes = recentSamples(state.successes, now);
  state.halfOpenInFlight = false;
  if (
    state.openUntil > 0
    || (state.failures.length >= BREAKER_THRESHOLD && state.failures.length >= state.successes.length)
  ) state.openUntil = now + BREAKER_OPEN_MS;
  handsBreakers.set(key, state);
  return state.openUntil > now;
}

async function putRouteSubjectOnce(
  config: ProductFeedbackRouteConfig,
  reporterId: string,
  subject: string,
  fetchImpl: typeof fetch,
  attempt: number,
): Promise<void> {
  // Child span per Hands call: the reason code (timeout, network_<code>, status)
  // and duration are what the deploy-time 5xx bursts lacked (AndyLok).
  // A breaker refusal is recorded on the same span (reason `circuit_open`), so
  // the fast failures stay countable next to the timeouts that opened it.
  await withTraceChildSpan(
    "server.product_feedback.route_binding",
    { surface: "server", kind: "client", attrs: { attempt, hands_route: ROUTE_SUBJECT_ROUTE } },
    async () => {
      beforeHandsCall(config.baseUrl, currentTimeMs());
      return putRouteSubjectRequest(config, reporterId, subject, fetchImpl);
    },
    {
      onSuccess: (status) => ({ upstream_status: status }),
      onError: (error) => ({
        reason: handsFailureReason(error),
        ...upstreamStatusOf(error),
        ...(error instanceof ProductFeedbackRouteBindingError && error.upstreamCode ? { upstream_code: error.upstreamCode } : {}),
      }),
    },
  );
}

const ROUTE_SUBJECT_ROUTE = "/api/apps/:appId/reporter-feedback/route-subject";

/** `upstream_status` for a failed call that got an answer (hands_status_<code>), like the list span's. */
function upstreamStatusOf(error: unknown): { upstream_status?: number } {
  const match = error instanceof ProductFeedbackRouteBindingError ? /^hands_status_(\d{3})$/.exec(error.reason) : null;
  return match ? { upstream_status: Number(match[1]) } : {};
}

/** The PUT; resolves with Hands' status (200 or 201) for the span. */
async function putRouteSubjectRequest(
  config: ProductFeedbackRouteConfig,
  reporterId: string,
  subject: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  const response = await fetchImpl(
    `${config.baseUrl}/api/apps/${encodeURIComponent(config.appId)}/reporter-feedback/route-subject`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.appToken}`,
        "Content-Type": "application/json",
        "X-Hands-Reporter-Id": reporterId,
        ...handsTraceHeaders(),
      },
      body: JSON.stringify({ route_subject: subject }),
      signal: AbortSignal.timeout(HANDS_REQUEST_TIMEOUT_MS),
    },
  );
  if (response.status !== 200 && response.status !== 201) {
    throw new ProductFeedbackRouteBindingError(`hands_status_${response.status}`, await readHandsErrorCode(response));
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || Object.keys(body).sort().join("\0") !== "changed\0subject_version"
    || typeof body.changed !== "boolean" || body.subject_version !== "v1"
    || (response.status === 201) !== body.changed) throw new ProductFeedbackRouteBindingError("hands_unexpected_body");
  return response.status;
}

/**
 * One Hands PUT behind the breaker. Retried once only when the connection failed
 * fast (network error), never on a timeout or a 5xx, and never once that failure
 * opened the breaker.
 */
async function putRouteSubject(
  config: ProductFeedbackRouteConfig,
  reporterId: string,
  subject: string,
  fetchImpl: typeof fetch,
  retryDelayMs: number = HANDS_RETRY_DELAY_MS,
): Promise<void> {
  const key = config.baseUrl;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await putRouteSubjectOnce(config, reporterId, subject, fetchImpl, attempt);
      handsCallSucceeded(key, currentTimeMs());
      return;
    } catch (error) {
      const reason = handsFailureReason(error);
      const upstreamCode = error instanceof ProductFeedbackRouteBindingError ? error.upstreamCode : null;
      if (reason === "circuit_open") throw new ProductFeedbackRouteBindingError(reason);
      if (!isTransientHandsFailure(reason)) {
        handsCallAnswered(key);
        throw new ProductFeedbackRouteBindingError(reason, upstreamCode);
      }
      const open = handsCallFailed(key, currentTimeMs());
      if (attempt > 1 || open || !isFastRetryableHandsFailure(reason)) throw new ProductFeedbackRouteBindingError(reason, upstreamCode);
    }
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

/**
 * Where a request's binding came from, on its span: whether the Redis copy
 * (#12421) spares new tasks the Hands call after a deploy.
 */
function bindingFrom(source: "memory" | "in_flight" | "shared" | "hands", reporterId: string): { reporterId: string } {
  addTraceEvent("server.product_feedback.route_binding.source", { source });
  return { reporterId };
}

export async function ensureProductFeedbackRouteBinding(input: {
  userId: string;
  reporterId?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  executor?: DatabaseExecutor;
  /** Pause before the single retry; tests pass 0. */
  retryDelayMs?: number;
}): Promise<{ reporterId: string }> {
  try {
    const config = readProductFeedbackRouteConfig(input.env);
    if (!UUID_RE.test(input.userId)) throw new Error();
    const reporterId = input.reporterId ?? productFeedbackReporterId(input.userId, config.reporterIdSecret);
    const commitment = await verifiedRootCommitment(config, input.executor);
    const cacheKey = routeBindingCacheKey(config, commitment, reporterId);
    const now = input.nowMs ?? currentTimeMs();
    if ((successes.get(cacheKey) ?? 0) > now) return bindingFrom("memory", reporterId);
    successes.delete(cacheKey);
    const pending = inFlight.get(cacheKey);
    if (pending) {
      await pending;
      return bindingFrom("in_flight", reporterId);
    }
    const sharedRemaining = await sharedBest(() => sharedStore.remainingMs(cacheKey), null);
    if (sharedRemaining !== null) {
      remember(cacheKey, now + sharedRemaining);
      return bindingFrom("shared", reporterId);
    }
    const subject = mintProductFeedbackRouteSubject({
      root: config.root,
      userId: input.userId,
      coordinate: { appId: config.appId, reporterIntegrationId: config.reporterIntegrationId, reporterId },
    });
    const binding = putRouteSubject(config, reporterId, subject, input.fetchImpl ?? globalThis.fetch, input.retryDelayMs);
    inFlight.set(cacheKey, binding);
    try {
      await binding;
    } finally {
      if (inFlight.get(cacheKey) === binding) inFlight.delete(cacheKey);
    }
    remember(cacheKey, now + CACHE_TTL_MS);
    await sharedBest(() => sharedStore.remember(cacheKey, CACHE_TTL_MS), undefined);
    return bindingFrom("hands", reporterId);
  } catch (error) {
    if (error instanceof ProductFeedbackRouteBindingError) throw error;
    if (error instanceof ProductFeedbackRouteSubjectError) throw new ProductFeedbackRouteBindingError("route_subject_invalid");
    throw new ProductFeedbackRouteBindingError("request_failed");
  }
}
