/**
 * Drains notification_outbox (design §3.6): one dispatcher for every
 * transport.
 *
 *   claim (by ids after the sending transaction, or a batch every 15 s;
 *          FOR UPDATE SKIP LOCKED, several replicas drain concurrently)
 *   group by event (and source channel)
 *   load once per event: message / sender / channel / parent / server,
 *          prefs (settings.ts), presence (one MGET), devices, badges
 *   per receiver: policy.decide -> presence plan -> buildNotification
 *   inside the event's channel writer fence: re-read the rows and access (a
 *          conversion or membership removal may have revoked them)
 *   outside the transaction: socket and external transports through a bounded
 *          pool with retries
 *   write status / decision / transports / first_failure / latency_ms
 */
import type { Server as SocketServer } from "socket.io";
import { randomInt } from "node:crypto";
import { setTimeout as sleepTimer, setImmediate as waitUntilNextTurn } from "node:timers/promises";
import { and, asc, desc, eq, exists, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { mapWithConcurrency } from "../../lib/mapWithConcurrency";
import {
  DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS,
  isNotificationCategory,
  noopTracer,
  notificationMobileDelayMs,
  setClockInterval,
  type NotificationAccountSettings,
  type NotificationCategory,
  type Tracer,
} from "@botiverse/raft-shared";
import { getConfiguredAppUrl } from "../../config/appUrl";
import { getRedis, isRedisAvailable } from "../../redis";
import { getDb, registerDatabaseCloseHookForTests, type DatabaseExecutor } from "../../db/index";
import {
  agents,
  attachments,
  channelHumans,
  channels,
  messages,
  notificationOutbox,
  pushRegistrations,
  pushSubscriptions,
  servers,
  sessionFamilies,
  sessions,
  tasks,
  users,
} from "../../db/schema";
import { UUID_RE } from "../../lib/messageId";
import { addTraceEvent, errorClassOf, runWithTraceSpan } from "../../tracing/semanticTrace";
import { withChannelWriterFence } from "../channelConversionFenceService";
import { getJointThreadProjectionByLocalThread, getMessageStorageChannelIdWithExecutor } from "../channelService";
import { resolveJointHumanEntrySql } from "../jointHumanMembershipAccess";
import { systemMessageNotificationEvent } from "../systemMessageBornReadRegistry";
import { alertBadge, loadLastSentBadges, loadNotificationBadges, rememberSentBadge, serverBadgeOf, type NotificationBadge } from "./badge";
import {
  buildNotification,
  parseNotificationNoticePayload,
  type NotificationConversation,
  type NotificationEventContext,
  type NotificationMessageNotice,
} from "./envelope";
import { decide, type NotificationPolicyRow } from "./policy";
import { loadNotificationPresence, NO_COMPUTER_DELIVERY, planNotificationDevices, type NotificationDeliverability } from "./presence";
import { isNotificationReadThrough, recordShownGroups } from "./retraction";
import {
  claimDueMobileDeferrals,
  extendMobileDeferral,
  finishMobileDeferral,
  finishMobileDeferralOfOutbox,
  MOBILE_DEFERRAL_BATCH_SIZE,
  MOBILE_DEFERRAL_MAX_ATTEMPTS,
  markHeldPhoneAlerts,
  recordMobileDeferrals,
  sweepMobileDeferrals,
  type MobileDeferralRow,
} from "./mobileDeferral";
import { loadMultiServerUserIds, loadNotificationPolicyPrefs } from "./settings";
import { apnsAlertRequest, apnsBackgroundRequest, apnsTransport } from "./transports/apns";
import { emitDesktopNotification, emitDesktopNotificationWithAck } from "./transports/desktopSocket";
import { fcmAlertMessage, fcmBackgroundMessage, fcmTransport } from "./transports/fcm";
import { emitMobileNotification, mobileSocketPayload } from "./transports/mobileSocket";
import { pushEndpointHash, webPushEndpointHostname, webPushPayload, webPushTransport } from "./transports/webPush";
import {
  notificationDecisionLabel,
  type BuiltNotification,
  type ExternalSendResult,
  type MobileBackgroundPush,
  type MobileRegistrationTarget,
  type NotificationDecision,
  type NotificationOutboxRow,
  type NotificationTransportCounts,
  type NotificationUserPresence,
  type WebPushSubscriptionTarget,
} from "./types";

export const NOTIFICATION_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;
const OUTBOX_BATCH_SIZE = 100;
const OUTBOX_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
/** An event older than this at claim only syncs the badge (it would alert far too late). */
export const NOTIFICATION_STALE_AFTER_MS = 10 * 60 * 1000;
/** In-flight sends per lane (sockets, Web Push, APNs, FCM; see runLanes). */
export const NOTIFICATION_EXTERNAL_CONCURRENCY = 32;
/** In-flight Redis bookkeeping calls (shown groups, last badge) per drained batch. */
export const NOTIFICATION_BOOKKEEPING_CONCURRENCY = 16;
/** How long phone alerts wait at most for the badges before going without them. */
const BADGE_HEAD_START_MS = 250;
export const NOTIFICATION_OUTBOX_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const NOTIFICATION_REGISTRATION_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_DELETE_BATCH = 1_000;
/** Ids per IN list (claim kick, access checks): far under the bind-parameter limit. */
const ID_CHUNK = 5_000;
/** A pass stops starting batches after this long; a backlog drains over several passes. */
const SWEEP_BUDGET_MS = 30_000;
/** Pause between delete batches, so the drain's writes interleave. */
const SWEEP_PAUSE_MS = 100;
/** The maintenance pass interval (contract §7). */
export const NOTIFICATION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const TERMINAL_STATUSES = ["sent", "skipped", "revoked", "dropped", "delivered", "suppressed", "quiet", "failed"] as const;

// ---------------------------------------------------------------------------
// Runtime seams
// ---------------------------------------------------------------------------

/** How long a desktop alert waits for its acks (only when the phone's silence rests on it). */
export const DESKTOP_ACK_TIMEOUT_MS = 3_000;

export interface NotificationDispatchRuntime {
  sleep(ms: number): Promise<void>;
  jitterMs(attempt: number): number;
  /** Runs drain work after the current turn (post-commit kicks). */
  schedule(work: () => Promise<void>): void;
  now(): number;
  /** How often a processing group renews its claim lease. */
  leaseRenewMs: number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** How long a desktop alert waits for acks (DESKTOP_ACK_TIMEOUT_MS). */
  desktopAckTimeoutMs: number;
}

const tasksInFlight = new Set<Promise<void>>();
const taskFailures: Error[] = [];

function scheduleTask(work: () => Promise<void>): void {
  const task = (async () => {
    await waitUntilNextTurn();
    await work();
  })();
  tasksInFlight.add(task);
  void task.then(
    () => { tasksInFlight.delete(task); },
    (error) => {
      tasksInFlight.delete(task);
      if (process.env.NODE_ENV === "test") taskFailures.push(error instanceof Error ? error : new Error(String(error)));
      console.error("[Notifications] Failed to dispatch queued notifications:", error);
    },
  );
}

export async function drainNotificationTasksForTests(): Promise<void> {
  while (tasksInFlight.size) await Promise.allSettled([...tasksInFlight]);
  if (taskFailures.length) throw new AggregateError(taskFailures.splice(0), "Notification background work failed");
}

registerDatabaseCloseHookForTests(drainNotificationTasksForTests);

function defaultRuntime(): NotificationDispatchRuntime {
  return {
    sleep: async (ms) => { await sleepTimer(ms); },
    jitterMs: (attempt) => RETRY_BASE_MS * attempt + randomInt(0, RETRY_BASE_MS),
    schedule: scheduleTask,
    now: () => Date.now(),
    leaseRenewMs: OUTBOX_LOCK_TIMEOUT_MS / 5,
    setInterval: (fn, ms) => setClockInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    desktopAckTimeoutMs: DESKTOP_ACK_TIMEOUT_MS,
  };
}

let runtime: NotificationDispatchRuntime = defaultRuntime();

export function __setNotificationDispatchRuntimeForTests(overrides: Partial<NotificationDispatchRuntime>): void {
  runtime = { ...runtime, ...overrides };
}

export function __resetNotificationDispatchRuntimeForTests(): void {
  runtime = defaultRuntime();
}

let afterClaimHookForTests: ((rows: NotificationOutboxRow[]) => Promise<void> | void) | null = null;

/** Test-only: runs after a claim and before the writer fence (race tests). */
export function __setAfterNotificationClaimForTests(hook: ((rows: NotificationOutboxRow[]) => Promise<void> | void) | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("notification claim hooks are test-only");
  afterClaimHookForTests = hook;
}

let socketServer: SocketServer | null = null;

/** The Socket.IO server the socket transports emit on (set once at startup). */
export function registerNotificationSocketServer(io: SocketServer | null): void {
  socketServer = io;
}

export function notificationSocketServer(): SocketServer | null {
  return socketServer;
}

let drainTracer: Tracer = noopTracer;

/** Drain exactly these rows after the current turn (enqueue's post-commit kick). */
export function scheduleNotificationDrain(ids: readonly string[]): void {
  const claimIds = [...ids];
  if (claimIds.length === 0) return;
  runtime.schedule(async () => {
    await runTracedDrain("post_commit_kick", () => drainNotificationRows(claimIds));
  });
}

// ---------------------------------------------------------------------------
// External delivery with retry
// ---------------------------------------------------------------------------

export type ExternalTransportName = "apns" | "fcm" | "webPush";

export interface ExternalTransportClassifier {
  isTerminalTargetError(err: unknown): boolean;
  isNonRetryable(err: unknown): boolean;
}

export interface NotificationFailure {
  provider: ExternalTransportName;
  reason: string;
  status: number | null;
  /**
   * Which kind of target failed, never which one: an APNs / FCM
   * registration's topic, environment and app version, a Web Push
   * subscription's push service host. No device token, endpoint path or key.
   */
  target?: NotificationTargetContext;
}

/** Diagnostic, non-secret identity of a delivery target (failure records and transport trace events). */
export interface NotificationTargetContext {
  topic?: string;
  env?: string;
  appVersion?: string | null;
  host?: string | null;
}

/** A registration's topic is a bundle id the route bounded to a safe shape; cut further for the record. */
const TARGET_FIELD_MAX = 64;

export function mobileTargetContext(registration: MobileRegistrationTarget): NotificationTargetContext {
  const appVersion = registration.appVersion?.slice(0, TARGET_FIELD_MAX) ?? null;
  return registration.provider === "apns"
    ? { topic: registration.topic.slice(0, TARGET_FIELD_MAX), env: registration.env, appVersion }
    : { env: registration.env, appVersion };
}

export function webTargetContext(subscription: WebPushSubscriptionTarget): NotificationTargetContext {
  return { host: webPushEndpointHostname(subscription.endpoint) };
}

function targetTraceAttrs(target: NotificationTargetContext | undefined): Record<string, string | null> {
  if (!target) return {};
  return {
    ...(target.topic !== undefined ? { target_topic: target.topic } : {}),
    ...(target.env !== undefined ? { target_env: target.env } : {}),
    ...(target.appVersion !== undefined ? { target_app_version: target.appVersion } : {}),
    ...(target.host !== undefined ? { target_host: target.host } : {}),
  };
}

export type ExternalDeliveryOutcome =
  | { outcome: "sent" }
  | { outcome: "skipped"; reason: string }
  /** The target can never receive again: the caller revokes / deletes it. */
  | { outcome: "terminal"; failure: NotificationFailure }
  | { outcome: "failed"; failure: NotificationFailure };

function failureStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const candidate = err as { statusCode?: unknown; response?: { status?: unknown } };
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (typeof candidate.response?.status === "number") return candidate.response.status;
  return null;
}

function failureReason(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown_error";
  const candidate = err as { statusCode?: unknown; reason?: unknown };
  if (typeof candidate.reason === "string" && candidate.reason) return candidate.reason.slice(0, 120);
  if (typeof candidate.statusCode === "number") return `status_${candidate.statusCode}`;
  return err instanceof Error ? err.name : "unknown_error";
}

/**
 * One delivery with bounded retries and jitter (was deliverMobilePushWithRetry).
 * Traces carry provider, attempt, reason code and HTTP status only, never a
 * token or content.
 */
export async function deliverExternalWithRetry(
  provider: ExternalTransportName,
  send: () => Promise<ExternalSendResult>,
  classifier: ExternalTransportClassifier,
  trace: Record<string, string | number | boolean | null> = {},
  target?: NotificationTargetContext,
): Promise<ExternalDeliveryOutcome> {
  // The target identity rides only on failures (where a readback needs it), never on every send.
  const attrs = { ...trace, ...targetTraceAttrs(target) };
  for (let attempt = 1; attempt <= NOTIFICATION_MAX_ATTEMPTS; attempt += 1) {
    const started = runtime.now();
    try {
      const result = await send();
      addTraceEvent("notification.transport.attempt", { ...trace, transport: provider, attempt, status: result.status, reason: result.reason ?? null, duration_ms: runtime.now() - started });
      return result.status === "sent" ? { outcome: "sent" } : { outcome: "skipped", reason: result.reason ?? "unknown" };
    } catch (err) {
      const durationMs = runtime.now() - started;
      const failure: NotificationFailure = { provider, reason: failureReason(err), status: failureStatus(err), ...(target ? { target } : {}) };
      if (classifier.isTerminalTargetError(err)) {
        addTraceEvent("notification.transport", { ...attrs, transport: provider, outcome: "revoked", attempt, reason: failure.reason, http_status: failure.status, duration_ms: durationMs });
        return { outcome: "terminal", failure };
      }
      if (attempt === NOTIFICATION_MAX_ATTEMPTS || classifier.isNonRetryable(err)) {
        addTraceEvent("notification.transport", { ...attrs, transport: provider, outcome: "failed", attempt, reason: failure.reason, http_status: failure.status, duration_ms: durationMs });
        return { outcome: "failed", failure };
      }
      const delay = runtime.jitterMs(attempt);
      addTraceEvent("notification.transport.retry_scheduled", { ...attrs, transport: provider, attempt, retry_delay_ms: delay, reason: failure.reason, http_status: failure.status, duration_ms: durationMs });
      await runtime.sleep(delay);
    }
  }
  return { outcome: "failed", failure: { provider, reason: "retries_exhausted", status: null, ...(target ? { target } : {}) } };
}

/**
 * Run tasks with at most `limit` in flight. Every task runs to completion even
 * if another fails (no worker keeps going against a caller that already
 * moved on); the first error is rethrown at the end.
 */
async function runBounded(work: ReadonlyArray<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  let firstError: { error: unknown } | null = null;
  const worker = async () => {
    while (next < work.length) {
      const task = work[next++]!;
      try {
        await task();
      } catch (error) {
        firstError ??= { error };
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(limit, work.length) }, worker));
  if (firstError) throw (firstError as { error: unknown }).error;
}

/** A send lane: sockets, or one push provider. */
type DeliveryLane = "socket" | ExternalTransportName;

/**
 * Runs each lane under its own bound, all lanes at once: a provider that
 * hangs until its deadline (APNs or FCM after a start, a slow Web Push
 * service) fills only its own lane, never the slots the other providers'
 * sends are queued for. Every lane runs to completion; the first error is
 * rethrown at the end.
 */
async function runLanes(
  work: ReadonlyArray<{ lane: DeliveryLane; task: () => Promise<void> }>,
  limit: number,
  onLaneDone?: (lane: DeliveryLane, ms: number) => void,
): Promise<void> {
  const lanes = new Map<DeliveryLane, Array<() => Promise<void>>>();
  for (const { lane, task } of work) {
    let tasks = lanes.get(lane);
    if (!tasks) lanes.set(lane, tasks = []);
    tasks.push(task);
  }
  let firstError: { error: unknown } | null = null;
  const started = runtime.now();
  // fanout-ok: at most four lanes (sockets, Web Push, APNs, FCM), each bounded by runBounded.
  await Promise.all([...lanes].map(([lane, tasks]) => runBounded(tasks, limit)
    .catch((error) => { firstError ??= { error }; })
    .finally(() => onLaneDone?.(lane, runtime.now() - started))));
  if (firstError) throw (firstError as { error: unknown }).error;
}

// ---------------------------------------------------------------------------
// Send ledger: one delivery per (row, transport, device)
// ---------------------------------------------------------------------------
//
// A group can be retried after a partial send (an error after some sockets or
// providers went out, or a crash). Each delivery first takes the key
// `notif-sent:<rowId>:<transport>:<device>` (SET NX, 1 day), so a retry
// skips what already went; a failed attempt gives its key back. A lookup
// failure lets the send go (a duplicate is better than a loss).

const SENT_LEDGER_PREFIX = "notif-sent:";
const SENT_LEDGER_TTL_SECONDS = 24 * 60 * 60;
const localSentLedger = new Map<string, number>();

function sentLedgerKey(rowId: string, transport: string, device: string): string {
  return `${SENT_LEDGER_PREFIX}${rowId}:${transport}:${device}`;
}

/** True when this delivery may go (nobody sent it yet). */
export async function claimNotificationSend(rowId: string, transport: string, device: string): Promise<boolean> {
  const key = sentLedgerKey(rowId, transport, device);
  if (!isRedisAvailable()) {
    const now = runtime.now();
    const until = localSentLedger.get(key);
    if (until !== undefined && until > now) return false;
    localSentLedger.set(key, now + SENT_LEDGER_TTL_SECONDS * 1000);
    return true;
  }
  try {
    return (await getRedis().set(key, "1", "EX", SENT_LEDGER_TTL_SECONDS, "NX")) === "OK";
  } catch {
    return true;
  }
}

async function releaseNotificationSend(rowId: string, transport: string, device: string): Promise<void> {
  const key = sentLedgerKey(rowId, transport, device);
  if (!isRedisAvailable()) {
    localSentLedger.delete(key);
    return;
  }
  await getRedis().del(key).catch(() => undefined);
}

export function __resetNotificationSendLedgerForTests(): void {
  localSentLedger.clear();
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** Live mobile registrations (not revoked, session family live with an unexpired session). */
export async function loadMobileRegistrations(
  userIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, MobileRegistrationTarget[]>> {
  const result = new Map<string, MobileRegistrationTarget[]>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return result;
  const rows = await executor
    .select({
      id: pushRegistrations.id,
      userId: pushRegistrations.userId,
      installationId: pushRegistrations.installationId,
      provider: pushRegistrations.provider,
      deviceToken: pushRegistrations.deviceToken,
      topic: pushRegistrations.topic,
      env: pushRegistrations.env,
      alertsEnabled: pushRegistrations.alertsEnabled,
      osPermission: pushRegistrations.osPermission,
      previewKeySet: pushRegistrations.previewKeySet,
      appVersion: pushRegistrations.appVersion,
    })
    .from(pushRegistrations)
    .innerJoin(sessionFamilies, and(eq(pushRegistrations.sessionFamilyId, sessionFamilies.id), isNull(sessionFamilies.revokedAt)))
    .where(and(
      inArray(pushRegistrations.provider, ["apns", "fcm"]),
      inArray(pushRegistrations.userId, unique),
      isNull(pushRegistrations.revokedAt),
      exists(
        executor
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.familyId, sessionFamilies.id), gt(sessions.expiresAt, new Date(runtime.now())))),
      ),
    ));
  for (const row of rows) {
    if (!row.userId) continue;
    const target: MobileRegistrationTarget = { ...row, userId: row.userId, previewKeySet: row.previewKeySet ?? 1 };
    const list = result.get(row.userId);
    if (list) list.push(target);
    else result.set(row.userId, [target]);
  }
  return result;
}

async function loadWebSubscriptions(userIds: readonly string[], executor: DatabaseExecutor): Promise<Map<string, WebPushSubscriptionTarget[]>> {
  const result = new Map<string, WebPushSubscriptionTarget[]>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return result;
  const rows = await executor
    .select({ id: pushSubscriptions.id, userId: pushSubscriptions.userId, endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.userId, unique));
  for (const row of rows) {
    const list = result.get(row.userId);
    if (list) list.push(row);
    else result.set(row.userId, [row]);
  }
  return result;
}

export function mobileDeviceAlertsAllowed(registration: Pick<MobileRegistrationTarget, "alertsEnabled" | "osPermission">): boolean {
  return registration.alertsEnabled && registration.osPermission !== "denied";
}

/** Revoke a registration whose token can never deliver again (kept from pushService). */
export async function revokeMobileRegistration(registrationId: string, reason: string, executor: DatabaseExecutor): Promise<void> {
  await executor
    .update(pushRegistrations)
    .set({
      userId: null,
      revokedUserId: sql<string | null>`coalesce(${pushRegistrations.userId}, ${pushRegistrations.revokedUserId})`,
      serverId: null,
      revokedAt: sql`now()`,
      revokedReason: reason,
      updatedAt: sql`now()`,
    })
    .where(eq(pushRegistrations.id, registrationId));
  addTraceEvent("push.registration.revoked", { registration_id: registrationId, reason });
}

/** Send one background push (sync / retract) to one registration. */
export async function sendMobileBackgroundPush(
  registration: MobileRegistrationTarget,
  push: MobileBackgroundPush,
  executor: DatabaseExecutor,
): Promise<ExternalDeliveryOutcome> {
  const outcome = registration.provider === "apns"
    ? await deliverExternalWithRetry("apns", () => apnsTransport.send(registration, apnsBackgroundRequest(push)), apnsTransport, { push_type: push.type }, mobileTargetContext(registration))
    : await deliverExternalWithRetry("fcm", () => fcmTransport.send(registration, fcmBackgroundMessage(push)), fcmTransport, { push_type: push.type }, mobileTargetContext(registration));
  if (outcome.outcome === "terminal") await revokeMobileRegistration(registration.id, outcome.failure.reason, executor);
  return outcome;
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

function claimablePredicate(staleLockedAt: Date) {
  return or(
    eq(notificationOutbox.status, "pending"),
    and(eq(notificationOutbox.status, "processing"), lt(notificationOutbox.lockedAt, staleLockedAt)),
  );
}

/**
 * The periodic drain's candidate read: pending rows and processing rows whose
 * lock went stale, oldest first. Served by the partial index
 * idx_mobile_push_outbox_active_created (pending/processing rows only).
 */
export function notificationOutboxDrainCandidatesQuery(executor: DatabaseExecutor, staleLockedAt: Date, batchSize: number) {
  return executor
    .select({ id: notificationOutbox.id })
    .from(notificationOutbox)
    .where(claimablePredicate(staleLockedAt))
    .orderBy(asc(notificationOutbox.createdAt))
    .limit(batchSize);
}

async function claimRows(ids: readonly string[] | null, batchSize: number): Promise<NotificationOutboxRow[]> {
  const db = getDb();
  const staleLockedAt = new Date(runtime.now() - OUTBOX_LOCK_TIMEOUT_MS);
  const candidates = (ids
    ? db.select({ id: notificationOutbox.id }).from(notificationOutbox)
      .where(and(inArray(notificationOutbox.id, [...ids]), claimablePredicate(staleLockedAt)))
    : notificationOutboxDrainCandidatesQuery(db, staleLockedAt, batchSize)
  ).for("update", { skipLocked: true });
  return db
    .update(notificationOutbox)
    .set({
      status: "processing",
      lockedAt: sql`now()`,
      attemptCount: sql`${notificationOutbox.attemptCount} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(inArray(notificationOutbox.id, candidates), claimablePredicate(staleLockedAt)))
    .returning();
}

// ---------------------------------------------------------------------------
// Event context
// ---------------------------------------------------------------------------

type ChannelRow = { id: string; serverId: string; type: "channel" | "private" | "joint" | "dm" | "thread" | "task"; name: string; parentMessageId: string | null; parentChannelId: string | null; taskId: string | null };

interface LoadedEvent {
  context: NotificationEventContext;
  /** The channel whose level / mute applies (a thread's parent), or null. */
  levelChannelId: string | null;
  threadChannelId: string | null;
  /** The message seq in levelChannelId (null for thread replies and notices). */
  levelChannelSeq: number | null;
  /** The conversation whose membership gates delivery (a thread's / task's parent); null = server membership only. */
  accessChannel: { id: string; type: ChannelRow["type"] } | null;
  /** A security notice (policy.ts): its payload says so; messages never are. */
  securityNotice?: boolean;
}

async function loadChannel(executor: DatabaseExecutor, channelId: string): Promise<ChannelRow | null> {
  const [row] = await executor
    .select({ id: channels.id, serverId: channels.serverId, type: channels.type, name: channels.name, parentMessageId: channels.parentMessageId, parentChannelId: channels.parentChannelId, taskId: channels.taskId })
    .from(channels)
    .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
    .limit(1);
  return row ?? null;
}

async function loadServerRow(executor: DatabaseExecutor, serverId: string) {
  const [row] = await executor.select({ id: servers.id, name: servers.name, slug: servers.slug }).from(servers).where(eq(servers.id, serverId)).limit(1);
  return row ?? null;
}

async function loadSenderName(executor: DatabaseExecutor, senderType: string, senderId: string, messageType: string): Promise<string> {
  if (messageType === "system") return "Raft";
  if (senderType === "user" && UUID_RE.test(senderId)) {
    const [row] = await executor.select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, senderId)).limit(1);
    return row?.displayName?.trim() || row?.name?.trim() || "Unknown sender";
  }
  if (senderType === "agent" && UUID_RE.test(senderId)) {
    const [row] = await executor.select({ name: agents.name, displayName: agents.displayName }).from(agents).where(eq(agents.id, senderId)).limit(1);
    return row?.displayName?.trim() || row?.name?.trim() || "Unknown sender";
  }
  return "Unknown sender";
}

/** A task conversation push lands on a message in the parent channel: the task's source message, else the latest. */
async function loadTaskAnchorMessageId(executor: DatabaseExecutor, parentChannelId: string, taskId: string | null): Promise<string | null> {
  const storageChannelId = await getMessageStorageChannelIdWithExecutor(executor, parentChannelId);
  if (taskId) {
    const [source] = await executor
      .select({ id: messages.id })
      .from(tasks)
      .innerJoin(messages, eq(messages.id, tasks.sourceMessageId))
      .where(and(eq(tasks.id, taskId), eq(messages.channelId, storageChannelId)))
      .limit(1);
    if (source) return source.id;
  }
  const [latest] = await executor.select({ id: messages.id }).from(messages).where(eq(messages.channelId, storageChannelId)).orderBy(desc(messages.seq)).limit(1);
  return latest?.id ?? null;
}

async function loadMessageNotice(
  executor: DatabaseExecutor,
  message: { messageType: string; systemSubtype: string | null; causalActorType: string | null; causalActorId: string | null },
  channel: ChannelRow,
): Promise<NotificationMessageNotice | undefined> {
  if (message.messageType !== "system" || !message.systemSubtype) return undefined;
  const event = systemMessageNotificationEvent(message.systemSubtype);
  if (event === "none") return undefined;
  if (event === "agent_action_required") {
    if (message.causalActorType !== "agent" || !message.causalActorId || !UUID_RE.test(message.causalActorId)) return undefined;
    const [agent] = await executor.select({ id: agents.id, name: agents.name, displayName: agents.displayName }).from(agents).where(eq(agents.id, message.causalActorId)).limit(1);
    return agent ? { type: "agent_attention", event, agent: { id: agent.id, name: agent.displayName?.trim() || agent.name } } : undefined;
  }
  const taskColumns = { id: tasks.id, number: tasks.taskNumber, title: tasks.title, status: tasks.status };
  let task: { id: string; number: number; title: string; status: string } | null = null;
  if (channel.type === "task" && channel.taskId) {
    [task = null] = await executor.select(taskColumns).from(tasks).where(eq(tasks.id, channel.taskId)).limit(1);
  } else if (channel.type === "thread" && channel.parentMessageId) {
    [task = null] = await executor.select(taskColumns).from(tasks).where(eq(tasks.messageId, channel.parentMessageId)).limit(1);
  }
  return { type: event, task };
}

async function loadMessageEvent(executor: DatabaseExecutor, row: NotificationOutboxRow, eventKey: string): Promise<LoadedEvent | null> {
  if (!row.messageId || !row.sourceChannelId) return null;
  const [message] = await executor
    .select({
      id: messages.id,
      seq: messages.seq,
      content: messages.content,
      messageType: messages.messageType,
      senderType: messages.senderType,
      senderId: messages.senderId,
      createdAt: messages.createdAt,
      systemSubtype: messages.systemSubtype,
      causalActorType: messages.causalActorType,
      causalActorId: messages.causalActorId,
    })
    .from(messages)
    .where(eq(messages.id, row.messageId))
    .limit(1);
  const channel = await loadChannel(executor, row.sourceChannelId);
  const server = await loadServerRow(executor, row.serverId);
  if (!message || !channel || !server) return null;
  const [attachmentRow] = await executor.select({ count: sql<number>`COUNT(*)` }).from(attachments).where(eq(attachments.messageId, message.id));
  const attachmentCount = Number(attachmentRow?.count ?? 0);
  const senderName = await loadSenderName(executor, message.senderType, message.senderId, message.messageType);
  const seq = row.messageSeq ?? message.seq;

  let conversation: NotificationConversation;
  let levelChannelId: string | null = channel.id;
  let threadChannelId: string | null = null;
  let levelChannelSeq: number | null = seq;
  let accessChannel: LoadedEvent["accessChannel"] = { id: channel.id, type: channel.type };
  if (channel.type === "thread") {
    let parentMessageId = channel.parentMessageId;
    let parentChannelId: string | null = null;
    if (parentMessageId) {
      const [parentMessage] = await executor.select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, parentMessageId)).limit(1);
      parentChannelId = parentMessage?.channelId ?? null;
    } else {
      // A joint thread's local projection has no parent message: its parent is
      // this server's projection of the joint channel.
      const projection = await getJointThreadProjectionByLocalThread(channel.id, row.serverId, executor);
      if (projection) {
        parentMessageId = projection.canonicalParentMessageId ?? null;
        parentChannelId = projection.localParentChannelId;
      }
    }
    const parent = parentChannelId ? await loadChannel(executor, parentChannelId) : null;
    // Losing a parent must not turn a private conversation into a server-only
    // notification. A joint projection can disappear during member removal.
    if (!parent) return null;
    conversation = { surface: "thread", threadChannelId: channel.id, parent, parentMessageId };
    accessChannel = { id: parent.id, type: parent.type };
    levelChannelId = parent.id;
    threadChannelId = channel.id;
    levelChannelSeq = null;
  } else if (channel.type === "task") {
    const parent = channel.parentChannelId ? await loadChannel(executor, channel.parentChannelId) : null;
    if (!parent) return null;
    const anchorMessageId = await loadTaskAnchorMessageId(executor, parent.id, channel.taskId);
    // The banner title `#12 Fix login`; a task that cannot be loaded keeps `Task in #chan`.
    const [task = null] = channel.taskId
      ? await executor.select({ number: tasks.taskNumber, title: tasks.title }).from(tasks).where(eq(tasks.id, channel.taskId)).limit(1)
      : [];
    conversation = { surface: "task", conversationChannelId: channel.id, parent, taskId: channel.taskId, task, anchorMessageId };
    accessChannel = { id: parent.id, type: parent.type };
    levelChannelId = parent.id;
    threadChannelId = channel.id;
    levelChannelSeq = null;
  } else {
    conversation = { surface: channel.type === "dm" ? "dm" : "channel", channelId: channel.id, channelName: channel.type === "dm" ? null : channel.name };
  }
  const notice = await loadMessageNotice(executor, message, channel);
  const senderType = message.messageType === "system" ? "system" : message.senderType === "agent" ? "agent" : message.senderType === "user" ? "user" : "system";
  return {
    context: {
      type: "message",
      eventKey,
      server,
      message: {
        id: message.id,
        seq,
        createdAt: message.createdAt,
        content: message.content,
        attachmentCount: Number.isFinite(attachmentCount) ? attachmentCount : 0,
        sender: { id: message.senderId, type: senderType, name: senderName },
      },
      conversation,
      ...(notice ? { notice } : {}),
    },
    levelChannelId,
    threadChannelId,
    levelChannelSeq,
    accessChannel,
  };
}

async function loadEvent(executor: DatabaseExecutor, row: NotificationOutboxRow, eventKey: string): Promise<LoadedEvent | null> {
  if (row.messageId) return loadMessageEvent(executor, row, eventKey);
  const payload = parseNotificationNoticePayload(row.payload);
  const server = await loadServerRow(executor, row.serverId);
  if (!payload || !server) return null;
  return {
    context: { type: "notice", eventKey, server, createdAt: row.activityAt, payload },
    levelChannelId: null,
    threadChannelId: null,
    levelChannelSeq: null,
    accessChannel: null,
    securityNotice: payload.securityNotice === true,
  };
}

/** Category of a row; rows from before the unified enqueue have none (derived from kind and mention). */
export function outboxRowCategory(row: Pick<NotificationOutboxRow, "category" | "kind" | "personalMention">): NotificationCategory {
  if (isNotificationCategory(row.category)) return row.category;
  if (row.kind === "dm") return "dm";
  if (row.personalMention) return "mention";
  if (row.kind === "thread" || row.kind === "task") return "thread";
  return "channel";
}

function eventKeyOf(row: NotificationOutboxRow): string {
  return row.eventKey ?? `message:${row.messageId}`;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function emptyCounts(): NotificationTransportCounts {
  return { desktop: 0, web: 0, mobileSocket: 0, apns: 0, fcm: 0, sync: 0, failed: 0, revoked: 0, skippedByPresence: [], skippedDeviceDisabled: 0, mobileDeferred: 0 };
}

/** Which computer path confirmed delivering this row (see phoneRestsOnComputer). */
interface ComputerConfirmation {
  desktop: boolean;
  web: boolean;
}


interface RowResult {
  status: "delivered" | "suppressed" | "quiet" | "failed" | "revoked";
  decision: string;
  counts: NotificationTransportCounts;
  firstFailure: NotificationFailure | null;
}

interface PreparedRow {
  row: NotificationOutboxRow;
  decision: NotificationDecision;
  account: NotificationAccountSettings;
  built: BuiltNotification | null;
}

function noteFailure(result: RowResult, failure: NotificationFailure) {
  result.counts.failed += 1;
  result.firstFailure ??= failure;
}

/**
 * Who of these receivers can no longer read the conversation (removed from a
 * private channel or DM, or from its thread's / task's parent) since the row
 * was written. Joint entries use the same current authority as channel reads,
 * including J membership and pending removals. Public channels need
 * only the server membership the policy checks.
 */
async function receiversWithoutAccess(
  executor: DatabaseExecutor,
  accessChannel: LoadedEvent["accessChannel"],
  userIds: readonly string[],
): Promise<Set<string>> {
  if (!accessChannel || userIds.length === 0) return new Set();
  if (accessChannel.type !== "dm" && accessChannel.type !== "private" && accessChannel.type !== "joint") return new Set();
  const jointEntry = accessChannel.type === "joint"
    ? await resolveJointHumanEntrySql({ localChannelIds: [accessChannel.id] }, executor)
    : null;
  const members = new Set<string>();
  for (let start = 0; start < userIds.length; start += ID_CHUNK) {
    const chunk = userIds.slice(start, start + ID_CHUNK);
    const rows = jointEntry
      ? await executor.select({ userId: users.id }).from(users)
        .where(and(inArray(users.id, chunk), jointEntry(sql`${accessChannel.id}::uuid`, users.id)))
      : await executor.select({ userId: channelHumans.userId }).from(channelHumans)
        .where(and(eq(channelHumans.channelId, accessChannel.id), inArray(channelHumans.userId, chunk)));
    for (const row of rows) members.add(row.userId);
  }
  return new Set(userIds.filter((userId) => !members.has(userId)));
}

/**
 * The claim lease: rows are ours while status = processing AND attempt_count
 * is the one our claim wrote (a reclaim after an expired lease increments it).
 * A group that is still sending renews locked_at, so a slow fan-out is not
 * reclaimed by another replica.
 */
function leasePredicate(rows: readonly NotificationOutboxRow[]) {
  const byAttempt = new Map<number, string[]>();
  for (const row of rows) {
    const list = byAttempt.get(row.attemptCount);
    if (list) list.push(row.id);
    else byAttempt.set(row.attemptCount, [row.id]);
  }
  return and(
    eq(notificationOutbox.status, "processing"),
    or(...[...byAttempt].map(([attempt, ids]) => and(eq(notificationOutbox.attemptCount, attempt), inArray(notificationOutbox.id, ids)))),
  );
}

async function renewLease(rows: readonly NotificationOutboxRow[]): Promise<void> {
  await getDb().update(notificationOutbox).set({ lockedAt: sql`now()` }).where(leasePredicate(rows));
}

function startLease(rows: readonly NotificationOutboxRow[]): () => void {
  const handle = runtime.setInterval(() => {
    renewLease(rows).catch((err) => console.warn("[Notifications] lease renewal failed:", err instanceof Error ? err.message : String(err)));
  }, runtime.leaseRenewMs);
  unrefTimer(handle);
  return () => runtime.clearInterval(handle);
}

/**
 * Wall-clock time of each phase of one group's dispatch, reported as one
 * `notification.dispatch.phases` trace event (`<phase>_ms`), so a slow drain
 * shows where it waited: the event / policy / device loads, the writer fence,
 * each send lane, the badge load and the result write.
 */
class DispatchPhases {
  private last = runtime.now();
  private readonly started = this.last;
  readonly ms: Record<string, number> = {};

  /** Time since the previous mark, booked to `phase`. */
  mark(phase: string): void {
    const now = runtime.now();
    this.add(phase, now - this.last);
    this.last = now;
  }

  add(phase: string, ms: number): void {
    this.ms[phase] = (this.ms[phase] ?? 0) + ms;
  }

  emit(rowCount: number, outcome: string): void {
    const attrs: Record<string, number | string> = { row_count: rowCount, outcome, total_ms: runtime.now() - this.started };
    for (const [phase, ms] of Object.entries(this.ms)) attrs[`${phase}_ms`] = ms;
    addTraceEvent("notification.dispatch.phases", attrs);
  }
}

async function dispatchGroup(rows: NotificationOutboxRow[]): Promise<void> {
  const phases = new DispatchPhases();
  let outcome = "error";
  const stopLease = startLease(rows);
  try {
    await dispatchLeasedGroup(rows, phases);
    outcome = "ok";
  } finally {
    stopLease();
    phases.emit(rows.length, outcome);
  }
}

async function dispatchLeasedGroup(rows: NotificationOutboxRow[], phases: DispatchPhases): Promise<void> {
  const db = getDb();
  const now = runtime.now();
  const first = rows[0]!;
  const eventKey = eventKeyOf(first);
  const event = await loadEvent(db, first, eventKey);
  phases.mark("load_event");
  if (!event) {
    await writeResults(rows.map((row) => ({ row, result: { status: "revoked", decision: "suppressed:event_missing", counts: emptyCounts(), firstFailure: null } })));
    return;
  }
  const userIds = [...new Set(rows.map((row) => row.receiverId))];
  const [prefs, noAccess, multiServer] = await Promise.all([
    loadNotificationPolicyPrefs(db, {
      userIds,
      serverIds: [...new Set(rows.map((row) => row.serverId))],
      channelIds: event.levelChannelId ? [event.levelChannelId] : [],
      threadChannelIds: event.threadChannelId ? [event.threadChannelId] : [],
    }),
    receiversWithoutAccess(db, event.accessChannel, userIds),
    // Who is in 2+ servers: only they see the server label (envelope.ts).
    loadMultiServerUserIds(db, userIds),
  ]);
  phases.mark("policy");
  const nowDate = new Date(now);
  const prepared: PreparedRow[] = rows.map((row) => {
    const category = outboxRowCategory(row);
    const account = prefs.account.get(row.receiverId) ?? DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS;
    if (noAccess.has(row.receiverId)) {
      return { row, decision: { kind: "suppressed", reason: "no_access" }, account, built: null };
    }
    if (now - row.activityAt.getTime() > NOTIFICATION_STALE_AFTER_MS) {
      return { row, decision: { kind: "suppressed", reason: "stale" }, account, built: null };
    }
    const policyRow: NotificationPolicyRow = {
      receiverId: row.receiverId,
      serverId: row.serverId,
      category,
      personal: row.personalMention,
      levelChannelId: event.levelChannelId,
      threadChannelId: event.threadChannelId,
      levelChannelSeq: event.levelChannelSeq,
      mentioned: row.personalMention,
      securityNotice: event.securityNotice,
    };
    const decision = decide(policyRow, prefs, nowDate, DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS);
    const built = decision.kind === "notify"
      ? buildNotification(event.context, { category, personal: row.personalMention, multiServer: multiServer.has(row.receiverId) }, account)
      : null;
    return { row, decision, account, built };
  });
  const notifyUserIds = prepared.filter((entry) => entry.decision.kind === "notify").map((entry) => entry.row.receiverId);
  // A stale or quiet event still keeps the phone badge right.
  const syncUserIds = prepared
    .filter((entry) => entry.decision.kind === "quiet" || (entry.decision.kind === "suppressed" && entry.decision.reason === "stale"))
    .map((entry) => entry.row.receiverId);
  const mobileUserIds = [...new Set([...notifyUserIds, ...syncUserIds])];
  const [presence, registrations, subscriptions] = await Promise.all([
    loadNotificationPresence(notifyUserIds, now),
    loadMobileRegistrations(mobileUserIds, db),
    loadWebSubscriptions(notifyUserIds, db),
  ]);
  phases.mark("devices");
  const badgeUsers = mobileUserIds.filter((userId) => (registrations.get(userId)?.length ?? 0) > 0);
  const lastBadges = await loadLastSentBadges(badgeUsers);
  phases.mark("last_badges");

  await afterClaimHookForTests?.(rows);

  // The writer-fence check up front: a channel conversion revokes rows under
  // this fence, so a row revoked before it is not published.
  // Reload the event and recheck access after preparation: a completed removal
  // or deletion while devices/presence loaded must not publish cached content.
  // A missing or changed parent cannot inherit the old access decision. Provider I/O
  // runs outside any transaction (a large fan-out must not hold a
  // pooled connection open while it talks to APNs / FCM / Web Push).
  const readLive = async (executor: DatabaseExecutor) => {
    const current = await executor
      .update(notificationOutbox)
      .set({ lockedAt: sql`now()` })
      .where(leasePredicate(rows))
      .returning({ id: notificationOutbox.id });
    const currentEvent = await loadEvent(executor, first, eventKey);
    const eventPresent = currentEvent !== null
      && currentEvent.accessChannel?.id === event.accessChannel?.id
      && currentEvent.accessChannel?.type === event.accessChannel?.type
      && currentEvent.threadChannelId === event.threadChannelId;
    const noAccess = eventPresent
      ? await receiversWithoutAccess(executor, currentEvent.accessChannel, userIds)
      : new Set<string>();
    return { ids: new Set(current.map((entry) => entry.id)), eventPresent, noAccess };
  };
  const live = first.sourceChannelId ? await withChannelWriterFence(first.sourceChannelId, readLive) : await readLive(db);
  phases.mark("fence");
  if (!live.eventPresent) {
    await writeResults(rows.filter((row) => live.ids.has(row.id)).map((row) => ({ row, result: {
      status: "revoked", decision: "suppressed:event_missing", counts: emptyCounts(), firstFailure: null,
    } })));
    return;
  }
  const authorized = prepared.filter((entry) => live.ids.has(entry.row.id)).map<PreparedRow>((entry) =>
    live.noAccess.has(entry.row.receiverId)
      ? { ...entry, decision: { kind: "suppressed", reason: "no_access" }, built: null }
      : entry);
  addTraceEvent("notification.decision", {
    event_kind: event.context.type,
    row_count: authorized.length,
    notify_count: authorized.filter((entry) => entry.decision.kind === "notify").length,
    quiet_count: authorized.filter((entry) => entry.decision.kind === "quiet").length,
    suppressed_count: authorized.filter((entry) => entry.decision.kind === "suppressed").length,
  });
  const results = await deliverPrepared(authorized, {
    presence,
    registrations,
    subscriptions,
    badgeUsers,
    lastBadges,
    now,
  }, phases);
  await writeResults(results);
  phases.mark("write");
}

interface DeliveryInputs {
  presence: Awaited<ReturnType<typeof loadNotificationPresence>>;
  registrations: Map<string, MobileRegistrationTarget[]>;
  subscriptions: Map<string, WebPushSubscriptionTarget[]>;
  /** Receivers with a phone: their badges load while the sends go out. */
  badgeUsers: string[];
  lastBadges: Map<string, number>;
  now: number;
}

/** Take the ledger key, send, and give the key back when nothing went out. */
async function sendOnce(
  rowId: string,
  transport: string,
  device: string,
  send: () => Promise<ExternalDeliveryOutcome>,
): Promise<ExternalDeliveryOutcome | null> {
  if (!(await claimNotificationSend(rowId, transport, device))) return null;
  let outcome: ExternalDeliveryOutcome;
  try {
    outcome = await send();
  } catch (error) {
    await releaseNotificationSend(rowId, transport, device);
    throw error;
  }
  if (outcome.outcome !== "sent") await releaseNotificationSend(rowId, transport, device);
  return outcome;
}

async function deliverPrepared(
  prepared: PreparedRow[],
  inputs: DeliveryInputs,
  phases?: DispatchPhases,
): Promise<Array<{ row: NotificationOutboxRow; result: RowResult }>> {
  phases?.mark("prepare");
  const db = getDb();
  const io = socketServer;
  const appUrl = getConfiguredAppUrl();
  const external: Array<{ lane: DeliveryLane; task: () => Promise<void> }> = [];
  const output: Array<{ row: NotificationOutboxRow; result: RowResult }> = [];
  const shownGroupsByUser = new Map<string, Set<string>>();
  const sentBadgeByUser = new Map<string, number>();
  /** Registrations whose alert already carried the badge (they need no sync). */
  const alertedWithBadge = new Set<string>();
  /** Syncs to send once the user's badge is known (quiet, stale, plan-excluded, or an alert that went without one). */
  const pendingSyncs: Array<{ userId: string; serverId: string; result: RowResult; registrations: MobileRegistrationTarget[] }> = [];
  /** Desktop ack waits of this group, awaited once after the sends (never inside a lane). */
  const ackWaits: Array<Promise<void>> = [];
  /** Rows whose quiet phone rests on a computer path; their phone alert tasks run if none confirmed. */
  const phoneFallbacks: Array<{
    row: NotificationOutboxRow;
    result: RowResult;
    confirmation: ComputerConfirmation;
    held: boolean;
    tasks: Array<{ lane: DeliveryLane; task: () => Promise<void> }>;
  }> = [];
  /** Phone alerts held back by the account's mobileDelay (the phones get the badge sync now). */
  const deferrals: Array<{ row: NotificationOutboxRow; deferUntil: number; delayMs: number }> = [];

  // Badges load while the sends go out; an alert carries the badge when it is
  // ready, otherwise the badge follows in a sync.
  const badges = new Map<string, NotificationBadge | undefined>();
  const badgeLoad = loadNotificationBadges(inputs.badgeUsers, db, (userId, badge) => { badges.set(userId, badge); })
    .catch((err) => { console.warn("[Notifications] badge load failed:", err instanceof Error ? err.message : String(err)); });
  // Phone alerts give the badges a short head start (sockets and Web Push do
  // not wait at all); after it, an alert goes without its badge and the badge
  // follows in a sync, so a large fan-out never waits on every badge.
  let headStartTimer: ReturnType<typeof setTimeout> | undefined;
  const badgeHeadStart = Promise.race([
    badgeLoad,
    new Promise<void>((resolve) => { headStartTimer = setTimeout(resolve, BADGE_HEAD_START_MS); }),
  ]).finally(() => clearTimeout(headStartTimer));

  for (const entry of prepared) {
    const { row, decision } = entry;
    const userId = row.receiverId;
    const result: RowResult = {
      status: decision.kind === "notify" ? "delivered" : decision.kind === "quiet" ? "quiet" : "suppressed",
      decision: notificationDecisionLabel(decision),
      counts: emptyCounts(),
      firstFailure: null,
    };
    output.push({ row, result });
    const mobile = inputs.registrations.get(userId) ?? [];
    if (decision.kind !== "notify" || !entry.built) {
      if (decision.kind === "quiet" || (decision.kind === "suppressed" && decision.reason === "stale")) {
        pendingSyncs.push({ userId, serverId: row.serverId, result, registrations: mobile });
      }
      continue;
    }
    const built = entry.built;
    const webSubscriptions = inputs.subscriptions.get(userId) ?? [];
    const presence = inputs.presence.get(userId);
    // Only a path that can deliver now may count as the computer in use (the plan's invariant).
    const plan = planNotificationDevices(presence, inputs.now, entry.account.mobileDelay, {
      webPushEndpointHashes: appUrl && webPushTransport.isConfigured()
        ? new Set(webSubscriptions.map((subscription) => pushEndpointHash(subscription.endpoint)))
        : new Set(),
      desktopSocket: Boolean(io),
    });
    // The phone stays quiet (or held) on the strength of a computer path: that
    // path must confirm it delivered, else the phone alerts after the sends.
    const phoneRestsOnComputer = !plan.mobileAlert && (plan.desktop || plan.webPush);
    const confirmation: ComputerConfirmation = { desktop: false, web: false };
    // An all-ack-capable desktop must ack; an older client is trusted as before.
    const desktopMustAck = phoneRestsOnComputer && presence?.desktop?.confirmable === true;
    // Only the computer in use can confirm: acks from its active sockets,
    // Web Push sent to an active browser's own subscription.
    const activeDesktopSockets = new Set(presence?.desktop?.ackSocketIds ?? []);
    const activeBrowsers = new Set(presence?.web?.pushEndpointHashes ?? []);

    if (io) {
      if (plan.desktop) {
        external.push({ lane: "socket", task: desktopMustAck
          ? async () => {
            // Emitted at once; the ack wait runs beside the other sends and is
            // awaited once for the whole group (ackWaits), so neither this lane
            // nor the mobile socket banners queue behind it. The ledger key is
            // written only once an active socket acked: a retry after a crash
            // or a 0-ack attempt emits again and can still fall back.
            const acked = emitDesktopNotificationWithAck(io, userId, built.envelope, runtime.desktopAckTimeoutMs)
              .then(async (responders) => {
                if (responders.some((socketId) => activeDesktopSockets.has(socketId))) {
                  confirmation.desktop = true;
                  await claimNotificationSend(row.id, "desktop", "socket");
                } else {
                  result.counts.desktopUnconfirmed = (result.counts.desktopUnconfirmed ?? 0) + 1;
                }
              });
            ackWaits.push(acked);
            result.counts.desktop += 1;
          }
          : async () => {
            if (!(await claimNotificationSend(row.id, "desktop", "socket"))) {
              // Sent by an earlier attempt: trusted (an older client), as before.
              confirmation.desktop = true;
              return;
            }
            try {
              emitDesktopNotification(io, userId, built.envelope);
              confirmation.desktop = true;
            } catch (error) {
              await releaseNotificationSend(row.id, "desktop", "socket");
              throw error;
            }
            result.counts.desktop += 1;
          } });
      } else {
        result.counts.skippedByPresence.push("desktop");
      }
      if (plan.mobileSocket) {
        external.push({ lane: "socket", task: async () => {
          if (!(await claimNotificationSend(row.id, "mobileSocket", "socket"))) return;
          try {
            emitMobileNotification(io, userId, mobileSocketPayload(built, appUrl ?? "", { phoneAlert: plan.mobileAlert }));
          } catch (error) {
            await releaseNotificationSend(row.id, "mobileSocket", "socket");
            throw error;
          }
          result.counts.mobileSocket += 1;
        } });
      }
    }

    if (webSubscriptions.length > 0) {
      if (!plan.webPush) {
        result.counts.skippedByPresence.push("web");
      } else if (appUrl && webPushTransport.isConfigured()) {
        const payload = webPushPayload(built, appUrl);
        for (const subscription of webSubscriptions) {
          external.push({ lane: "webPush", task: async () => {
            const outcome = await sendOnce(row.id, "webPush", subscription.id, () =>
              deliverExternalWithRetry("webPush", () => webPushTransport.send(subscription, payload), webPushTransport, {}, webTargetContext(subscription)));
            // Only the browser in use confirms the computer has it.
            const reachesActiveBrowser = activeBrowsers.has(pushEndpointHash(subscription.endpoint));
            if (!outcome) {
              if (reachesActiveBrowser) confirmation.web = true; // sent by an earlier attempt of this row
              return;
            }
            if (outcome.outcome === "sent") {
              result.counts.web += 1;
              if (reachesActiveBrowser) confirmation.web = true;
            } else if (outcome.outcome === "terminal") {
              await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
              result.counts.revoked += 1;
              result.firstFailure ??= outcome.failure;
            } else if (outcome.outcome === "failed") noteFailure(result, outcome.failure);
          } });
        }
      }
    }

    const delayMs = notificationMobileDelayMs(entry.account.mobileDelay);
    if (plan.mobileDeferUntil !== null && delayMs !== null && mobile.some(mobileDeviceAlertsAllowed)) {
      deferrals.push({ row, deferUntil: plan.mobileDeferUntil, delayMs });
      result.counts.mobileDeferred += 1;
    }
    const alertTargets = plan.mobileAlert ? mobile.filter(mobileDeviceAlertsAllowed) : [];
    const syncTargets = mobile.filter((registration) => !alertTargets.includes(registration));
    if (!plan.mobileAlert && mobile.length > 0) result.counts.skippedByPresence.push("mobile");
    result.counts.skippedDeviceDisabled += plan.mobileAlert ? mobile.length - alertTargets.length : 0;
    const alertedWithoutBadge: MobileRegistrationTarget[] = [];
    const alertPhone = (registration: MobileRegistrationTarget) => async () => {
        // Whatever badge is ready by now; otherwise the alert goes without one.
        await badgeHeadStart;
        const userBadge = badges.get(userId);
        const badge = alertBadge(userBadge?.total);
        const serverBadge = serverBadgeOf(userBadge, row.serverId);
        const outcome = await sendOnce(row.id, registration.provider, registration.id, () => registration.provider === "apns"
          ? deliverExternalWithRetry("apns", () => apnsTransport.send(registration, apnsAlertRequest(built, badge, { serverBadge, previewKeySet: registration.previewKeySet })), apnsTransport, { category: built.envelope.category }, mobileTargetContext(registration))
          : deliverExternalWithRetry("fcm", () => fcmTransport.send(registration, fcmAlertMessage(built, badge, { serverBadge, previewKeySet: registration.previewKeySet })), fcmTransport, { category: built.envelope.category }, mobileTargetContext(registration)));
        if (!outcome) return;
        if (outcome.outcome === "sent") {
          if (registration.provider === "apns") result.counts.apns += 1;
          else result.counts.fcm += 1;
          let groups = shownGroupsByUser.get(userId);
          if (!groups) shownGroupsByUser.set(userId, groups = new Set());
          groups.add(built.envelope.groupKey);
          if (badge !== undefined) {
            sentBadgeByUser.set(userId, badge);
            alertedWithBadge.add(registration.id);
          } else alertedWithoutBadge.push(registration);
        } else if (outcome.outcome === "terminal") {
          await revokeMobileRegistration(registration.id, outcome.failure.reason, db);
          result.counts.revoked += 1;
          result.firstFailure ??= outcome.failure;
        } else if (outcome.outcome === "failed") {
          noteFailure(result, outcome.failure);
        }
    };
    for (const registration of alertTargets) external.push({ lane: registration.provider, task: alertPhone(registration) });
    if (phoneRestsOnComputer) {
      const fallbackTargets = mobile.filter(mobileDeviceAlertsAllowed);
      if (fallbackTargets.length > 0) phoneFallbacks.push({ row, result, confirmation, held: plan.mobileDeferUntil !== null, tasks: fallbackTargets.map((registration) => ({ lane: registration.provider, task: alertPhone(registration) })) });
    }
    pendingSyncs.push({ userId, serverId: row.serverId, result, registrations: syncTargets });
    // Filled in by the alert tasks above; read after they ran.
    pendingSyncs.push({ userId, serverId: row.serverId, result, registrations: alertedWithoutBadge });
  }

  // Durable before any provider call: a crash after this still alerts the phone later.
  // The marker first, so a read racing the insert still cancels (retraction.ts).
  if (deferrals.length > 0) {
    await markHeldPhoneAlerts(deferrals.map(({ row }) => row.receiverId)).catch((err) => {
      // Without the marker a read skips the immediate cancel for this user;
      // the held alert is still skipped by the fire-time read check.
      console.warn("[Notifications] held-alert marker failed:", err instanceof Error ? err.message : String(err));
    });
  }
  await recordMobileDeferrals(db, deferrals);
  phases?.mark("record_deferrals");

  let sendError: { error: unknown } | null = null;
  await runLanes(external, NOTIFICATION_EXTERNAL_CONCURRENCY, (lane, ms) => phases?.add(`lane_${lane}`, ms))
    .catch((error) => { sendError = { error }; });
  phases?.mark("sends");
  // Every desktop ack of the group at once: at most one ack timeout per group.
  // fanout-ok: awaits promises the socket lane already started (one emit each, bounded by the group); the map only attaches a catch.
  await Promise.all(ackWaits.map((wait) => wait.catch((error) => { sendError ??= { error }; })));
  phases?.mark("desktop_acks");

  // Never alert nowhere: a phone kept quiet for a computer path that did not
  // confirm (no desktop ack, every Web Push send failed) alerts now, and its
  // held alert (if any) ends.
  const fallbackTasks: Array<{ lane: DeliveryLane; task: () => Promise<void> }> = [];
  for (const fallback of phoneFallbacks) {
    if (fallback.confirmation.desktop || fallback.confirmation.web) continue;
    fallback.result.counts.mobileFallback = (fallback.result.counts.mobileFallback ?? 0) + 1;
    fallback.result.counts.skippedByPresence = fallback.result.counts.skippedByPresence.filter((kind) => kind !== "mobile");
    if (fallback.held) {
      fallbackTasks.push({ lane: "socket", task: () => finishMobileDeferralOfOutbox(db, fallback.row.id, "skipped", "computer_unconfirmed_sent", runtime.now()) });
    }
    fallbackTasks.push(...fallback.tasks);
  }
  if (fallbackTasks.length > 0) {
    await runLanes(fallbackTasks, NOTIFICATION_EXTERNAL_CONCURRENCY, (lane, ms) => phases?.add(`fallback_lane_${lane}`, ms))
      .catch((error) => { sendError ??= { error }; });
    phases?.mark("phone_fallbacks");
  }

  // Badge syncs, once the badges are in.
  await badgeLoad;
  phases?.mark("badge_wait");
  const syncs: Array<{ lane: DeliveryLane; task: () => Promise<void> }> = [];
  // One sync per user (several rows / device groups of one user share it).
  const syncByUser = new Map<string, (typeof pendingSyncs)[number]>();
  for (const sync of pendingSyncs) {
    const merged = syncByUser.get(sync.userId);
    if (!merged) syncByUser.set(sync.userId, { ...sync, registrations: [...sync.registrations] });
    else for (const registration of sync.registrations) if (!merged.registrations.includes(registration)) merged.registrations.push(registration);
  }
  for (const sync of syncByUser.values()) {
    if (sync.registrations.length === 0) continue;
    const userBadge = badges.get(sync.userId);
    if (userBadge === undefined) continue;
    const badge = userBadge.total;
    // Only when the badge changed since the phones last got it.
    if (inputs.lastBadges.get(sync.userId) === badge) continue;
    const targets = sync.registrations.filter((registration) => !alertedWithBadge.has(registration.id));
    if (targets.length === 0) continue;
    sentBadgeByUser.set(sync.userId, badge);
    const serverBadge = serverBadgeOf(userBadge, sync.serverId);
    for (const registration of targets) {
      syncs.push({ lane: registration.provider, task: async () => {
        const outcome = await sendMobileBackgroundPush(registration, { type: "sync", badge, serverId: sync.serverId, serverBadge }, db);
        if (outcome.outcome === "sent") sync.result.counts.sync += 1;
        else if (outcome.outcome === "terminal") { sync.result.counts.revoked += 1; sync.result.firstFailure ??= outcome.failure; }
        else if (outcome.outcome === "failed") noteFailure(sync.result, outcome.failure);
      } });
    }
  }
  await runLanes(syncs, NOTIFICATION_EXTERNAL_CONCURRENCY, (lane, ms) => phases?.add(`sync_lane_${lane}`, ms))
    .catch((error) => { sendError ??= { error }; });
  phases?.mark("syncs");

  // Redis bookkeeping is not part of the authority. One call per receiver, so
  // bounded: a message to many people must not open a call per receiver at once.
  const bookkeeping: Array<() => Promise<void>> = [];
  for (const [userId, groups] of shownGroupsByUser) bookkeeping.push(() => recordShownGroups(userId, [...groups]));
  for (const [userId, badge] of sentBadgeByUser) bookkeeping.push(() => rememberSentBadge(userId, badge));
  void mapWithConcurrency(bookkeeping, NOTIFICATION_BOOKKEEPING_CONCURRENCY, (task) => task()).catch(() => undefined);
  // A failed task leaves the group to the retry; the ledger skips what went.
  if (sendError) throw (sendError as { error: unknown }).error;

  for (const { result } of output) {
    if (result.status !== "delivered") continue;
    const { counts } = result;
    const sent = counts.desktop + counts.web + counts.mobileSocket + counts.apns + counts.fcm;
    if (sent === 0 && counts.failed > 0) result.status = "failed";
    else if (sent === 0 && counts.revoked > 0) result.status = "revoked";
  }
  for (const { row, result } of output) {
    addTraceEvent("notification.transport.summary", {
      outbox_id: row.id,
      category: outboxRowCategory(row),
      decision: result.decision,
      desktop: result.counts.desktop,
      web: result.counts.web,
      mobile_socket: result.counts.mobileSocket,
      apns: result.counts.apns,
      fcm: result.counts.fcm,
      sync: result.counts.sync,
      failed: result.counts.failed,
      revoked: result.counts.revoked,
      skipped_presence: result.counts.skippedByPresence.join(","),
      mobile_deferred: result.counts.mobileDeferred,
    });
  }
  return output;
}

/** One UPDATE per distinct result, guarded by the claim lease. */
async function writeResults(results: Array<{ row: NotificationOutboxRow; result: RowResult }>): Promise<void> {
  const db = getDb();
  const finishedAt = runtime.now();
  const batches = new Map<string, { result: RowResult; latencyMs: number; rows: NotificationOutboxRow[] }>();
  for (const { row, result } of results) {
    const latencyMs = Math.max(0, Math.min(2_147_483_647, Math.round(finishedAt - row.activityAt.getTime())));
    const key = `${JSON.stringify(result)}\0${latencyMs}`;
    const batch = batches.get(key);
    if (batch) batch.rows.push(row);
    else batches.set(key, { result, latencyMs, rows: [row] });
  }
  for (const { result, latencyMs, rows } of batches.values()) {
    const failure = result.firstFailure;
    await db
      .update(notificationOutbox)
      .set({
        status: result.status,
        decision: result.decision,
        transports: result.counts as unknown as Record<string, unknown>,
        firstFailure: failure as unknown as Record<string, unknown> | null,
        lastError: failure ? `${failure.provider} ${failure.reason}${failure.status === null ? "" : ` http=${failure.status}`}`.slice(0, 200) : null,
        latencyMs,
        lockedAt: null,
        processedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(leasePredicate(rows));
  }
}

async function releaseAfterError(rows: NotificationOutboxRow[], err: unknown): Promise<void> {
  const db = getDb();
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  for (const row of rows) {
    const next = row.attemptCount >= NOTIFICATION_MAX_ATTEMPTS ? "failed" : "pending";
    await db
      .update(notificationOutbox)
      .set({
        status: next,
        lastError: message.length > 500 ? `${message.slice(0, 497)}...` : message,
        lockedAt: null,
        processedAt: next === "failed" ? sql`now()` : null,
        updatedAt: sql`now()`,
      })
      .where(leasePredicate([row]));
  }
  addTraceEvent("notification.dispatch.error", { row_count: rows.length, error_class: errorClassOf(err) });
}

function groupRows(rows: NotificationOutboxRow[]): NotificationOutboxRow[][] {
  const groups = new Map<string, NotificationOutboxRow[]>();
  for (const row of rows) {
    const key = `${eventKeyOf(row)}\0${row.sourceChannelId ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()];
}

async function processClaimed(rows: NotificationOutboxRow[]): Promise<number> {
  let processed = 0;
  for (const group of groupRows(rows)) {
    try {
      await dispatchGroup(group);
      processed += group.length;
    } catch (err) {
      console.error("[Notifications] dispatch failed:", err);
      await releaseAfterError(group, err);
    }
  }
  return processed;
}

/** A claim, reported with its duration (`notification.claim`). */
async function timedClaim(claim: () => Promise<NotificationOutboxRow[]>): Promise<NotificationOutboxRow[]> {
  const started = runtime.now();
  const rows = await claim();
  addTraceEvent("notification.claim", { claimed_count: rows.length, duration_ms: runtime.now() - started });
  return rows;
}

/** Claim and dispatch exactly these rows (those still pending). */
export async function drainNotificationRows(ids: readonly string[]): Promise<{ claimed: number; processed: number }> {
  let claimed = 0;
  let processed = 0;
  // Chunked like the insert: a large fan-out's ids would pass the bind-parameter limit in one IN list.
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const chunk = ids.slice(start, start + ID_CHUNK);
    const rows = await timedClaim(() => claimRows(chunk, chunk.length));
    claimed += rows.length;
    processed += await processClaimed(rows);
  }
  return { claimed, processed };
}

/** Claim and dispatch the oldest claimable rows (the periodic worker). */
export async function drainNotificationOutbox(batchSize = OUTBOX_BATCH_SIZE): Promise<{ claimed: number; processed: number }> {
  const rows = await timedClaim(() => claimRows(null, batchSize));
  return { claimed: rows.length, processed: await processClaimed(rows) };
}

async function runTracedDrain(
  trigger: "startup" | "interval_worker" | "post_commit_kick",
  drain: () => Promise<{ claimed: number; processed: number }>,
) {
  const span = drainTracer.startSpan("server.notification.outbox.drain", { surface: "server", kind: "internal", attrs: { trigger } });
  try {
    const result = await runWithTraceSpan(span, drain, drainTracer);
    span.end("ok", { attrs: { claimed_count: result.claimed, processed_count: result.processed } });
    return result;
  } catch (error) {
    const errorClass = errorClassOf(error);
    span.addEvent("error", { error_class: errorClass });
    span.end("error", { attrs: { error_class: errorClass } });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Daily sweep
// ---------------------------------------------------------------------------

/**
 * One sweep step in its own short transaction, under the pass's advisory lock
 * (null: another replica holds it). The pass used to be one transaction: up to
 * 100 deletes of 1,000 rows, then the revoke, then the deferrals, holding the
 * revoked registrations' row locks and the database's xmin for the whole pass
 * (30-80 s on production, 2026-11-05, #triage:#142).
 */
async function sweepStep<T>(work: (tx: DatabaseExecutor) => Promise<T>): Promise<T | null> {
  return getDb().transaction(async (tx) => {
    const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${NOTIFICATION_SWEEP_LOCK.classId}, ${NOTIFICATION_SWEEP_LOCK.objectId}) AS acquired`);
    const acquired = (lock.rows[0] as { acquired?: boolean } | undefined)?.acquired === true;
    if (!acquired || sweepLockHeldElsewhereForTests) return null;
    await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
    return work(tx);
  });
}

/** Where the next pass starts in TERMINAL_STATUSES, so a backlog in one status cannot starve the others. */
let sweepStatusOffset = 0;

type TerminalSweep = { deleted: number; budgetSpent: boolean; lockLost: boolean };

/**
 * Terminal rows older than the retention, oldest first per status through
 * idx_mobile_push_outbox_pending (status, created_at), one short transaction
 * per batch with a pause between batches, until they run out or the pass's
 * time budget does (a backlog drains over several passes; each pass starts at
 * the next status). Null when another replica holds the lock before the first
 * batch.
 */
async function sweepTerminalRows(now: number, options: SweepOptions): Promise<TerminalSweep | null> {
  const cutoff = new Date(now - NOTIFICATION_OUTBOX_RETENTION_MS);
  const startedAt = runtime.now();
  const start = sweepStatusOffset % TERMINAL_STATUSES.length;
  sweepStatusOffset = start + 1;
  let deleted = 0;
  let first = true;
  for (let index = 0; index < TERMINAL_STATUSES.length; index += 1) {
    const status = TERMINAL_STATUSES[(start + index) % TERMINAL_STATUSES.length]!;
    for (;;) {
      if (options.shouldStop?.()) return { deleted, budgetSpent: false, lockLost: false };
      const removed = await sweepStep(async (tx) => (await tx.execute(sql`
        DELETE FROM ${notificationOutbox}
        WHERE ctid = ANY(ARRAY(
          SELECT ctid FROM ${notificationOutbox}
          WHERE status = ${status} AND created_at < ${cutoff}
          ORDER BY created_at
          LIMIT ${options.batchSize}
          FOR UPDATE SKIP LOCKED
        ))
        RETURNING 1
      `)).rows.length);
      if (removed === null) return first ? null : { deleted, budgetSpent: false, lockLost: true };
      first = false;
      deleted += removed;
      if (runtime.now() - startedAt >= options.budgetMs) return { deleted, budgetSpent: true, lockLost: false };
      if (removed < options.batchSize) break;
      if (options.pauseMs > 0) await runtime.sleep(options.pauseMs);
    }
  }
  return { deleted, budgetSpent: false, lockLost: false };
}

/** Test seam: the next pass starts at the first status again. */
export function __resetNotificationSweepStatusOffsetForTests(): void {
  sweepStatusOffset = 0;
}

type SweepOptions = { batchSize: number; budgetMs: number; pauseMs: number; shouldStop?: () => boolean };

let sweepLockHeldElsewhereForTests = false;

/** Test-only: PGlite has one session, so another replica holding the lock is simulated. */
export function __setNotificationSweepLockHeldElsewhereForTests(held: boolean): void {
  if (process.env.NODE_ENV !== "test") throw new Error("sweep lock overrides are test-only");
  sweepLockHeldElsewhereForTests = held;
}

/** The maintenance pass's advisory lock (contract §7: one replica at a time). */
export const NOTIFICATION_SWEEP_LOCK = { classId: 0x4e4f5446, objectId: 1 } as const; // "NOTF"

/**
 * One maintenance pass (contract §7): terminal rows older than 14 days are
 * deleted in short batches, registrations not re-registered for 30 days are
 * revoked, ended phone alerts past their retention are deleted. Runs at server
 * start and every 6 hours on every replica; each step's transaction takes the
 * advisory lock first, so one replica works at a time and the others return
 * `skipped` at once. Each statement is bounded by statement_timeout.
 */
export async function sweepNotificationOutbox(
  now: number = runtime.now(),
  options: Partial<SweepOptions> = {},
): Promise<{ deleted: number; revokedRegistrations: number; skipped: boolean }> {
  const terminal = await sweepTerminalRows(now, {
    batchSize: options.batchSize ?? SWEEP_DELETE_BATCH,
    budgetMs: options.budgetMs ?? SWEEP_BUDGET_MS,
    pauseMs: options.pauseMs ?? SWEEP_PAUSE_MS,
    shouldStop: options.shouldStop,
  });
  if (terminal === null) {
    addTraceEvent("notification.sweep", { skipped: true });
    return { deleted: 0, revokedRegistrations: 0, skipped: true };
  }
  const { deleted } = terminal;
  if (options.shouldStop?.()) {
    addTraceEvent("notification.sweep", { deleted_count: deleted, stopped: true });
    return { deleted, revokedRegistrations: 0, skipped: false };
  }
  const staleBefore = new Date(now - NOTIFICATION_REGISTRATION_STALE_MS);
  // The staleness test is in the UPDATE itself: a registration an upsert is
  // refreshing is re-checked against its new values once that commits, so a
  // device that just re-registered is never revoked.
  const revoked = await sweepStep((tx) => tx
    .update(pushRegistrations)
    .set({
      userId: null,
      revokedUserId: sql<string | null>`coalesce(${pushRegistrations.userId}, ${pushRegistrations.revokedUserId})`,
      serverId: null,
      revokedAt: sql`now()`,
      revokedReason: "registration_not_refreshed",
      updatedAt: sql`now()`,
    })
    .where(and(
      isNull(pushRegistrations.revokedAt),
      lt(sql`COALESCE(${pushRegistrations.lastRegisteredAt}, ${pushRegistrations.updatedAt})`, staleBefore),
    ))
    .returning({ id: pushRegistrations.id }));
  // Held phone alerts are kept 7 days after they ended (mobileDeferral.ts).
  const deferrals = await sweepStep((tx) => sweepMobileDeferrals(tx, now));
  const revokedRegistrations = revoked?.length ?? 0;
  addTraceEvent("notification.sweep", {
    deleted_count: deleted,
    revoked_registration_count: revokedRegistrations,
    // Budget spent: rows past retention remain for the next pass. Lock lost:
    // another replica took a later step over (`revoke`/`deferrals` false).
    budget_spent: terminal.budgetSpent,
    lock_lost: terminal.lockLost || revoked === null || deferrals === null,
  });
  return { deleted, revokedRegistrations, skipped: false };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Held phone alerts (account mobileDelay, mobileDeferral.ts)
// ---------------------------------------------------------------------------

type DeferralOutcome =
  | { kind: "send"; outcome: "sent" | "presence_unknown_sent" }
  | { kind: "extend"; dueAt: number }
  | { kind: "skip"; outcome: string };

/**
 * One held phone alert at its due time: re-check everything the original
 * decision used, then alert the phones, wait longer (a computer was active
 * again; never past the deadline) or give up.
 */
async function fireMobileDeferral(deferral: MobileDeferralRow): Promise<void> {
  const db = getDb();
  const now = runtime.now();
  const traceOutcome = (outcome: string) => addTraceEvent("notification.mobile_deferral", {
    deferral_id: deferral.id,
    outbox_id: deferral.outboxId,
    outcome,
    extensions: deferral.extensions,
    held_ms: Math.max(0, now - deferral.createdAt.getTime()),
  });
  const skip = async (outcome: string) => {
    await finishMobileDeferral(db, deferral.id, "skipped", outcome, now);
    traceOutcome(outcome);
  };
  if (now > deferral.deadlineAt.getTime()) return skip("deadline");
  const [row] = await db.select().from(notificationOutbox).where(eq(notificationOutbox.id, deferral.outboxId));
  if (!row) return skip("event_missing");
  const event = await loadEvent(db, row, eventKeyOf(row));
  if (!event) return skip("event_missing");
  const userId = row.receiverId;
  const [prefs, noAccess, multiServer] = await Promise.all([
    loadNotificationPolicyPrefs(db, {
      userIds: [userId],
      serverIds: [row.serverId],
      channelIds: event.levelChannelId ? [event.levelChannelId] : [],
      threadChannelIds: event.threadChannelId ? [event.threadChannelId] : [],
    }),
    receiversWithoutAccess(db, event.accessChannel, [userId]),
    loadMultiServerUserIds(db, [userId]),
  ]);
  if (noAccess.has(userId)) return skip("suppressed:no_access");
  const category = outboxRowCategory(row);
  const account = prefs.account.get(userId) ?? DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS;
  // Muted, level lowered, paused or in quiet hours since: the same decision as at send time.
  const decision = decide({
    receiverId: userId,
    serverId: row.serverId,
    category,
    personal: row.personalMention,
    levelChannelId: event.levelChannelId,
    threadChannelId: event.threadChannelId,
    levelChannelSeq: event.levelChannelSeq,
    mentioned: row.personalMention,
    securityNotice: event.securityNotice,
  }, prefs, new Date(now), DEFAULT_NOTIFICATION_ACCOUNT_SETTINGS);
  if (decision.kind !== "notify") return skip(notificationDecisionLabel(decision));
  const built = buildNotification(event.context, { category, personal: row.personalMention, multiServer: multiServer.has(userId) }, account);
  if (await isNotificationReadThrough(db, userId, built.envelope.conversationId, built.envelope.seq)) return skip("read");

  const [presenceMap, subscriptions] = await Promise.all([
    loadNotificationPresence([userId], now),
    loadWebSubscriptions([userId], db),
  ]);
  const next = nextDeferralStep(presenceMap.get(userId), now, account, deferral, {
    webPushEndpointHashes: getConfiguredAppUrl() && webPushTransport.isConfigured()
      ? new Set((subscriptions.get(userId) ?? []).map((subscription) => pushEndpointHash(subscription.endpoint)))
      : new Set(),
    desktopSocket: Boolean(socketServer),
  });
  if (next.kind === "skip") return skip(next.outcome);
  if (next.kind === "extend") {
    await extendMobileDeferral(db, deferral.id, next.dueAt, now);
    traceOutcome("extended");
    return;
  }

  const registrations = ((await loadMobileRegistrations([userId], db)).get(userId) ?? []).filter(mobileDeviceAlertsAllowed);
  if (registrations.length === 0) return skip("no_device");
  const userBadge = (await loadNotificationBadges([userId], db)).get(userId);
  const badge = alertBadge(userBadge?.total);
  const serverBadge = serverBadgeOf(userBadge, row.serverId);
  let sent = 0;
  let failure: NotificationFailure | null = null;
  for (const registration of registrations) {
    const outcome = await sendOnce(row.id, registration.provider, registration.id, () => registration.provider === "apns"
      ? deliverExternalWithRetry("apns", () => apnsTransport.send(registration, apnsAlertRequest(built, badge, { serverBadge, previewKeySet: registration.previewKeySet })), apnsTransport, { category: built.envelope.category }, mobileTargetContext(registration))
      : deliverExternalWithRetry("fcm", () => fcmTransport.send(registration, fcmAlertMessage(built, badge, { serverBadge, previewKeySet: registration.previewKeySet })), fcmTransport, { category: built.envelope.category }, mobileTargetContext(registration)));
    if (!outcome) continue;
    if (outcome.outcome === "sent") sent += 1;
    else if (outcome.outcome === "terminal") {
      await revokeMobileRegistration(registration.id, outcome.failure.reason, db);
      failure ??= outcome.failure;
    } else if (outcome.outcome === "failed") failure ??= outcome.failure;
  }
  if (sent > 0) {
    void recordShownGroups(userId, [built.envelope.groupKey]).catch(() => undefined);
    if (badge !== undefined) void rememberSentBadge(userId, badge).catch(() => undefined);
    await finishMobileDeferral(db, deferral.id, "sent", next.outcome, now);
    traceOutcome(next.outcome);
    return;
  }
  // Nothing went: retry on the next pass while attempts remain (the ledger skips what went).
  if (deferral.attemptCount < MOBILE_DEFERRAL_MAX_ATTEMPTS && failure) {
    await extendMobileDeferral(db, deferral.id, Math.min(now + 30_000, deferral.deadlineAt.getTime()), now);
    traceOutcome("retry");
    return;
  }
  await finishMobileDeferral(db, deferral.id, "failed", failure ? `failed:${failure.reason}` : "failed", now);
  traceOutcome("failed");
}

/**
 * What a held alert does at its due time, from the person's presence now and
 * their current setting (changed since, it applies at once).
 */
export function nextDeferralStep(
  presence: NotificationUserPresence | undefined,
  now: number,
  account: Pick<NotificationAccountSettings, "mobileDelay">,
  deferral: Pick<MobileDeferralRow, "deadlineAt">,
  deliverable: NotificationDeliverability = NO_COMPUTER_DELIVERY,
): DeferralOutcome {
  // Presence failed to load: as everywhere else, fail open and alert.
  if (!presence) return { kind: "send", outcome: "presence_unknown_sent" };
  const plan = planNotificationDevices(presence, now, account.mobileDelay, deliverable);
  if (plan.mobileDeferUntil !== null) {
    const deadline = deferral.deadlineAt.getTime();
    // Still on a computer at the deadline: they have most likely seen it.
    if (now >= deadline) return { kind: "skip", outcome: "still_active_deadline" };
    return { kind: "extend", dueAt: Math.min(plan.mobileDeferUntil, deadline) };
  }
  // Switched to `inactive` while a computer is active: the phone stays quiet.
  if (!plan.mobileAlert) return { kind: "skip", outcome: "computer_active" };
  return { kind: "send", outcome: "sent" };
}

/** Fires the held phone alerts that are due; returns how many were claimed. */
export async function drainMobileDeferrals(batchSize = MOBILE_DEFERRAL_BATCH_SIZE): Promise<number> {
  const db = getDb();
  const due = await claimDueMobileDeferrals(db, runtime.now(), batchSize);
  await runBounded(due.map((deferral) => async () => {
    try {
      await fireMobileDeferral(deferral);
    } catch (err) {
      // Left `processing`: the stale-claim rule takes it again.
      console.error("[Notifications] Held phone alert failed:", err instanceof Error ? err.message : String(err));
    }
  }), NOTIFICATION_BOOKKEEPING_CONCURRENCY);
  return due.length;
}

export interface NotificationDispatcherWorker {
  /** Stops the timers; resolves once an in-flight maintenance pass has stopped between steps. */
  stop(): Promise<void>;
}

interface WorkerClock {
  scheduleEvery(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultClock: WorkerClock = {
  scheduleEvery: setClockInterval,
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function unrefTimer(timer: unknown) {
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
}

/** The 15 s fallback drain (replaces startMobilePushOutboxWorker) and the maintenance pass (start + every 6 h). */
export function startNotificationDispatcher(opts: {
  io?: SocketServer | null;
  intervalMs?: number;
  sweepIntervalMs?: number;
  batchSize?: number;
  clock?: WorkerClock;
  tracer?: Tracer;
} = {}): NotificationDispatcherWorker {
  if (opts.io) registerNotificationSocketServer(opts.io);
  const clock = opts.clock ?? defaultClock;
  drainTracer = opts.tracer ?? noopTracer;
  const batchSize = opts.batchSize ?? OUTBOX_BATCH_SIZE;
  let draining = false;
  // The outbox and the held phone alerts drain side by side: a held alert
  // never queues behind an outbox group's desktop ack wait.
  let firingDeferrals = false;
  const run = (trigger: "startup" | "interval_worker") => {
    if (!draining) {
      draining = true;
      runTracedDrain(trigger, () => drainNotificationOutbox(batchSize))
        .catch((err) => { console.error("[Notifications] Failed to drain the notification outbox:", err); })
        .finally(() => { draining = false; });
    }
    if (!firingDeferrals) {
      firingDeferrals = true;
      drainMobileDeferrals()
        .catch((err) => { console.error("[Notifications] Failed to fire held phone alerts:", err); })
        .finally(() => { firingDeferrals = false; });
    }
  };
  let stopped = false;
  let sweeping: Promise<void> | null = null;
  const sweep = () => {
    if (sweeping) return;
    sweeping = sweepNotificationOutbox(runtime.now(), { shouldStop: () => stopped })
      .then(() => undefined, (err) => { console.error("[Notifications] Notification outbox sweep failed:", err); })
      .finally(() => { sweeping = null; });
  };
  run("startup");
  // At start (so it never depends on one replica's uptime) and every 6 hours.
  sweep();
  const timer = clock.scheduleEvery(() => run("interval_worker"), opts.intervalMs ?? 15_000);
  unrefTimer(timer);
  const sweepTimer = clock.scheduleEvery(sweep, opts.sweepIntervalMs ?? NOTIFICATION_SWEEP_INTERVAL_MS);
  unrefTimer(sweepTimer);
  return {
    async stop() {
      stopped = true;
      clock.clearInterval(timer);
      clock.clearInterval(sweepTimer);
      // The pass is short steps now: stop between them rather than leave one
      // writing after the worker is gone.
      await sweeping;
    },
  };
}
