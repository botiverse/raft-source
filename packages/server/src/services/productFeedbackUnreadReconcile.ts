/**
 * Product-feedback unread reconcile (spec #35 step 5): the server pushes each
 * user's web unread total (`product_feedback:unread`) instead of every open
 * web tab polling `GET /api/product-feedback/tickets?limit=1` each minute,
 * and each mobile app's (`product_feedback:app_unread`, with its `source`) to
 * the native clients, which have no poll.
 *
 * One job per Hands app (productFeedbackApps.ts: the web app, and each mobile
 * source that has an entry), each with its own claim, cursor, budget and
 * state, so an app that fails or is rate limited stops no other, no mobile
 * app ever delays the web app, and everything below holds per app. The web
 * app's job is the one there was before the mobile apps: same keys, same
 * push, same tick.
 *
 * About once a minute, ONE run per app across the fleet (a Redis claim with a
 * TTL, the closed-server-purge pattern: whoever sets it runs, the others skip
 * until it expires; it is never released early, so twelve tasks still make
 * one run a minute):
 *
 * 1. Read the Hands reporter change feed of the app (Hands PR #916;
 *    readReporterChanges, the one adapter for its path and shape) from the
 *    stored cursor, with the conversation token itself (role-free, bound to
 *    the reporter integration; Hands takes no reporter session there, and no
 *    reporter header is sent). An item only says "this ticket changed, check
 *    it": the feed merges a ticket's changes, internal-only ones included, so
 *    nothing is ever pushed from an item alone.
 * 2. When the item's `comment_id` (the ticket's latest public staff or system
 *    reply) is null or the reply this job already saw on the ticket, nothing
 *    more is read.
 * 3. The item's route subject, opened with its reporter id
 *    (decryptProductFeedbackRouteSubject, which also checks that the reporter
 *    id is the one derived from the user it seals), names the Raft user. An
 *    item without a subject (an old, unbound ticket) or one that does not
 *    open is skipped and counted; no recipient is ever guessed.
 * 4. The ticket's reporter detail, every comment page, ALWAYS as a background
 *    read (getProductFeedbackTicket `background`: Hands `mark_read=false`, its
 *    own breaker, no shared session cache, the run's deadline): the public
 *    conversation the reporter sees, without moving their read receipt.
 * 5. When the detail's newest staff or system reply (by time) is one this job
 *    has not seen on that ticket, push the detail's `unread_total` to the user
 *    (on the app's event: the web event carries the web app's total only)
 *    and record the reply, ticket by ticket. A detail read that fails is
 *    retried twice (short backoff, within the deadline); still failing, the
 *    ticket is skipped (`tickets_failed`, a warn event and log line with the
 *    Hands ticket id) and the page goes on. Three skipped tickets in a row
 *    mean Hands is failing, not a ticket: the run stops there
 *    (`details_failing`), the cursor stays.
 * 6. Save the feed's `next_cursor` once every item of the page was looked at,
 *    and only while this run still holds the claim, with the time
 *    (`last_success_at`).
 *
 * Bounds:
 * - A run stops starting tickets when less than TICKET_BUDGET_MS of its
 *   budget is left (its Hands calls are aborted at the deadline or on stop);
 *   the cursor stays, the tickets done stay recorded, and the next run skips
 *   them through step 2. When STUCK_LIMIT runs in a row get no further into a
 *   page, it is passed anyway (`cursor_forced_advance`).
 * - A 429 from Hands (feed or detail) ends the run; no run calls Hands again
 *   before its Retry-After (a not-before time in shared state).
 * - A cursor Hands rejects (it is invalidated when Hands rotates its key) is
 *   replaced by Hands' current position at once, never silently: a warn
 *   event `cursor_reset` and log line give the reason, `last_success_at` and
 *   the gap. Nothing is backfilled; the next page load shows what was missed.
 * - Starting point: with no stored cursor, the feed is read once WITHOUT one,
 *   which Hands answers with its current position only.
 * - Every Redis call goes through the bounded client (a command timeout, no
 *   offline queue), so a Redis outage fails a run fast and never holds stop().
 *   Until that client first connects (the first tick after a task starts),
 *   a run skips (`skipped_not_ready`) instead of failing; a client that was
 *   ready and lost Redis is an outage and still fails (`state_unavailable`).
 * - The claim (55 s) outlasts the run budget (40 s) plus one bounded call.
 *   The web app's claim key is the one from before the mobile apps, so a task
 *   of an older version and a newer one still make one web run between them;
 *   a mobile app's carries its app id.
 *
 * The worker, each minute on each task, starts two ticks that share nothing
 * but the timer:
 * - The web tick: the web app's run, as before the mobile apps (the same
 *   code path and timing). It is skipped only while the previous web run on
 *   this task is still going (at most its 40 s budget plus a few bounded
 *   Redis calls, so under the minute). No mobile app, however slow or
 *   failing, delays or skips it.
 * - The mobile tick: the apps configuration read once (the SSM JSON, cached
 *   for minutes; at most 5 s is waited for it), then each mobile source's run
 *   one after another (a run that fails never stops the next). It is skipped
 *   while the previous mobile tick on this task is still going, so its bound
 *   is the sum: 5 s plus, per source with an app, the 40 s budget and a few
 *   bounded Redis calls (three sources: about 2.5 minutes, only when Hands
 *   answers none of them). A mobile app is then checked that much later on
 *   this task; another task whose mobile tick is free takes the app's claim
 *   meanwhile.
 * A mobile source is configured from what the read answers now: one without
 * an entry is skipped for that tick, with one log line and one
 * `outcome: disabled` trace event per source and reason for the life of the
 * process, not one a minute. So is every source when the read does not
 * answer in time, and a source on the app of an earlier one (one job per
 * app). With no apps parameter (a single-app deployment) there is no mobile
 * tick and nothing is read for one.
 *
 * Off unless HANDS_FEEDBACK_UNREAD_RECONCILE_ENABLED=true and the web
 * conversation and route configuration is complete: the worker does not
 * start; one log line and one `outcome: disabled` trace event say so. That
 * switch and privacy mode are the deployment's: a mobile source's entry
 * neither turns the job on nor off.
 *
 * Telemetry: one root span `server.product_feedback.unread_reconcile` per run,
 * with the app's `source`, holding the event
 * `server.product_feedback.unread_reconcile.run` with that `source`,
 * outcome (ok | partial | rate_limited | skipped_locked | skipped_backoff |
 * skipped_not_ready | cursor_reset | failed), a bounded error_code, cursor_initialized,
 * cursor_forced_advance, pages, tickets_changed, tickets_unbound,
 * tickets_unmapped, tickets_failed, tickets_comments_truncated,
 * tickets_with_new_reply, users_pushed and duration_ms; Hands calls are child
 * spans with the route template and upstream status. No user ids, reporter
 * ids, subjects, ticket text or tokens in any attribute (the Hands ticket id
 * only on `ticket_skipped`).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { clearClockInterval, currentTimeMs, noopTracer, setClockInterval, type Tracer, type TraceAttributes } from "@botiverse/raft-shared";
import { isPrivacyModeOn } from "../config/privacyMode";
import { getBoundedRedis, isRedisAvailable } from "../redis";
import { recordTraceEvent, withTraceChildSpan, withTraceRoot } from "../tracing/semanticTrace";
import { handsTraceHeaders } from "./handsTraceHeaders";
import {
  getProductFeedbackTicket,
  isCanonicalUuid,
  isProductFeedbackConversationConfigured,
  ProductFeedbackConversationError,
  type ProductFeedbackComment,
  type ProductFeedbackDetail,
} from "./productFeedbackConversationService";
import { readProductFeedbackRouteConfig } from "./productFeedbackRouteBindingService";
import { decryptProductFeedbackRouteSubject } from "./productFeedbackRouteSubject";
import {
  PRODUCT_FEEDBACK_SOURCES,
  ProductFeedbackSourceUnavailableError,
  productFeedbackAppsParameterName,
  readProductFeedbackAppsJson,
  selectProductFeedbackEnv,
  type CachedProductFeedbackApps,
  type ProductFeedbackSource,
} from "./productFeedbackApps";
import { pushProductFeedbackAppUnread, pushProductFeedbackUnread } from "./productFeedbackUnreadRealtime";

export const PRODUCT_FEEDBACK_RECONCILE_INTERVAL_MS = 60_000;
/** One run per this long across the fleet; longer than the run budget plus one bounded call. */
export const PRODUCT_FEEDBACK_RECONCILE_CLAIM_TTL_MS = 55_000;
export const PRODUCT_FEEDBACK_RECONCILE_RUN_BUDGET_MS = 40_000;
/** Hands allows 1-200, default 50. */
export const PRODUCT_FEEDBACK_RECONCILE_PAGE_LIMIT = 100;
export const PRODUCT_FEEDBACK_RECONCILE_MAX_PAGES = 5;
/** Runs in a row that get no further into a page before the job moves past it. */
export const PRODUCT_FEEDBACK_RECONCILE_STUCK_LIMIT = 3;
/** Retries of a failed detail read within a run, and the pause before each. */
const TICKET_RETRY_DELAYS_MS = [250, 1_000] as const;
/** Tickets in a row whose detail read failed (retries spent) before the run stops: Hands is failing, not one ticket. */
const MAX_CONSECUTIVE_FAILED_TICKETS = 3;
/** No new ticket is started with less budget left than this. */
const TICKET_BUDGET_MS = 6_000;
/** Comment pages read per ticket (100 a page); past it the ticket is counted truncated. */
const MAX_COMMENT_PAGES = 50;
const SEEN_TTL_MS = 30 * 24 * 60 * 60_000;
const STUCK_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const HANDS_CALL_TIMEOUT_MS = 5_000;
/** The longest a mobile tick waits for the apps configuration (the SSM read, cached for minutes) before skipping its sources. */
const APPS_READ_TIMEOUT_MS = 5_000;
const REDIS_COMMAND_TIMEOUT_MS = 1_000;
const HANDS_CURSOR_MAX_BYTES = 2_048;
const REPORTER_ID_RE = /^[A-Za-z0-9_-]{16,200}$/;

export type ProductFeedbackReconcileConfig = {
  /** The client kind whose Hands app this is: which event its totals go out on, and its claim. */
  source: ProductFeedbackSource;
  baseUrl: string;
  appId: string;
  appToken: string;
  reporterIntegrationId: string;
  reporterIdSecret: string;
  routeSubjectRoot: string;
  /** The app's conversation env (productFeedbackApps: the process env for web, the source's view for a mobile app) the detail reads with. */
  env: NodeJS.ProcessEnv;
};

export type ProductFeedbackReconcileDisabledReason = "not_enabled" | "conversation_unconfigured" | "privacy_mode";

/**
 * The web app's job, from the process env: the job's switch
 * (HANDS_FEEDBACK_UNREAD_RECONCILE_ENABLED), then the web app's configuration.
 */
export function readProductFeedbackReconcileConfig(
  env: NodeJS.ProcessEnv = process.env,
): { config: ProductFeedbackReconcileConfig } | { disabled: ProductFeedbackReconcileDisabledReason } {
  if (env.HANDS_FEEDBACK_UNREAD_RECONCILE_ENABLED?.trim() !== "true") return { disabled: "not_enabled" };
  return readProductFeedbackReconcileAppConfig("web", env);
}

/**
 * One app's configuration from its env view (resolveProductFeedbackEnv). The
 * job's switch is not read here: it is the deployment's, and a mobile
 * source's view neither carries nor decides it.
 */
export function readProductFeedbackReconcileAppConfig(
  source: ProductFeedbackSource,
  env: NodeJS.ProcessEnv,
): { config: ProductFeedbackReconcileConfig } | { disabled: Exclude<ProductFeedbackReconcileDisabledReason, "not_enabled"> } {
  if (isPrivacyModeOn()) return { disabled: "privacy_mode" };
  if (!isProductFeedbackConversationConfigured(env)) return { disabled: "conversation_unconfigured" };
  let route: ReturnType<typeof readProductFeedbackRouteConfig>;
  try {
    route = readProductFeedbackRouteConfig(env);
  } catch {
    return { disabled: "conversation_unconfigured" };
  }
  return {
    config: {
      source,
      baseUrl: route.baseUrl,
      appId: route.appId,
      appToken: route.appToken,
      reporterIntegrationId: route.reporterIntegrationId,
      reporterIdSecret: route.reporterIdSecret,
      routeSubjectRoot: route.root,
      env,
    },
  };
}

function validHandsCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= HANDS_CURSOR_MAX_BYTES
    && /^[\x21-\x7e]+$/.test(value);
}

// ── Shared state ─────────────────────────────────────────────────────────────

export interface ProductFeedbackReconcileState {
  /** False until the store first connects (a Redis client still connecting at boot); a run then skips. */
  ready?(): boolean;
  /**
   * True when this run may go (no other run of the app within the claim's
   * TTL). `claimKey`: the app's claim (productFeedbackReconcileClaimKey),
   * always named: no app takes another's by default.
   */
  claim(token: string, ttlMs: number, claimKey: string): Promise<boolean>;
  getCursor(appId: string): Promise<string | null>;
  /**
   * Saves the cursor and when (`last_success_at`), only while `token` still
   * holds the claim (`claimKey`, as for claim); false otherwise.
   */
  saveCursor(token: string, appId: string, cursor: string, atMs: number, claimKey: string): Promise<boolean>;
  /** When a cursor was last saved (epoch ms), or null. */
  getLastSuccessAt(appId: string): Promise<number | null>;
  /** The newest public reply id this job saw on the ticket, or null. */
  getSeenComment(appId: string, ticketId: string): Promise<string | null>;
  setSeenComment(appId: string, ticketId: string, commentId: string): Promise<void>;
  /**
   * Runs in a row stuck on `cursor`, this one counted: 1 on a new cursor, or
   * when this run `reached` further into the page than any before.
   */
  noteStuck(appId: string, cursor: string, reached: number): Promise<number>;
  clearStuck(appId: string): Promise<void>;
  /** No run calls Hands before this time (epoch ms), or null. */
  getNotBefore(appId: string): Promise<number | null>;
  setNotBefore(appId: string, atMs: number): Promise<void>;
}

const KEY_PREFIX = "slock:product-feedback-unread-reconcile";
/** The web app's claim: the job's only one before the mobile apps, kept so tasks of both versions share it. */
export const PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY = `${KEY_PREFIX}:claim`;
/** An app's claim: the web app's as it was, a mobile app's by its app id (as the cursor and the rest of its state). */
export const productFeedbackReconcileClaimKey = (app: Pick<ProductFeedbackReconcileConfig, "source" | "appId">) =>
  app.source === "web" ? PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY : `${PRODUCT_FEEDBACK_RECONCILE_CLAIM_KEY}:${app.appId}`;
export const productFeedbackReconcileCursorKey = (appId: string) => `${KEY_PREFIX}:cursor:v1:${appId}`;
const lastSuccessKey = (appId: string) => `${KEY_PREFIX}:last-success:v1:${appId}`;
// The ticket id hashed: no Hands id in Redis key names.
const seenKey = (appId: string, ticketId: string) =>
  `${KEY_PREFIX}:seen:v1:${createHash("sha256").update(`${appId}\0${ticketId}`).digest("base64url")}`;
const stuckKey = (appId: string) => `${KEY_PREFIX}:stuck:v1:${appId}`;
const notBeforeKey = (appId: string) => `${KEY_PREFIX}:not-before:v1:${appId}`;

const SAVE_IF_OWNER = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[2], ARGV[2])
  redis.call("SET", KEYS[3], ARGV[3])
  return 1
end
return 0
`;
// A hash { c: cursor, r: furthest item reached, n: runs }: counts on while
// runs stay on the same cursor without getting further; restarts at 1 otherwise.
const NOTE_STUCK = `
if redis.call("HGET", KEYS[1], "c") == ARGV[1] and tonumber(ARGV[3]) <= tonumber(redis.call("HGET", KEYS[1], "r") or "-1") then
  local n = redis.call("HINCRBY", KEYS[1], "n", 1)
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return n
end
redis.call("DEL", KEYS[1])
redis.call("HSET", KEYS[1], "c", ARGV[1], "r", ARGV[3], "n", 1)
redis.call("PEXPIRE", KEYS[1], ARGV[2])
return 1
`;

function epochMs(value: string | null): number | null {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** The Redis state on `client` (the bounded client by default: a command timeout, no offline queue). */
export function redisProductFeedbackReconcileState(
  client: () => Redis | null = () => getBoundedRedis(REDIS_COMMAND_TIMEOUT_MS),
): ProductFeedbackReconcileState {
  const redis = () => {
    const value = client();
    if (!value) throw new Error("redis unavailable");
    return value;
  };
  // Only the first connect: a client that was ready and dropped is an outage, not a boot.
  let wasReady = false;
  return {
    ready() {
      wasReady ||= client()?.status === "ready";
      return wasReady;
    },
    async claim(token, ttlMs, claimKey) {
      return (await redis().set(claimKey, token, "PX", ttlMs, "NX")) === "OK";
    },
    async getCursor(appId) {
      return redis().get(productFeedbackReconcileCursorKey(appId));
    },
    async saveCursor(token, appId, cursor, atMs, claimKey) {
      return Number(await redis().eval(
        SAVE_IF_OWNER, 3, claimKey, productFeedbackReconcileCursorKey(appId), lastSuccessKey(appId),
        token, cursor, String(atMs),
      )) === 1;
    },
    async getLastSuccessAt(appId) {
      return epochMs(await redis().get(lastSuccessKey(appId)));
    },
    async getSeenComment(appId, ticketId) {
      return redis().get(seenKey(appId, ticketId));
    },
    async setSeenComment(appId, ticketId, commentId) {
      await redis().set(seenKey(appId, ticketId), commentId, "PX", SEEN_TTL_MS);
    },
    async noteStuck(appId, cursor, reached) {
      return Number(await redis().eval(NOTE_STUCK, 1, stuckKey(appId), cursor, STUCK_TTL_MS, reached));
    },
    async clearStuck(appId) {
      await redis().del(stuckKey(appId));
    },
    async getNotBefore(appId) {
      return epochMs(await redis().get(notBeforeKey(appId)));
    },
    async setNotBefore(appId, atMs) {
      await redis().set(notBeforeKey(appId), String(atMs), "PX", Math.max(1, atMs - currentTimeMs()));
    },
  };
}

/** One process, no Redis (dev, a single replica): the same rules, in memory. */
export function memoryProductFeedbackReconcileState(now: () => number = currentTimeMs): ProductFeedbackReconcileState & {
  cursors: Map<string, string>;
  expireClaim(): void;
} {
  const holders = new Map<string, { token: string; until: number }>();
  const cursors = new Map<string, string>();
  const lastSuccess = new Map<string, number>();
  const seen = new Map<string, string>();
  const stuck = new Map<string, { cursor: string; reached: number; runs: number }>();
  const notBefore = new Map<string, number>();
  return {
    cursors,
    /** Every app's claim. */
    expireClaim() { holders.clear(); },
    async claim(token, ttlMs, claimKey) {
      const holder = holders.get(claimKey);
      if (holder && holder.until > now()) return false;
      holders.set(claimKey, { token, until: now() + ttlMs });
      return true;
    },
    async getCursor(appId) {
      return cursors.get(appId) ?? null;
    },
    async saveCursor(token, appId, cursor, atMs, claimKey) {
      const holder = holders.get(claimKey);
      if (!holder || holder.token !== token || holder.until <= now()) return false;
      cursors.set(appId, cursor);
      lastSuccess.set(appId, atMs);
      return true;
    },
    async getLastSuccessAt(appId) {
      return lastSuccess.get(appId) ?? null;
    },
    async getSeenComment(appId, ticketId) {
      return seen.get(seenKey(appId, ticketId)) ?? null;
    },
    async setSeenComment(appId, ticketId, commentId) {
      seen.set(seenKey(appId, ticketId), commentId);
    },
    async noteStuck(appId, cursor, reached) {
      const previous = stuck.get(appId);
      const next = previous && previous.cursor === cursor && reached <= previous.reached
        ? { ...previous, runs: previous.runs + 1 }
        : { cursor, reached, runs: 1 };
      stuck.set(appId, next);
      return next.runs;
    },
    async clearStuck(appId) {
      stuck.delete(appId);
    },
    async getNotBefore(appId) {
      const at = notBefore.get(appId);
      return at !== undefined && at > now() ? at : null;
    },
    async setNotBefore(appId, atMs) {
      notBefore.set(appId, atMs);
    },
  };
}

let processState: ProductFeedbackReconcileState | null = null;
function defaultState(): ProductFeedbackReconcileState {
  if (isRedisAvailable()) return redisProductFeedbackReconcileState();
  processState ??= memoryProductFeedbackReconcileState();
  return processState;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type ProductFeedbackReconcileErrorCode =
  | "changes_timeout" | "changes_transport" | "changes_rejected" | "changes_invalid_cursor"
  | "changes_rate_limited" | "changes_status_5xx" | "changes_status_other" | "changes_bad_body"
  | "detail_rate_limited" | "details_failing" | "run_deadline" | "claim_lost" | "state_unavailable" | "unexpected";

export class ProductFeedbackReconcileError extends Error {
  constructor(readonly code: ProductFeedbackReconcileErrorCode, readonly retryAfterMs: number | null = null) {
    super(code);
    this.name = "ProductFeedbackReconcileError";
  }
}

/** A state call; any failure (timeout, Redis down) is `state_unavailable`. */
async function stateCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch {
    throw new ProductFeedbackReconcileError("state_unavailable");
  }
}

function transportReason(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "request_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Retry-After (seconds or an HTTP date) in ms, bounded; the default when absent or unreadable. */
export function retryAfterMs(value: string | null, now: number = currentTimeMs()): number {
  const trimmed = value?.trim() ?? "";
  let ms = Number.NaN;
  if (/^\d+$/.test(trimmed)) ms = Number(trimmed) * 1_000;
  else if (trimmed) ms = Date.parse(trimmed) - now;
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, ms));
}

// ── The change-feed adapter (the only place that knows its path and shape) ───

// Hands PR #916:
//   GET /api/apps/:appId/reporter-feedback/changes?cursor=<opaque>&limit=<1..200>
//   Authorization: Bearer <the role-free, integration-bound conversation token>
//   (no X-Hands-Reporter-Id; reporter session tokens are refused)
//   -> { changes: [{ ticket_id, route_subject|null, reporter_id, comment_id|null }], next_cursor, has_more }
//   `comment_id`: the latest public staff or system reply id (not an event id).
//   Without a cursor: no history, only next_cursor. The cursor is encrypted,
//   bound to app and integration, and refused (400) after Hands rotates its key.
// Parsing is tolerant: an item without a usable ticket id or reporter id is
// skipped (unmapped), one without a route subject is unbound; unknown fields
// are ignored and never read on.
const CHANGES_ROUTE = "/api/apps/:appId/reporter-feedback/changes";
const changesPath = (appId: string) => `/api/apps/${encodeURIComponent(appId)}/reporter-feedback/changes`;
/** What Hands answers for a cursor it no longer accepts. */
const INVALID_CURSOR_STATUSES = new Set([400, 410, 422]);

export type ReporterChange =
  | {
    ticketId: string;
    /** Null: an old ticket filed before route binding. */
    routeSubject: string | null;
    reporterId: string;
    /** The latest public reply id; null: none; undefined: the feed did not say. */
    latestReplyId: string | null | undefined;
  }
  | null;
export type ReporterChangesPage = { changes: ReporterChange[]; nextCursor: string; hasMore: boolean };

function parseChange(value: unknown): ReporterChange {
  if (!isRecord(value)) return null;
  const ticketId = typeof value.ticket_id === "string" ? value.ticket_id.toLowerCase() : null;
  const reporterId = typeof value.reporter_id === "string" ? value.reporter_id : null;
  if (!ticketId || !isCanonicalUuid(ticketId) || !reporterId || !REPORTER_ID_RE.test(reporterId)) return null;
  const routeSubject = typeof value.route_subject === "string" && value.route_subject.startsWith("rfr_v1_") && value.route_subject.length <= 160
    ? value.route_subject
    : null;
  const latestReplyId = value.comment_id === null ? null
    : typeof value.comment_id === "string" && isCanonicalUuid(value.comment_id.toLowerCase()) ? value.comment_id.toLowerCase()
      : undefined;
  return { ticketId, routeSubject, reporterId, latestReplyId };
}

export async function readReporterChanges(input: {
  config: ProductFeedbackReconcileConfig;
  fetchImpl: typeof fetch;
  deadline: AbortSignal;
  /** Null: ask for the current position only. */
  cursor: string | null;
  limit: number;
}): Promise<ReporterChangesPage> {
  if (input.deadline.aborted) throw new ProductFeedbackReconcileError("run_deadline");
  const params = new URLSearchParams({ limit: String(input.limit) });
  if (input.cursor !== null) params.set("cursor", input.cursor);
  let response: Response;
  try {
    response = await withTraceChildSpan(
      "server.product_feedback.unread_reconcile.hands_request",
      { surface: "server", kind: "client", attrs: { hands_route: CHANGES_ROUTE, with_cursor: input.cursor !== null } },
      () => input.fetchImpl(`${input.config.baseUrl}${changesPath(input.config.appId)}?${params}`, {
        method: "GET",
        signal: AbortSignal.any([input.deadline, AbortSignal.timeout(HANDS_CALL_TIMEOUT_MS)]),
        headers: { Authorization: `Bearer ${input.config.appToken}`, Accept: "application/json", ...handsTraceHeaders() },
      }),
      {
        onSuccess: (result) => ({ upstream_status: result.status }),
        onError: (error) => ({ reason: transportReason(error) }),
      },
    );
  } catch (error) {
    if (input.deadline.aborted) throw new ProductFeedbackReconcileError("run_deadline");
    throw new ProductFeedbackReconcileError(transportReason(error) === "timeout" ? "changes_timeout" : "changes_transport");
  }
  if (input.cursor !== null && INVALID_CURSOR_STATUSES.has(response.status)) throw new ProductFeedbackReconcileError("changes_invalid_cursor");
  if (response.status === 429) {
    throw new ProductFeedbackReconcileError("changes_rate_limited", retryAfterMs(response.headers.get("retry-after")));
  }
  if (response.status === 401 || response.status === 403) throw new ProductFeedbackReconcileError("changes_rejected");
  if (response.status >= 500) throw new ProductFeedbackReconcileError("changes_status_5xx");
  if (!response.ok) throw new ProductFeedbackReconcileError("changes_status_other");
  const value = await response.json().catch(() => null) as unknown;
  if (
    !isRecord(value) || (value.changes !== undefined && !Array.isArray(value.changes)) || !validHandsCursor(value.next_cursor)
    || (value.has_more !== undefined && typeof value.has_more !== "boolean")
  ) throw new ProductFeedbackReconcileError("changes_bad_body");
  const changes = Array.isArray(value.changes) ? value.changes : [];
  return { changes: changes.map(parseChange), nextCursor: value.next_cursor, hasMore: value.has_more === true };
}

// ── One run ──────────────────────────────────────────────────────────────────

export type ProductFeedbackReconcileOutcome =
  | "ok" | "partial" | "rate_limited" | "skipped_locked" | "skipped_backoff" | "skipped_not_ready" | "cursor_reset" | "failed";

export type ProductFeedbackReconcileResult = {
  outcome: ProductFeedbackReconcileOutcome;
  errorCode: ProductFeedbackReconcileErrorCode | null;
  cursorInitialized: boolean;
  cursorForcedAdvance: boolean;
  pages: number;
  ticketsChanged: number;
  ticketsUnbound: number;
  ticketsUnmapped: number;
  ticketsFailed: number;
  ticketsCommentsTruncated: number;
  ticketsWithNewReply: number;
  usersPushed: number;
};

export type ProductFeedbackReconcileDeps = {
  config: ProductFeedbackReconcileConfig;
  state?: ProductFeedbackReconcileState;
  fetchImpl?: typeof fetch;
  /** Sends a user their new total (default: the app's own event, pushOf). */
  push?: (userId: string, unreadTotal: number) => void;
  tracer?: Tracer;
  runBudgetMs?: number;
  /** Least budget left to start a ticket (default TICKET_BUDGET_MS). */
  ticketBudgetMs?: number;
  /** Pauses before each retry of a failed detail read (default 250 ms, 1 s). */
  ticketRetryDelaysMs?: readonly number[];
  maxPages?: number;
  /** Aborts the run (the worker's stop). */
  signal?: AbortSignal;
  log?: Pick<Console, "warn">;
};

/** The only detail read the job makes: a background read, never marking anything read. */
function readDetailInBackground(input: {
  userId: string;
  reporterId: string;
  ticketId: string;
  commentCursor?: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  deadline: AbortSignal;
}): Promise<ProductFeedbackDetail> {
  return getProductFeedbackTicket({
    userId: input.userId,
    reporterId: input.reporterId,
    ticketId: input.ticketId,
    commentLimit: 100,
    commentCursor: input.commentCursor,
    background: { signal: AbortSignal.any([input.deadline, AbortSignal.timeout(HANDS_CALL_TIMEOUT_MS)]) },
    env: input.env,
    fetchImpl: input.fetchImpl,
  });
}

function resultAttrs(result: ProductFeedbackReconcileResult, startedAt: number): TraceAttributes {
  return {
    outcome: result.outcome,
    ...(result.errorCode ? { error_code: result.errorCode } : {}),
    cursor_initialized: result.cursorInitialized,
    cursor_forced_advance: result.cursorForcedAdvance,
    pages: result.pages,
    tickets_changed: result.ticketsChanged,
    tickets_unbound: result.ticketsUnbound,
    tickets_unmapped: result.ticketsUnmapped,
    tickets_failed: result.ticketsFailed,
    tickets_comments_truncated: result.ticketsCommentsTruncated,
    tickets_with_new_reply: result.ticketsWithNewReply,
    users_pushed: result.usersPushed,
    duration_ms: currentTimeMs() - startedAt,
  };
}

/** One tick: claim, read feed pages, check changed tickets, push, save the cursor. Never throws. */
export async function runProductFeedbackUnreadReconcile(deps: ProductFeedbackReconcileDeps): Promise<ProductFeedbackReconcileResult> {
  const startedAt = currentTimeMs();
  const result: ProductFeedbackReconcileResult = {
    outcome: "ok", errorCode: null, cursorInitialized: false, cursorForcedAdvance: false, pages: 0,
    ticketsChanged: 0, ticketsUnbound: 0, ticketsUnmapped: 0, ticketsFailed: 0, ticketsCommentsTruncated: 0,
    ticketsWithNewReply: 0, usersPushed: 0,
  };
  const { source } = deps.config;
  return withTraceRoot(deps.tracer ?? noopTracer, "server.product_feedback.unread_reconcile", { surface: "server", kind: "internal", attrs: { source } }, async () => {
    try {
      await reconcile(deps, result);
    } catch (error) {
      result.outcome = "failed";
      result.errorCode = error instanceof ProductFeedbackReconcileError ? error.code : "unexpected";
    }
    recordTraceEvent("server.product_feedback.unread_reconcile.run", { source, ...resultAttrs(result, startedAt) });
    return result;
  });
}

/**
 * The event an app's totals go out on: `product_feedback:unread` is the web
 * app's alone (a web client takes any as its own total); a mobile app's go
 * out as `product_feedback:app_unread` with its source.
 */
function pushOf(source: ProductFeedbackSource): (userId: string, unreadTotal: number) => void {
  if (source === "web") return pushProductFeedbackUnread;
  const app = source;
  return (userId, unreadTotal) => { pushProductFeedbackAppUnread(userId, app, unreadTotal); };
}

/** The job's name in a log line: the web app's as it always was, a mobile app's with its source. */
function jobLabel(config: ProductFeedbackReconcileConfig): string {
  return config.source === "web" ? "unread reconcile" : `unread reconcile (${config.source})`;
}

/** The Raft user sealed in a route subject, checked against its reporter id; null when it does not open. */
function routeSubjectUser(config: ProductFeedbackReconcileConfig, routeSubject: string, reporterId: string): string | null {
  try {
    return decryptProductFeedbackRouteSubject({
      root: config.routeSubjectRoot,
      reporterIdSecret: config.reporterIdSecret,
      subject: routeSubject,
      coordinate: { appId: config.appId, reporterIntegrationId: config.reporterIntegrationId, reporterId },
    });
  } catch {
    return null;
  }
}

/** The newest staff or system reply of a comment list, by time (the list order is not relied on). */
function newestPublicReply(comments: readonly ProductFeedbackComment[], current: ProductFeedbackComment | null): ProductFeedbackComment | null {
  let newest = current;
  for (const comment of comments) {
    if (comment.author_type === "reporter") continue;
    if (!newest || comment.created_at >= newest.created_at) newest = comment;
  }
  return newest;
}

type TicketOutcome = "skipped" | "unbound" | "unmapped" | "failed" | "pushed";

class DeadlineReached extends Error {}

/** Every comment page of the ticket's detail; throws what the read throws. */
async function readNewestReply(input: {
  userId: string;
  reporterId: string;
  ticketId: string;
  config: ProductFeedbackReconcileConfig;
  fetchImpl: typeof fetch;
  deadline: AbortSignal;
}): Promise<{ newest: ProductFeedbackComment | null; unreadTotal: number; truncated: boolean }> {
  let newest: ProductFeedbackComment | null = null;
  let unreadTotal = 0;
  let commentCursor: string | undefined;
  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    const detail = await readDetailInBackground({
      userId: input.userId, reporterId: input.reporterId, ticketId: input.ticketId, commentCursor,
      env: input.config.env, fetchImpl: input.fetchImpl, deadline: input.deadline,
    });
    unreadTotal = detail.unread_total;
    newest = newestPublicReply(detail.comments, newest);
    if (!detail.next_comment_cursor) return { newest, unreadTotal, truncated: false };
    commentCursor = detail.next_comment_cursor;
  }
  return { newest, unreadTotal, truncated: true };
}

function ticketErrorCode(error: unknown): string {
  return error instanceof ProductFeedbackConversationError ? error.code : "unexpected";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function reconcileTicket(input: {
  deps: ProductFeedbackReconcileDeps;
  state: ProductFeedbackReconcileState;
  fetchImpl: typeof fetch;
  push: (userId: string, unreadTotal: number) => void;
  deadline: AbortSignal;
  change: NonNullable<ReporterChange>;
  result: ProductFeedbackReconcileResult;
}): Promise<TicketOutcome> {
  const { config } = input.deps;
  const { change } = input;
  // The feed's own latest public reply: none, or the one already seen, means
  // nothing to read.
  if (change.latestReplyId === null) return "skipped";
  const seen = await stateCall(() => input.state.getSeenComment(config.appId, change.ticketId));
  if (change.latestReplyId !== undefined && change.latestReplyId === seen) return "skipped";
  if (change.routeSubject === null) return "unbound";
  const userId = routeSubjectUser(config, change.routeSubject, change.reporterId);
  if (!userId) return "unmapped";

  // The detail is the source of truth for what the reporter sees; a failed
  // read is retried, then the ticket is skipped (never the page).
  const retryDelays = input.deps.ticketRetryDelaysMs ?? TICKET_RETRY_DELAYS_MS;
  let read: Awaited<ReturnType<typeof readNewestReply>> | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt > 0) await sleep(retryDelays[attempt - 1]!, input.deadline);
    if (input.deadline.aborted) throw new DeadlineReached();
    try {
      read = await readNewestReply({ userId, reporterId: change.reporterId, ticketId: change.ticketId, config, fetchImpl: input.fetchImpl, deadline: input.deadline });
      break;
    } catch (error) {
      if (input.deadline.aborted) throw new DeadlineReached();
      if (error instanceof ProductFeedbackConversationError && error.code === "feedback_not_found") return "skipped";
      if (error instanceof ProductFeedbackConversationError && error.code === "feedback_rate_limited") {
        throw new ProductFeedbackReconcileError(
          "detail_rate_limited",
          error.retryAfterSeconds === null ? DEFAULT_RETRY_AFTER_MS : error.retryAfterSeconds * 1_000,
        );
      }
      lastError = error;
    }
  }
  if (!read) {
    const errorCode = ticketErrorCode(lastError);
    const upstreamStatus = lastError instanceof ProductFeedbackConversationError ? lastError.diagnostic.upstreamStatus : null;
    // The Hands ticket id is a Hands resource id, not user content (Tenny).
    recordTraceEvent("server.product_feedback.unread_reconcile.ticket_skipped", {
      level: "warn", source: config.source, ticket_id: change.ticketId, error_code: errorCode, attempts: retryDelays.length + 1,
      ...(upstreamStatus === null ? {} : { upstream_status: upstreamStatus }),
    });
    (input.deps.log ?? console).warn(`[product-feedback] ${jobLabel(config)} skipped ticket ${change.ticketId} (${errorCode})`);
    return "failed";
  }
  if (read.truncated) input.result.ticketsCommentsTruncated += 1;
  const replyId = read.newest?.id;
  if (!replyId || replyId === seen) return "skipped";
  input.push(userId, read.unreadTotal);
  await stateCall(() => input.state.setSeenComment(config.appId, change.ticketId, replyId));
  return "pushed";
}

async function reconcile(deps: ProductFeedbackReconcileDeps, result: ProductFeedbackReconcileResult): Promise<void> {
  const { config } = deps;
  const state = deps.state ?? defaultState();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const push = deps.push ?? pushOf(config.source);
  const log = deps.log ?? console;
  const claimToken = randomUUID();
  const claimKey = productFeedbackReconcileClaimKey(config);

  if (state.ready && !state.ready()) {
    result.outcome = "skipped_not_ready";
    return;
  }
  const notBefore = await stateCall(() => state.getNotBefore(config.appId));
  if (notBefore !== null && notBefore > currentTimeMs()) {
    result.outcome = "skipped_backoff";
    return;
  }
  const claimed = await stateCall(() => state.claim(claimToken, PRODUCT_FEEDBACK_RECONCILE_CLAIM_TTL_MS, claimKey));
  if (!claimed) {
    result.outcome = "skipped_locked";
    return;
  }
  let cursor = await stateCall(() => state.getCursor(config.appId));

  const budgetMs = deps.runBudgetMs ?? PRODUCT_FEEDBACK_RECONCILE_RUN_BUDGET_MS;
  const endsAt = currentTimeMs() + budgetMs;
  const budget = AbortSignal.timeout(budgetMs);
  const deadline = deps.signal ? AbortSignal.any([budget, deps.signal]) : budget;
  const saveCursor = async (next: string) => {
    if (!(await stateCall(() => state.saveCursor(claimToken, config.appId, next, currentTimeMs(), claimKey)))) {
      throw new ProductFeedbackReconcileError("claim_lost");
    }
  };
  // Hands' current position, nothing of the answer processed.
  const startFromNow = async () => {
    const position = await readReporterChanges({ config, fetchImpl, deadline, cursor: null, limit: 1 });
    await saveCursor(position.nextCursor);
  };

  try {
    if (!validHandsCursor(cursor)) {
      await startFromNow();
      result.cursorInitialized = true;
      return;
    }

    const maxPages = deps.maxPages ?? PRODUCT_FEEDBACK_RECONCILE_MAX_PAGES;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      let page: ReporterChangesPage;
      try {
        page = await readReporterChanges({ config, fetchImpl, deadline, cursor, limit: PRODUCT_FEEDBACK_RECONCILE_PAGE_LIMIT });
      } catch (error) {
        if (!(error instanceof ProductFeedbackReconcileError) || error.code !== "changes_invalid_cursor") throw error;
        // Never silent: when the job last got through, and the gap, read
        // before the reset records a new success time.
        const lastSuccessAt = await stateCall(() => state.getLastSuccessAt(config.appId));
        const now = currentTimeMs();
        const attrs: TraceAttributes = {
          level: "warn",
          source: config.source,
          reason: error.code,
          ...(lastSuccessAt === null ? {} : {
            last_success_at: new Date(lastSuccessAt).toISOString(),
            gap_seconds: Math.max(0, Math.round((now - lastSuccessAt) / 1_000)),
          }),
        };
        recordTraceEvent("server.product_feedback.unread_reconcile.cursor_reset", attrs);
        log.warn(`[product-feedback] ${jobLabel(config)} cursor reset (reason=${error.code}, last_success_at=${attrs.last_success_at ?? "unknown"}, gap_seconds=${attrs.gap_seconds ?? "unknown"}); changes in the gap are not pushed`);
        await startFromNow();
        await stateCall(() => state.clearStuck(config.appId));
        result.outcome = "cursor_reset";
        result.errorCode = error.code;
        return;
      }
      result.pages += 1;

      const ticketsLookedAt = new Set<string>();
      let cutShort = false;
      let reached = 0;
      let failedInRow = 0;
      for (const [index, change] of page.changes.entries()) {
        reached = index;
        if (!change) {
          result.ticketsUnmapped += 1;
          continue;
        }
        if (ticketsLookedAt.has(change.ticketId)) continue;
        if (deadline.aborted || endsAt - currentTimeMs() < (deps.ticketBudgetMs ?? TICKET_BUDGET_MS)) {
          cutShort = true;
          break;
        }
        ticketsLookedAt.add(change.ticketId);
        result.ticketsChanged += 1;
        let outcome: TicketOutcome;
        try {
          outcome = await reconcileTicket({ deps, state, fetchImpl, push, deadline, change, result });
        } catch (error) {
          if (!(error instanceof DeadlineReached)) throw error;
          cutShort = true;
          break;
        }
        if (outcome === "unbound") result.ticketsUnbound += 1;
        else if (outcome === "unmapped") result.ticketsUnmapped += 1;
        if (outcome === "failed") {
          result.ticketsFailed += 1;
          failedInRow += 1;
          if (failedInRow >= MAX_CONSECUTIVE_FAILED_TICKETS) {
            // Hands is failing, not one ticket: stop here, the cursor stays
            // (progress measured from the first of the failed run).
            reached = index - failedInRow + 1;
            result.errorCode = "details_failing";
            cutShort = true;
            break;
          }
          continue;
        }
        failedInRow = 0;
        if (outcome === "pushed") {
          result.ticketsWithNewReply += 1;
          result.usersPushed += 1;
        }
      }

      if (cutShort) {
        // The tickets done stay recorded (the next run skips them) and the
        // cursor stays. A run that got no further into the page than the runs
        // before counts as stuck; that many in a row move past the page.
        result.outcome = "partial";
        result.errorCode ??= "run_deadline";
        const runs = await stateCall(() => state.noteStuck(config.appId, cursor!, reached));
        if (runs >= PRODUCT_FEEDBACK_RECONCILE_STUCK_LIMIT) {
          await saveCursor(page.nextCursor);
          await stateCall(() => state.clearStuck(config.appId));
          recordTraceEvent("server.product_feedback.unread_reconcile.cursor_forced_advance", { level: "warn", source: config.source, stuck_runs: runs });
          log.warn(`[product-feedback] ${jobLabel(config)} moved past a page after ${runs} runs without progress`);
          result.cursorForcedAdvance = true;
        }
        return;
      }

      // Every item of the page looked at: only now does the cursor move.
      await saveCursor(page.nextCursor);
      await stateCall(() => state.clearStuck(config.appId));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
  } catch (error) {
    if (
      error instanceof ProductFeedbackReconcileError
      && (error.code === "changes_rate_limited" || error.code === "detail_rate_limited")
    ) {
      // No run calls Hands again before its Retry-After. Tickets done stay
      // recorded; the cursor stays.
      await stateCall(() => state.setNotBefore(config.appId, currentTimeMs() + (error.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS)));
      result.outcome = "rate_limited";
      result.errorCode = error.code;
      return;
    }
    throw error;
  }
}

// ── The worker ───────────────────────────────────────────────────────────────

export type ProductFeedbackReconcileWorkerHandle = {
  /** The web tick. */
  tick(): Promise<void>;
  /** The mobile tick: every mobile source that has an app, one after another. */
  tickMobile(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Starts the once-a-minute ticks on this task, or nothing when the job is off
 * (one log line and one trace event say why): the web tick (the web app's
 * run, skipped while the previous one on this task is still going) and,
 * apart from it, the mobile tick (each mobile source's run that has an app,
 * one after another, skipped while the previous mobile tick on this task is
 * still going). Neither waits for the other. stop() aborts the runs in flight
 * (their Hands calls and retry pauses, through the run's signal), starts no
 * further one and waits for them; their Redis calls are bounded by the
 * client's command timeout, and the apps configuration read is not waited for
 * once stopped.
 */
export function startProductFeedbackUnreadReconcileWorker(opts: {
  tracer?: Tracer;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  /** Tests: the mobile sources' apps (the SSM JSON), and how long a mobile tick waits for them. */
  apps?: CachedProductFeedbackApps;
  appsReadTimeoutMs?: number;
  /** Tests: every run's state, fetch and push. */
  deps?: Pick<ProductFeedbackReconcileDeps, "state" | "fetchImpl" | "push">;
} = {}): ProductFeedbackReconcileWorkerHandle {
  const read = readProductFeedbackReconcileConfig(opts.env);
  if ("disabled" in read) {
    console.info(`[product-feedback] unread reconcile off (${read.disabled})`);
    recordTraceEvent("server.product_feedback.unread_reconcile.run", { outcome: "disabled", reason: read.disabled }, opts.tracer);
    return { async tick() {}, async tickMobile() {}, async stop() {} };
  }
  const { config } = read;
  let running: Promise<void> | null = null;
  let stopped = false;
  const stopping = new AbortController();
  // The web tick, as before the mobile apps: its own guard, nothing of a mobile app in its way.
  const tick = async () => {
    if (running || stopped) return;
    running = runProductFeedbackUnreadReconcile({ ...opts.deps, config, tracer: opts.tracer, signal: stopping.signal })
      .then(() => undefined, () => undefined);
    try { await running; } finally { running = null; }
  };

  // ── The mobile tick ──
  // No apps parameter (a single-app deployment): no mobile source, nothing read for one.
  const mobileSources = productFeedbackAppsParameterName(opts.env ?? process.env)
    ? PRODUCT_FEEDBACK_SOURCES.filter((source) => source !== "web")
    : [];
  // Said once per source and reason for the life of the process, never once a
  // minute: a source without an app is an ordinary state (not every client
  // kind has one), looked at again each tick.
  const saidSkipped = new Set<string>();
  const skipSource = (source: ProductFeedbackSource, reason: string) => {
    if (saidSkipped.has(`${source}:${reason}`)) return;
    saidSkipped.add(`${source}:${reason}`);
    // A fixed reason code (field names at most, in the log only); never a value.
    console.info(`[product-feedback] unread reconcile skips ${source} (${reason})`);
    recordTraceEvent("server.product_feedback.unread_reconcile.run", { outcome: "disabled", source, reason: reason.split(":")[0]! }, opts.tracer);
  };
  /**
   * The apps JSON as it is now, read once for every source of the tick; null
   * when the read did not answer in time or stop() cut the wait (the read is
   * left behind: it never holds the tick or stop()). Never throws.
   */
  const readApps = async (): Promise<{ json: string | null } | null> => {
    const waited = new AbortController();
    try {
      return await Promise.race([
        readProductFeedbackAppsJson(opts.apps).then((json) => ({ json })),
        sleep(opts.appsReadTimeoutMs ?? APPS_READ_TIMEOUT_MS, AbortSignal.any([stopping.signal, waited.signal])).then(() => null),
      ]);
    } catch {
      return null;
    } finally {
      waited.abort();
    }
  };
  /** The source's app in `appsJson`; null (skipped this tick, and said) when it has none. Never throws. */
  const mobileConfig = (source: ProductFeedbackSource, appsJson: string | null): ProductFeedbackReconcileConfig | null => {
    let reason: string;
    try {
      const app = readProductFeedbackReconcileAppConfig(source, selectProductFeedbackEnv({ source, appsJson, env: opts.env }));
      if ("config" in app) return app.config;
      reason = app.disabled;
    } catch (error) {
      reason = error instanceof ProductFeedbackSourceUnavailableError ? error.reason : "unexpected";
    }
    skipSource(source, reason);
    return null;
  };
  const runMobileApps = async () => {
    const apps = await readApps();
    // One job per app: a source set on the app of an earlier one (the web
    // app's included) would be a second run on that app's cursor.
    const appIds = new Set([config.appId]);
    for (const source of mobileSources) {
      if (stopped) return;
      if (!apps) {
        skipSource(source, "apps_read_timeout");
        continue;
      }
      const app = mobileConfig(source, apps.json);
      if (!app) continue;
      if (appIds.has(app.appId)) {
        skipSource(source, "app_shared");
        continue;
      }
      appIds.add(app.appId);
      await runProductFeedbackUnreadReconcile({ ...opts.deps, config: app, tracer: opts.tracer, signal: stopping.signal });
    }
  };
  let mobileRunning: Promise<void> | null = null;
  const tickMobile = async () => {
    if (mobileRunning || stopped || mobileSources.length === 0) return;
    mobileRunning = runMobileApps().then(() => undefined, () => undefined);
    try { await mobileRunning; } finally { mobileRunning = null; }
  };

  const timer = setClockInterval(() => {
    void tick();
    void tickMobile();
  }, opts.intervalMs ?? PRODUCT_FEEDBACK_RECONCILE_INTERVAL_MS);
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
  return {
    tick,
    tickMobile,
    async stop() {
      stopped = true;
      clearClockInterval(timer);
      stopping.abort();
      await Promise.all([running, mobileRunning]);
    },
  };
}
