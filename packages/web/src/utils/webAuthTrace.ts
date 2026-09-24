// L4 web auth tracing producer (transport layer).
//
// Contract: rfcs/016-auth-session-contract.md §"Observability Contract".
//
// HARD INVARIANT: tracing is fire-and-forget and failure-isolated. Nothing in
// this module may throw into auth control flow, mutate auth state, block
// refresh/restore, or clear a session. Tracing must never become a logout
// cause. Every exported entry point swallows its own errors; when the receiver
// env is unset (local/dev) the producer is a no-op (which is itself isolated).
//
// Receiver is a dedicated env (`VITE_WEB_TRACE_URL`) pointing at the
// prod-correct trace-upload worker. It is intentionally NOT shared with the
// feedback export URL/topology.

// NOTE: deliberately does NOT import the shared axios `api` client. Routing the
// attestation call through `api` would pass its 401 response interceptor, which
// runs refresh and can call clearAuthAndRedirect() (logout) on failure — an
// indirect auth-state mutation that would violate failure isolation. We mint
// the attestation with a raw fetch and never trigger refresh/logout.
// Only type-only imports here (erased at runtime). This module has ZERO static
// app-module imports — serverId comes via a sync getter registered by serverStore
// (setAuthTraceServerIdGetter). Otherwise webAuthTrace -> serverStore ->
// api/client -> auth policy -> webAuthTrace would be a runtime import cycle, and
// the only sync way to read serverId would be an async import inside flush()
// (which would read the token AFTER a clear-session removeItem had run).
import type { AuthVerdict, AuthVerdictSignal } from "./authVerdict";
import type { AuthRestoreState, AuthRestoreEvent } from "./authRestoreMachine";
import type { TraceStatus } from "@botiverse/raft-shared";
import { assertValidDesktopRuntimeEnvironment, RUNTIME_API_BASE } from "../desktopRuntimeEnvironment";

const API_BASE = RUNTIME_API_BASE;

const TRACE_URL_FROM_ENV = (import.meta.env?.VITE_WEB_TRACE_URL as string | undefined)?.replace(/\/+$/, "") || "";
// Mutable to support test-only enablement (see `__resetAuthTraceForTest`). At
// runtime this is set once at module load from the env and never changes. Tests
// flip it deterministically to exercise the transport paths that would
// otherwise no-op under an unset `VITE_WEB_TRACE_URL`.
let TRACE_URL: string = TRACE_URL_FROM_ENV;
let ENABLED: boolean = Boolean(TRACE_URL);
const DEPLOYMENT_ENV = (import.meta.env?.VITE_DEPLOYMENT_ENV as string | undefined) || "unknown";
const RELEASE_SHA = ((import.meta.env?.VITE_COMMIT_SHA as string | undefined) ?? "").trim() || "unknown";
const APP_VERSION = ((import.meta.env?.VITE_APP_VERSION as string | undefined) ?? "").trim() || "unknown";

const WEB_TRACE_SCOPE = "web-trace-batch:create";
// Stay well under the worker contract ceilings (1000 records / 512KB per batch).
const MAX_BATCH_RECORDS = 100;
const FLUSH_DELAY_MS = 4000;

// --- Auth/web trace names/attrs (never raw secrets; raw boot diagnostics are non-secret only) ---

export type AuthTraceEventName =
  | "slock.auth.boot_init"
  | "slock.auth.restore"
  | "slock.auth.refresh"
  | "slock.auth.verdict"
  | "slock.auth.session_cleared"
  | "slock.auth.cross_tab_sync"
  | "slock.auth.socket_auth"
  | "slock.auth.protected_request";

export type WebAgentActivityTraceEventName =
  | "slock.agent_activity.socket_received"
  | "slock.agent_activity.store_decision"
  | "slock.agent_activity.status_dot_applied";

// RFC 037 I4: domain reducers report one low-cardinality transition summary
// per applied event; the wiring emits it under this name.
export type StateTransitionTraceEventName = "slock.state.transition";

// RFC 040 negative-space family: producer contract breaches observed by the client.
export type StateViolationTraceEventName = "slock.state.violation";

// Client crash/exception family (L5 v0.1) — see utils/clientErrorTrace.ts.
export type ClientErrorTraceEventName = "slock.client_error";

export type UpdateGateTraceEventName = "slock.update_gate.decision";

export type WebHttpClientTraceEventName = "web.http.client";

// Attachment upload capability-probe fallback (task #187). Registered here
// rather than declared locally so the closed union stays the single source of
// truth for what the web may emit — a locally-declared name would type-check
// forever while silently leaving the registry.
export type UploadCapabilityFallbackTraceEventName = "slock.attachment.upload_capability_fallback";

export type WebTraceEventName = AuthTraceEventName | WebAgentActivityTraceEventName | StateTransitionTraceEventName | StateViolationTraceEventName | ClientErrorTraceEventName | UpdateGateTraceEventName | WebHttpClientTraceEventName | UploadCapabilityFallbackTraceEventName;

export type StatusBucket = "auth_401_403" | "server_5xx" | "network_undefined" | "other";

export type LogoutTrigger =
  | "terminal_verdict"
  | "restore_timeout"
  | "explicit_user_logout"
  | "dev_clear_local_state"
  | "unknown";

export type ClearSessionCaller = "clearAuthAndRedirect" | "logout" | "clearLocalState";

// Bounded route grouping for auth traces (NOT a raw path). Covers the phase-2
// emit contexts; additive-only. Producers must map to one of these, never pass
// window.location.pathname.
export type AuthRouteFamily =
  | "bootstrap"
  | "auth_refresh"
  | "auth_me"
  | "protected_request"
  | "socket_auth"
  | "login"
  | "logout"
  | "unknown";

export type CrossTabSyncPhase =
  | "adopt_pair"
  | "adopt_refresh_token"
  | "wait_start"
  | "wait_observed"
  | "wait_timeout";

export type TokenObservation = "none" | "refresh_only" | "token_pair";

export type WaitElapsedBucket =
  | "<100ms"
  | "100-999ms"
  | "1-3s"
  | "3-10s"
  | ">=10s";

export type AuthBootTokenPresenceBucket =
  | "none"
  | "access_only"
  | "refresh_only"
  | "token_pair"
  | "unknown";

export type AuthBootStorageAccessBucket =
  | "readable_writable"
  | "readable_write_error"
  | "read_error"
  | "unavailable";

export type AuthBootBrowserBucket =
  | "safari"
  | "ios_webkit"
  | "chrome"
  | "edge"
  | "firefox"
  | "other"
  | "unknown";

export type AuthBootLastSeenAgeBucket =
  | "<1h"
  | "1-24h"
  | "1-7d"
  | ">=7d"
  | "invalid"
  | "unknown";

// Closed-set: bound to the existing auth oracle/state-machine types so phase-2
// callsites cannot pass arbitrary values.
export type AuthSignalType = AuthVerdictSignal["type"];
export type AuthRestoreEventType = AuthRestoreEvent["type"];

export interface AuthTraceAttrs {
  signalType?: AuthSignalType;
  status?: number | null;
  statusBucket?: StatusBucket;
  hasRefreshToken?: boolean;
  initialized?: boolean;
  restoreState?: AuthRestoreState;
  authVerdict?: AuthVerdict;
  restoreEvent?: AuthRestoreEventType;
  clearSessionCaller?: ClearSessionCaller;
  logoutTrigger?: LogoutTrigger;
  tokenGeneration?: number;
  requestTokenGeneration?: number;
  routeFamily?: AuthRouteFamily;
  crossTabSyncPhase?: CrossTabSyncPhase;
  tokenObservation?: TokenObservation;
  waitElapsedBucket?: WaitElapsedBucket;
  authRefreshAttemptId?: string;
  rotatedTokenRetries?: 0 | 1 | 2 | 3;
  rotatedTokenWaitMs?: number;
  retryIndex?: 0 | 1 | 2 | 3;
  bootTokenPresence?: AuthBootTokenPresenceBucket;
  bootStorageAccess?: AuthBootStorageAccessBucket;
  bootBrowser?: AuthBootBrowserBucket;
  bootLastSeenAge?: AuthBootLastSeenAgeBucket;
  bootUserAgentRaw?: string;
  bootLastSeenAgeMs?: number;
  bootStorageErrorName?: string;
  bootStorageErrorMessage?: string;
}

export interface WebTraceRecord {
  type: "span";
  schema_version: 1;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: WebTraceEventName;
  surface: "web";
  kind: string;
  status: TraceStatus;
  start_time: string;
  end_time: string;
  attrs?: Record<string, unknown>;
}

export interface BuildWebTraceRecordOptions {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string | null;
  kind?: string;
  status?: TraceStatus;
  startTime?: string;
  endTime?: string;
  surface?: "web";
}

/** Map an HTTP-ish status to the contract's bounded statusBucket. */
export function authStatusBucket(status: number | null | undefined): StatusBucket {
  if (status === 401 || status === 403) return "auth_401_403";
  if (typeof status === "number" && status >= 500) return "server_5xx";
  if (status === null || status === undefined) return "network_undefined";
  return "other";
}

const AUTH_BOOT_LAST_SEEN_STORAGE_KEY = "slock_auth_boot_last_seen_at";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function parseAuthBootLastSeenAt(previousSeenAt: string | null): number | null {
  if (!previousSeenAt) return null;
  const previousMs = Number(previousSeenAt);
  if (!Number.isFinite(previousMs) || previousMs <= 0) return null;
  return previousMs;
}

function authBootLastSeenAgeMs(previousSeenAt: string | null, nowMs: number): number | undefined {
  const previousMs = parseAuthBootLastSeenAt(previousSeenAt);
  if (previousMs === null) return undefined;
  const ageMs = nowMs - previousMs;
  if (ageMs < 0) return undefined;
  return Math.trunc(ageMs);
}

function authBootErrorAttrs(error: unknown): Pick<AuthTraceAttrs, "bootStorageErrorName" | "bootStorageErrorMessage"> {
  if (!(error instanceof Error)) return { bootStorageErrorMessage: String(error) };
  return {
    bootStorageErrorName: error.name || undefined,
    bootStorageErrorMessage: error.message || undefined,
  };
}

export function authBootTokenPresenceBucket(
  accessToken: string | null,
  refreshToken: string | null,
): AuthBootTokenPresenceBucket {
  if (accessToken && refreshToken) return "token_pair";
  if (accessToken) return "access_only";
  if (refreshToken) return "refresh_only";
  return "none";
}

export function authBootBrowserBucketFromUserAgent(userAgent: string | null | undefined): AuthBootBrowserBucket {
  const ua = (userAgent ?? "").toLowerCase();
  if (!ua) return "unknown";
  const isIos = /\b(iphone|ipad|ipod)\b/.test(ua);
  const isEdge = /\b(edg|edgios|edga)\//.test(ua);
  const isFirefox = /\b(firefox|fxios)\//.test(ua);
  const isChrome = /\b(chrome|crios|chromium)\//.test(ua) && !isEdge;
  const isSafari = /\bsafari\//.test(ua) && !isChrome && !isEdge && !/\b(opr|opera)\//.test(ua);

  if (isSafari && !isIos) return "safari";
  if (isIos) return "ios_webkit";
  if (isChrome) return "chrome";
  if (isEdge) return "edge";
  if (isFirefox) return "firefox";
  return "other";
}

export function authBootLastSeenAgeBucket(
  previousSeenAt: string | null,
  nowMs: number = Date.now(),
): AuthBootLastSeenAgeBucket {
  if (!previousSeenAt) return "unknown";
  const previousMs = parseAuthBootLastSeenAt(previousSeenAt);
  if (previousMs === null) return "invalid";
  const ageMs = nowMs - previousMs;
  if (ageMs < 0) return "invalid";
  if (ageMs < HOUR_MS) return "<1h";
  if (ageMs < DAY_MS) return "1-24h";
  if (ageMs < 7 * DAY_MS) return "1-7d";
  return ">=7d";
}

export function readAuthBootInitTraceAttrs(opts: { nowMs?: number } = {}): Pick<
  AuthTraceAttrs,
  | "bootTokenPresence"
  | "bootStorageAccess"
  | "bootBrowser"
  | "bootLastSeenAge"
  | "bootUserAgentRaw"
  | "bootLastSeenAgeMs"
  | "bootStorageErrorName"
  | "bootStorageErrorMessage"
  | "routeFamily"
> {
  const nowMs = opts.nowMs ?? Date.now();
  const bootUserAgentRaw = globalThis.navigator?.userAgent || undefined;
  const bootBrowser = authBootBrowserBucketFromUserAgent(bootUserAgentRaw);

  try {
    const storage = globalThis.localStorage;
    if (!storage) {
      return {
        routeFamily: "bootstrap",
        bootBrowser,
        bootUserAgentRaw,
        bootTokenPresence: "unknown",
        bootStorageAccess: "unavailable",
        bootLastSeenAge: "unknown",
      };
    }

    const accessToken = storage.getItem("slock_access_token");
    const refreshToken = storage.getItem("slock_refresh_token");
    const previousSeenAt = storage.getItem(AUTH_BOOT_LAST_SEEN_STORAGE_KEY);
    const bootTokenPresence = authBootTokenPresenceBucket(accessToken, refreshToken);
    const bootLastSeenAge = authBootLastSeenAgeBucket(previousSeenAt, nowMs);
    const bootLastSeenAgeMs = authBootLastSeenAgeMs(previousSeenAt, nowMs);
    let bootStorageAccess: AuthBootStorageAccessBucket = "readable_writable";
    let storageErrorAttrs: Pick<AuthTraceAttrs, "bootStorageErrorName" | "bootStorageErrorMessage"> = {};
    try {
      storage.setItem(AUTH_BOOT_LAST_SEEN_STORAGE_KEY, String(Math.trunc(nowMs)));
    } catch (error) {
      bootStorageAccess = "readable_write_error";
      storageErrorAttrs = authBootErrorAttrs(error);
    }

    return {
      routeFamily: "bootstrap",
      bootBrowser,
      bootUserAgentRaw,
      bootTokenPresence,
      bootStorageAccess,
      bootLastSeenAge,
      bootLastSeenAgeMs,
      ...storageErrorAttrs,
    };
  } catch (error) {
    return {
      routeFamily: "bootstrap",
      bootBrowser,
      bootUserAgentRaw,
      bootTokenPresence: "unknown",
      bootStorageAccess: "read_error",
      bootLastSeenAge: "unknown",
      ...authBootErrorAttrs(error),
    };
  }
}

function randomHex(bytes: number): string {
  try {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Non-crypto fallback; ids are correlation-only, not security-bearing.
    let out = "";
    for (let i = 0; i < bytes * 2; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  }
}

const tabId: string = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `tab-${randomHex(8)}`;
  }
})();

function dropUndefined(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function safeAssetIdFromSrc(src: string): string | null {
  try {
    const pathname = new URL(src, globalThis.location?.href ?? "https://slock.local/").pathname;
    const filename = pathname.split("/").filter(Boolean).pop();
    if (!filename || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(filename)) return null;
    return filename;
  } catch {
    const filename = src.split(/[/?#]/).filter(Boolean).pop();
    if (!filename || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(filename)) return null;
    return filename;
  }
}

function loadedWebAssetId(): string {
  try {
    const scripts = Array.from(globalThis.document?.scripts ?? []);
    const srcs = scripts
      .map((script) => script.getAttribute("src") || script.src || "")
      .filter(Boolean);
    const primary = srcs.find((src) => /\/assets\/index-[A-Za-z0-9_-]+\.js(?:[?#].*)?$/.test(src))
      ?? srcs.find((src) => /\/assets\/.+\.js(?:[?#].*)?$/.test(src));
    return (primary && safeAssetIdFromSrc(primary)) || "unknown";
  } catch {
    return "unknown";
  }
}

/** Build a single web-surface span record. */
export function buildWebTraceRecord(
  name: WebTraceEventName,
  attrs: Record<string, unknown> = {},
  options: BuildWebTraceRecordOptions = {},
): WebTraceRecord {
  const now = new Date().toISOString();
  return {
    type: "span",
    schema_version: 1,
    trace_id: options.traceId ?? randomHex(16),
    span_id: options.spanId ?? randomHex(8),
    ...(options.parentSpanId ? { parent_span_id: options.parentSpanId } : {}),
    name,
    surface: options.surface ?? "web",
    kind: options.kind ?? "internal",
    status: options.status ?? "unset",
    start_time: options.startTime ?? now,
    end_time: options.endTime ?? now,
    attrs: dropUndefined({
      ...attrs,
      tabId,
      releaseSha: RELEASE_SHA,
      deploymentEnv: DEPLOYMENT_ENV,
      appVersion: APP_VERSION,
      webAssetId: loadedWebAssetId(),
    }),
  };
}

/** Build a single web-surface span record for an auth trace event. */
export function buildAuthTraceRecord(name: AuthTraceEventName, attrs: AuthTraceAttrs = {}): WebTraceRecord {
  return buildWebTraceRecord(name, attrs as Record<string, unknown>);
}

// --- Fire-and-forget batching transport ---
//
// Two independent paths share the trace receiver but NOT the queue/flushing
// machinery:
//
//   1. Scheduled batch path (`emitAuthTrace` -> `scheduleFlush` ->
//      `flushAuthTraces`): non-urgent traces accumulate in `queue` and flush
//      ~4s later. Guarded by `flushing` to prevent overlapping batch sends.
//
//   2. Urgent fire-and-send path (`emitAuthTraceAndFlush` ->
//      `sendUrgentAuthTraceBatch`): release-gate-critical events cannot wait
//      for the scheduled batch. `slock.auth.session_cleared` callers remove the
//      auth token synchronously immediately after emit, and logout verdicts are
//      the causal "why" immediately preceding those clears. Urgent emits
//      snapshot token+serverId synchronously at emit-time, build the record
//      synchronously, then fire a self-contained POST that bypasses the
//      `queue` and the `flushing` guard. Missing-credential urgents are a true
//      drop (no enqueue, no retry).
//
// This separation closes the concurrent-flush race surfaced in #2503 review
// (cross msg=d7fccfa7): an in-flight scheduled flush sets `flushing===true`,
// and a `void flushAuthTraces()` from `emitAuthTraceAndFlush` would early-
// return at that guard — before reaching the sync token capture — letting the
// caller delete the token before the clear-trace ever sees it. Independent
// urgent path means the clear-trace owns its own captured credentials and
// goes out regardless of the scheduled flush's state.

interface QueuedWebTraceRecord {
  record: WebTraceRecord;
  // Bind records emitted with an active server to that server. Records emitted
  // before server hydration remain unbound and may bind once, to the first
  // eligible active server. This prevents a later server switch from sending
  // an already-bound record under the wrong server attestation.
  serverId: string | null;
  // Principal identity is non-secret. Bind every record emitted after auth
  // hydration to that principal so a later login cannot attribute it to a
  // different account. Only boot_init may start unbound and bind once at the
  // first fully eligible flush.
  principalId: string | null;
  canBindPrincipal: boolean;
  eligibilityAttempts: number;
}

let queue: QueuedWebTraceRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let lastTerminalAuthVerdictAttrs: AuthTraceAttrs | null = null;
let lastTerminalAuthVerdictAt = 0;
const TERMINAL_VERDICT_MIRROR_TTL_MS = 10_000;
// The scheduled path retries eligibility only. Network/receiver failures stay
// fire-and-forget drops. Eight 4-second flush opportunities give boot/server
// hydration a bounded window without creating a permanent logged-out loop.
const MAX_ELIGIBILITY_ATTEMPTS = 8;

// Registered synchronously by serverStore at startup. We do NOT import
// serverStore here (that would re-create the webAuthTrace -> serverStore ->
// api/client -> auth policy -> webAuthTrace cycle, and would force an async
// import inside flush() — which would read the access token AFTER a clear-session
// removeItem had already run). A sync getter lets the scheduled flush + the
// urgent send capture serverId + token synchronously, so an urgent send fired
// right before a clear-session token clear still has valid credentials.
let serverIdGetter: () => string | undefined = () => undefined;
let principalIdGetter: () => string | undefined = () => undefined;

export function setAuthTraceServerIdGetter(getter: () => string | undefined): void {
  serverIdGetter = getter;
}

export function setAuthTracePrincipalIdGetter(getter: () => string | undefined): void {
  principalIdGetter = getter;
}

// Test-only injection: a unit test can override the fetch implementation used
// by both transports (scheduled + urgent) so a stalled-fetch fixture can stand
// in for an in-flight scheduled flush while the urgent path is exercised. Prod
// callsites neither know about nor use this — `setAuthTraceFetchForTest(null)`
// (or `__resetAuthTraceForTest()`) restores the global `fetch`.
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let injectedFetch: FetchLike | null = null;

export function setAuthTraceFetchForTest(fetchImpl: FetchLike | null): void {
  injectedFetch = fetchImpl;
}

function getFetch(): FetchLike {
  return injectedFetch ?? (globalThis.fetch as FetchLike);
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushAuthTraces();
  }, FLUSH_DELAY_MS);
}

/**
 * Flush queued auth-trace records to the receiver. Fully failure-isolated:
 * any error (attestation, network, serialization) is swallowed and the batch
 * is dropped. Never throws, never touches auth state.
 */
export async function flushAuthTraces(): Promise<void> {
  try {
    if (!ENABLED || flushing || queue.length === 0) return;

    // Capture auth context SYNCHRONOUSLY, before any await. Tokens are never
    // retained in the queue: every attempt reads only the current credential.
    const serverId = serverIdGetter();
    const principalId = principalIdGetter();
    const token = localStorage.getItem("slock_access_token");
    if (!serverId || !principalId || !token) {
      // Boot can emit before the active server/token is hydrated. Preserve the
      // batch for a bounded number of eligibility-only attempts, then drop it.
      // This closes the pre-attestation source hole without an infinite retry.
      queue = queue
        .map((entry) => ({ ...entry, eligibilityAttempts: entry.eligibilityAttempts + 1 }))
        .filter((entry) => entry.eligibilityAttempts < MAX_ELIGIBILITY_ATTEMPTS);
      return;
    }

    // A record captured under server A must never be attested/sent under B.
    // Unbound boot records bind once to the first eligible active server.
    queue = queue
      .filter((entry) => entry.serverId === null || entry.serverId === serverId)
      .filter((entry) => entry.principalId === principalId || (entry.principalId === null && entry.canBindPrincipal))
      .map((entry) => ({
        ...entry,
        serverId: entry.serverId ?? serverId,
        principalId: entry.principalId ?? principalId,
        canBindPrincipal: false,
      }));
    if (queue.length === 0) return;

    flushing = true;
    const batch = queue.slice(0, MAX_BATCH_RECORDS);
    queue = queue.slice(batch.length);
    const records = batch.map((entry) => entry.record);

    // Raw fetch (NOT the axios `api` client): a 401 here must just drop the
    // batch, never trigger the refresh/logout response interceptor. This
    // scheduled path deliberately avoids `keepalive`; Safari has a small global
    // keepalive buffer, and repeated best-effort trace failures can otherwise
    // spam the console with "Reached maximum amount of queued data" errors.
    // Navigation-critical records use the urgent path below.
    assertValidDesktopRuntimeEnvironment();

    const fetchImpl = getFetch();
    const attestationResponse = await fetchImpl(`${API_BASE}/servers/${serverId}/scope-attestation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Server-Id": serverId,
      },
      body: JSON.stringify({ scope: WEB_TRACE_SCOPE }),
    });
    if (!attestationResponse.ok) return; // 4xx/5xx -> drop, no refresh/logout
    const data = (await attestationResponse.json()) as { attestation?: string };
    if (!data?.attestation) return;

    await fetchImpl(`${TRACE_URL}/api/web-traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attestation: data.attestation, records }),
    });
  } catch {
    // Swallow: tracing failure must never affect auth state.
  } finally {
    flushing = false;
    // If more accumulated while flushing, schedule another pass.
    if (ENABLED && queue.length > 0) scheduleFlush();
  }
}

/**
 * Urgent self-contained send path. Used by `emitAuthTraceAndFlush` for
 * release-gate-critical traces that cannot wait for the scheduled batch:
 * terminal logout verdicts and `slock.auth.session_cleared` events. This path:
 *
 *   - Carries its own credentials (snapshotted at emit-time in the caller)
 *     instead of reading them at send-time. The scheduled flush could be
 *     mid-fetch when we fire (`flushing === true`); without this independence,
 *     `flushAuthTraces` would short-circuit at the `flushing` guard before
 *     reaching its sync-capture and the urgent batch would silently lose its
 *     credentials.
 *   - Does NOT touch `queue` or `flushing`. The scheduled batch path is
 *     untouched and continues to run on its own cadence.
 *   - Drops on any failure (attestation 4xx/5xx, network error, malformed
 *     response) without throwing or mutating any auth state. keepalive so the
 *     request survives the navigation/page-unload that typically follows a
 *     logout redirect.
 *
 * Never throws, never awaited by the caller. Receiver-disabled (`!ENABLED`) or
 * missing-credential cases are filtered at the `emitAuthTraceAndFlush` caller
 * so we never reach this function without a serverId+token.
 */
async function sendUrgentAuthTraceBatch(
  record: WebTraceRecord,
  serverId: string,
  token: string,
): Promise<void> {
  try {
    assertValidDesktopRuntimeEnvironment();

    const fetchImpl = getFetch();
    const attestationResponse = await fetchImpl(`${API_BASE}/servers/${serverId}/scope-attestation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Server-Id": serverId,
      },
      body: JSON.stringify({ scope: WEB_TRACE_SCOPE }),
      keepalive: true,
    });
    if (!attestationResponse.ok) return;
    const data = (await attestationResponse.json()) as { attestation?: string };
    if (!data?.attestation) return;

    await fetchImpl(`${TRACE_URL}/api/web-traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attestation: data.attestation, records: [record] }),
      keepalive: true,
    });
  } catch {
    // Swallow: urgent tracing failure must never affect auth state.
  }
}

interface CapturedUrgentAuthTrace {
  record: WebTraceRecord;
  serverId: string;
  token: string;
}

function captureUrgentWebTrace(
  name: WebTraceEventName,
  attrs: Record<string, unknown>,
): CapturedUrgentAuthTrace | null {
  if (!ENABLED) return null;
  const serverId = serverIdGetter();
  const token = localStorage.getItem("slock_access_token");
  if (!serverId || !token) return null;
  return {
    record: buildWebTraceRecord(name, attrs),
    serverId,
    token,
  };
}

function captureUrgentAuthTrace(
  name: AuthTraceEventName,
  attrs: AuthTraceAttrs,
): CapturedUrgentAuthTrace | null {
  if (!ENABLED) return null;

  // Capture credentials SYNCHRONOUSLY, before constructing/sending. Caller
  // may removeItem(token) immediately after this capture; only values read
  // before that point can be relied on.
  const serverId = serverIdGetter();
  const token = localStorage.getItem("slock_access_token");
  if (!serverId || !token) return null; // true drop, no enqueue, no retry

  let recordAttrs = attrs;
  if (name === "slock.auth.verdict" && attrs.authVerdict === "logout") {
    lastTerminalAuthVerdictAttrs = { ...attrs };
    lastTerminalAuthVerdictAt = Date.now();
  } else if (
    name === "slock.auth.session_cleared"
    && attrs.logoutTrigger === "terminal_verdict"
    && lastTerminalAuthVerdictAttrs
    && Date.now() - lastTerminalAuthVerdictAt <= TERMINAL_VERDICT_MIRROR_TTL_MS
  ) {
    recordAttrs = { ...lastTerminalAuthVerdictAttrs, ...attrs };
    lastTerminalAuthVerdictAttrs = null;
    lastTerminalAuthVerdictAt = 0;
  }

  return {
    record: buildAuthTraceRecord(name, recordAttrs),
    serverId,
    token,
  };
}

async function waitForUrgentTraceSend(promise: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) {
    await promise;
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

/**
 * Emit an auth trace event. Fire-and-forget: enqueues a record and schedules a
 * batched flush. No-op when the receiver env is unset. Never throws.
 */
export function emitAuthTrace(name: AuthTraceEventName, attrs: AuthTraceAttrs = {}): void {
  emitWebTrace(name, attrs as Record<string, unknown>);
}

/**
 * Emit a non-urgent web trace event. Fire-and-forget: enqueues a record and
 * schedules a batched flush. No-op when the receiver env is unset. Never throws.
 */
export function emitWebTrace(name: WebTraceEventName, attrs: Record<string, unknown> = {}): void {
  emitWebTraceRecord(buildWebTraceRecord(name, attrs));
}

/** Enqueue an already-completed web span while preserving its trace context. */
export function emitWebTraceRecord(record: WebTraceRecord): void {
  try {
    if (!ENABLED) return;
    queue.push({
      record,
      serverId: serverIdGetter() ?? null,
      principalId: principalIdGetter() ?? null,
      canBindPrincipal: record.name === "slock.auth.boot_init",
      eligibilityAttempts: 0,
    });
    if (queue.length >= MAX_BATCH_RECORDS) {
      void flushAuthTraces();
      return;
    }
    scheduleFlush();
  } catch {
    // Swallow: emitting a trace must never affect auth control flow.
  }
}

/**
 * Emit an auth trace event and send it IMMEDIATELY via the independent urgent
 * path (fire-and-forget). Use this for release-gate-critical events: terminal
 * logout verdicts and clear-session events. A deferred batch flush can lose
 * these because the caller removes the access token synchronously right after a
 * terminal decision.
 *
 * Why independent of `queue`/`flushing` (review #2503 cross msg=d7fccfa7):
 * if a scheduled flush is mid-fetch (`flushing === true`), routing the urgent
 * event through `flushAuthTraces` would short-circuit at the `flushing` guard
 * *before* reaching the sync token capture, then the caller would delete the
 * token before the urgent flush ever ran. Instead this function:
 *
 *   1. Snapshots token + serverId SYNCHRONOUSLY (well before any caller
 *      `removeItem`).
 *   2. Builds the record SYNCHRONOUSLY.
 *   3. Fires `sendUrgentAuthTraceBatch` with the captured credentials —
 *      bypassing `queue` and `flushing` entirely.
 *
 * Missing-credential urgents (no serverId or no token at emit-time) are a
 * TRUE drop: not enqueued, not retried. There is no later state in which a
 * just-cleared session magically regrows a valid token, and queueing it would
 * just feed the scheduled-flush retry loop. Per contract: fire-and-forget +
 * never become a logout cause.
 *
 * Never awaited, never throws, never blocks auth control flow.
 */
export function emitAuthTraceAndFlush(name: AuthTraceEventName, attrs: AuthTraceAttrs = {}): void {
  try {
    const captured = captureUrgentAuthTrace(name, attrs);
    if (!captured) return;
    void sendUrgentAuthTraceBatch(captured.record, captured.serverId, captured.token);
  } catch {
    // Swallow: emitting a trace must never affect auth control flow.
  }
}

/**
 * Emit an auth trace event through the urgent path and give the caller a
 * bounded wait for the two-hop send to issue the real `/api/web-traces` POST.
 *
 * This is intentionally NOT the general auth-trace API. Use it only at
 * terminal clear-session sinks that are about to unload/navigate the page. The
 * generic `emitAuthTraceAndFlush` contract stays fire-and-forget so trace
 * timing cannot taint ordinary auth control flow.
 */
export async function emitAuthTraceAndFlushBeforeUnload(
  name: AuthTraceEventName,
  attrs: AuthTraceAttrs = {},
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  try {
    const captured = captureUrgentAuthTrace(name, attrs);
    if (!captured) return;
    await waitForUrgentTraceSend(
      sendUrgentAuthTraceBatch(captured.record, captured.serverId, captured.token),
      opts.timeoutMs ?? 500,
    );
  } catch {
    // Swallow: before-unload tracing failure must never change logout.
  }
}

/** Urgent non-auth event for a control path that is about to navigate away. */
export async function emitWebTraceAndFlushBeforeUnload(
  name: Exclude<WebTraceEventName, AuthTraceEventName>,
  attrs: Record<string, unknown> = {},
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  try {
    const captured = captureUrgentWebTrace(name, attrs);
    if (!captured) return;
    await waitForUrgentTraceSend(
      sendUrgentAuthTraceBatch(captured.record, captured.serverId, captured.token),
      opts.timeoutMs ?? 500,
    );
  } catch {
    // Swallow: before-unload tracing failure must never change recovery.
  }
}

/**
 * Test-only: reset module queue/timer/injection state. Optionally override the
 * trace URL so tests can deterministically exercise the transport (under
 * node:test the env-derived `TRACE_URL` is empty, which makes everything
 * no-op). Passing `traceUrl: null` (or omitting) restores the env-derived URL
 * + ENABLED state.
 */
export function __resetAuthTraceForTest(opts: { traceUrl?: string | null } = {}): void {
  queue = [];
  lastTerminalAuthVerdictAttrs = null;
  lastTerminalAuthVerdictAt = 0;
  flushing = false;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  injectedFetch = null;
  if (opts.traceUrl === undefined || opts.traceUrl === null) {
    TRACE_URL = TRACE_URL_FROM_ENV;
    ENABLED = Boolean(TRACE_URL);
  } else {
    TRACE_URL = opts.traceUrl.replace(/\/+$/, "");
    ENABLED = Boolean(TRACE_URL);
  }
}
