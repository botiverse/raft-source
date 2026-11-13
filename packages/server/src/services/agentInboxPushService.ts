// External Agent inbox push: a signed NOTICE (`raft-agent-inbox-notice.v1`),
// the external counterpart of a managed agent's "Inbox update". It says which
// conversations have new unread messages (target, counts, first/latest message
// ids, latest seq, sender, flags) and carries no message bodies. The agent reads and
// acknowledges through its own pull (`GET /internal/agent-api/events?ack=cursor`,
// `raft message check`) or its reads (`raft inbox read`, `raft message read
// --unread`); `raft inbox check` only lists, and a notice never moves any cursor.
//
// Hot path: when this replica delivers a message to an external agent's inbox
// (`external-inbox-delivered` with the message), its row is merged into the
// agent's pending notice (in memory, per replica) and POSTed at once, or with
// the next POST if one is in flight. Notices are idempotent; direct notices
// never coordinate across replicas, but every sweep send is claimed on the
// registration row, so one replica sends it.
//
// Third-party app events (POST /api/oauth/agent-events) have no durable inbox
// row. Each is announced as its own `agent-event:<id8>` target, once per
// event id, never after it expires; the sweep reads the agent's unacknowledged
// events from their table, since the chain does not hold them.
//
// Durability without a queue: a periodic sweep sends a notice for any agent
// whose inbox has unread written after its last delivered notice (a notice
// lost to a crash or a failing endpoint), and a reminder (at most one per
// pending state, claimed in reminded_max_seq) for any agent whose inbox still has unread when its last delivered notice is
// older than AGENT_INBOX_NOTICE_REMIND_AFTER_MS (the hot-path notice is sent
// without reading the chain, so the agent's pull may have beaten the chain to
// the row).
//
// A registration that stops (disabled_at: 3 consecutive 404/410, at least 3
// 401s with no other answer for 24 hours, or a revoked credential) is not silent: the UPDATE
// that sets disabled_at also claims a notice to the agent's owner (at most one
// per 24 hours; none when the owner revoked the credential themselves). Nor is
// an endpoint_rejected stop permanent: the sweep probes it with an empty
// notice, 1 hour after the stop and then doubling up to every 24 hours, and a
// 2xx re-enables it (#proj-assistant:742b8915).
import { createHmac, randomUUID } from "node:crypto";
import {
  clearClockInterval,
  clearClockTimeout,
  createScopedTracer,
  currentDate,
  formatAgentInboxDelta,
  isExternalAgentRuntime,
  noopTracer,
  projectAgentInboxSnapshot,
  setClockInterval,
  setClockTimeout,
  type AgentInboxTargetRow,
  type AgentMessage,
  type Tracer,
} from "@botiverse/raft-shared";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentCredentials, agentInboxEventsPendingAcks, agentInboxPushRegistrations, agents, users } from "../db/schema";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { addTraceEvent, errorClassOf, runWithTraceSpan } from "../tracing/semanticTrace";
import { agentIdHashAttrs, serverIdHashAttrs } from "../tracing/traceIdentity";
import type { AgentOrchestrator } from "./agentOrchestrator";
import {
  appWebhookDeliveryErrorCode,
  postPublicHttps,
  WebhookPostError,
  type WebhookPost,
  type WebhookPostTiming,
} from "./appNotificationDeliveryService";
import {
  AppWebhookConfigError,
  decryptWebhookSigningSecret,
  encryptWebhookSigningSecret,
  normalizeAppWebhookEndpoint,
} from "./appWebhookConfigService";
import { currentRaftTraceId, raftTraceIdHeaders } from "./externalRequestCorrelation";
import * as messageService from "./messageService";
import * as oauthService from "./oauthService";
import { assistantOwnerPassesSso } from "./sso/ssoEnforcement";

export const AGENT_INBOX_NOTICE_SCHEMA = "raft-agent-inbox-notice.v1";
/** Consecutive 404/410 responses that disable a registration. */
export const AGENT_INBOX_PUSH_REJECTION_LIMIT = 3;
/**
 * A 401 does not count toward the rejections: receivers answer it while their
 * runtime deploys or rotates credentials. A run of 401s (no other outcome in
 * between) disables once it has both lasted this long since its first 401…
 */
export const AGENT_INBOX_PUSH_UNAUTHORIZED_DISABLE_AFTER_MS = 24 * 60 * 60_000;
/** …and held at least this many 401s in a row (two 401s a day apart prove little). */
export const AGENT_INBOX_PUSH_UNAUTHORIZED_MIN_COUNT = 3;
/** At most one "pushes stopped" notice to the agent's owner per this interval, however often it flaps. */
export const AGENT_INBOX_PUSH_DISABLED_NOTICE_INTERVAL_MS = 24 * 60 * 60_000;
/** Recovery probe of an endpoint_rejected registration: first this long after the stop, then doubling… */
export const AGENT_INBOX_PUSH_PROBE_FIRST_DELAY_MS = 60 * 60_000;
/** …up to this, then at this interval… */
export const AGENT_INBOX_PUSH_PROBE_MAX_DELAY_MS = 24 * 60 * 60_000;
/**
 * …until the registration has been stopped this long: then probing stops for
 * good (the URL may be abandoned and its domain re-registered by someone
 * else), and only a new PUT resumes delivery. No owner notice for this.
 */
export const AGENT_INBOX_PUSH_PROBE_GIVE_UP_AFTER_MS = 30 * 24 * 60 * 60_000;
/**
 * Backoff after the Nth consecutive failure (the last entry repeats). Capped at
 * 5 minutes: a notice is a small POST, and a longer cap only makes an agent
 * wait after its receiver is back (prod 10-05: a 30-minute cap added up to
 * half an hour to a 77-minute outage).
 */
export const AGENT_INBOX_PUSH_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000, 5 * 60_000];
/**
 * 5xx and timeouts wait at most 5 minutes, a 503's Retry-After included; a 429
 * follows the receiver's Retry-After, up to 60 minutes (RETRY_AFTER_MAX_MS).
 */
export const AGENT_INBOX_PUSH_RETRY_CAP_MS = 5 * 60_000;
/**
 * Backoff after a 400 (the receiver refused the body as invalid): retried on
 * this long schedule, since the receiver may deploy a fix; never disables.
 */
export const AGENT_INBOX_PUSH_BAD_REQUEST_RETRY_DELAYS_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000];
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;
/** Socket timeout of the POST (starts after the DNS lookup)… */
const REQUEST_TIMEOUT_MS = 10_000;
/** …and the bound on the whole POST, DNS lookup included. */
export const AGENT_INBOX_NOTICE_POST_TIMEOUT_MS = 12_000;
/** The sweep's inbox read (RisingWave chain + Postgres), which has no query timeout of its own. */
export const AGENT_INBOX_NOTICE_SWEEP_READ_TIMEOUT_MS = 5_000;
/**
 * Lease a direct (or retry) notice holds on its registration while its POST is
 * in flight: the POST bound plus a margin. The sweep's claim already skips
 * leased rows, so this keeps one notice per registration on the wire.
 */
export const AGENT_INBOX_NOTICE_DIRECT_LEASE_MS = AGENT_INBOX_NOTICE_POST_TIMEOUT_MS + 3_000;
export const AGENT_INBOX_NOTICE_SWEEP_INTERVAL_MS = 60_000;
/**
 * Unread still pending this long after the last delivered notice is re-notified
 * (a reminder), at most once per pending state (reminded_max_seq).
 */
export const AGENT_INBOX_NOTICE_REMIND_AFTER_MS = 5 * 60_000;
const SWEEP_BATCH_SIZE = 50;
/** Pending third-party events one sweep notice lists per agent. */
const SWEEP_EVENT_LIMIT = 50;
const SECRET_MAX_LENGTH = 512;

export type AgentInboxPushDisabledReason = "endpoint_rejected" | "credential_revoked" | "agent_inactive";

/**
 * Why the owner is told pushes stopped: the endpoint kept refusing, or someone
 * other than the owner revoked the credential the registration is bound to.
 */
export type AgentInboxPushPausedCause = "endpoint_failing" | "credential_revoked";
/**
 * Posts the owner's notice (server.ts wires agentActionRequiredNoticeService).
 * Called after the disable committed, once per claimed notice.
 */
export type AgentInboxPushOwnerNotifier = (input: { agentId: string; cause: AgentInboxPushPausedCause }) => Promise<unknown>;

export class AgentInboxPushError extends Error {
  constructor(
    readonly code: "INVALID_URL" | "INVALID_SECRET" | "AGENT_NOT_EXTERNAL" | "AGENT_NOT_FOUND" | "CREDENTIAL_INACTIVE" | "PUSH_UNAVAILABLE",
    message: string,
  ) {
    super(message);
  }
}

export interface AgentInboxPushStatus {
  registered: boolean;
  url: string | null;
  enabled: boolean;
  disabledReason: AgentInboxPushDisabledReason | null;
  disabledAt: string | null;
  lastAttemptAt: string | null;
  lastDeliveryAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextAttemptAt: string | null;
  /** When Raft stopped probing a stopped endpoint (30 days without recovering); a new PUT clears it. */
  probeStoppedAt: string | null;
  /** While disabled: how delivery resumes (probing, or a new PUT). Null while enabled. */
  recovery: string | null;
}

/** How a stopped registration gets going again, for its status and diagnostics. */
export function agentInboxPushRecoveryText(input: {
  disabledReason: AgentInboxPushDisabledReason | null;
  probeStoppedAt: Date | null;
}): string | null {
  switch (input.disabledReason) {
    case "endpoint_rejected":
      return input.probeStoppedAt
        ? "Raft stopped probing the endpoint after 30 days without recovery; register it again (PUT /push-webhook) to resume push delivery."
        : "Raft probes the endpoint (1 hour after the stop, then doubling up to every 24 hours) and resumes push delivery when it answers 2xx; registering it again (PUT /push-webhook) resumes delivery at once.";
    case "credential_revoked":
      return "Register the endpoint again (PUT /push-webhook) with an active credential to resume push delivery.";
    default:
      return null;
  }
}

type RegistrationRow = typeof agentInboxPushRegistrations.$inferSelect;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toStatus(row: RegistrationRow | undefined): AgentInboxPushStatus {
  if (!row) {
    return {
      registered: false,
      url: null,
      enabled: false,
      disabledReason: null,
      disabledAt: null,
      lastAttemptAt: null,
      lastDeliveryAt: null,
      lastError: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
      probeStoppedAt: null,
      recovery: null,
    };
  }
  const disabledReason = (row.disabledReason as AgentInboxPushDisabledReason | null) ?? null;
  return {
    registered: true,
    url: row.endpointUrl,
    enabled: row.disabledAt === null,
    disabledReason,
    disabledAt: iso(row.disabledAt),
    lastAttemptAt: iso(row.lastAttemptAt),
    lastDeliveryAt: iso(row.lastDeliveryAt),
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    nextAttemptAt: row.disabledAt === null ? iso(row.nextAttemptAt) : null,
    probeStoppedAt: row.disabledAt === null ? null : iso(row.probeStoppedAt),
    recovery: row.disabledAt === null ? null : agentInboxPushRecoveryText({ disabledReason, probeStoppedAt: row.probeStoppedAt }),
  };
}

/**
 * The receiver supplies the signing secret. It must carry at least 32 bytes of
 * entropy in a printable form: 64+ hex characters, or 43+ characters otherwise
 * (32 random bytes in base64/base64url). Visibly low-entropy strings are refused.
 */
export function validateAgentInboxPushSecret(raw: unknown): string {
  const reject = (message: string): never => {
    throw new AgentInboxPushError("INVALID_SECRET", message);
  };
  if (typeof raw !== "string") return reject("secret is required");
  if (raw.length > SECRET_MAX_LENGTH) return reject(`secret must be at most ${SECRET_MAX_LENGTH} characters`);
  if (!/^[\x21-\x7e]+$/.test(raw)) return reject("secret must be printable ASCII without whitespace");
  const hex = /^[0-9a-fA-F]+$/.test(raw);
  const minLength = hex ? 64 : 43;
  if (raw.length < minLength) {
    return reject("secret must carry at least 32 bytes of entropy: 64+ hex characters or 43+ base64url characters");
  }
  if (new Set(raw).size < (hex ? 10 : 16)) return reject("secret is too repetitive to be random");
  return raw;
}

function normalizeEndpoint(raw: unknown): string {
  try {
    return normalizeAppWebhookEndpoint(raw);
  } catch (error) {
    if (error instanceof AppWebhookConfigError) {
      throw new AgentInboxPushError("INVALID_URL", error.message.replace(/^endpointUrl/, "url"));
    }
    throw error;
  }
}

export async function getAgentInboxPushStatus(
  input: { agentId: string; serverId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<AgentInboxPushStatus> {
  const [row] = await executor.select().from(agentInboxPushRegistrations).where(and(
    eq(agentInboxPushRegistrations.agentId, input.agentId),
    eq(agentInboxPushRegistrations.serverId, input.serverId),
  )).limit(1);
  return toStatus(row);
}

/**
 * Create or replace the agent's registration, bound to the calling credential.
 * Replacing rotates the secret atomically (one row update) and re-enables a
 * disabled registration. The delivery lease is left alone, so a delivery in
 * flight is never doubled.
 */
export async function putAgentInboxPushRegistration(input: {
  agentId: string;
  serverId: string;
  credentialId: string;
  url: unknown;
  secret: unknown;
  /**
   * `agent`: PUT /push-webhook with the agent's own credential. `provider`:
   * the runtime provider's control route (routes/runtimeProviderControl.ts).
   */
  configuredBy: "agent" | "provider";
  now?: Date;
}, executor: DatabaseExecutor = getDb()): Promise<AgentInboxPushStatus> {
  const endpointUrl = normalizeEndpoint(input.url);
  const secret = validateAgentInboxPushSecret(input.secret);
  const now = input.now ?? currentDate();

  const [agent] = await executor.select({ runtime: agents.runtime, serverId: agents.serverId }).from(agents).where(and(
    eq(agents.id, input.agentId),
    isNull(agents.deletedAt),
  )).limit(1);
  if (!agent || agent.serverId !== input.serverId) throw new AgentInboxPushError("AGENT_NOT_FOUND", "Agent not found");
  if (!isExternalAgentRuntime(agent.runtime)) {
    throw new AgentInboxPushError(
      "AGENT_NOT_EXTERNAL",
      "Inbox push is only available to External Agents; managed agents receive their inbox through the daemon",
    );
  }
  const [credential] = await executor.select({ id: agentCredentials.id }).from(agentCredentials).where(and(
    eq(agentCredentials.id, input.credentialId),
    eq(agentCredentials.agentId, input.agentId),
    isNull(agentCredentials.revokedAt),
  )).limit(1);
  if (!credential) throw new AgentInboxPushError("CREDENTIAL_INACTIVE", "Credential is not active");

  let encrypted: ReturnType<typeof encryptWebhookSigningSecret>;
  try {
    encrypted = encryptWebhookSigningSecret(secret);
  } catch (error) {
    if (error instanceof AppWebhookConfigError) {
      throw new AgentInboxPushError("PUSH_UNAVAILABLE", "Inbox push is not configured on this server");
    }
    throw error;
  }
  const values = {
    serverId: input.serverId,
    credentialId: input.credentialId,
    endpointUrl,
    secretCiphertext: encrypted.ciphertext,
    secretIv: encrypted.iv,
    secretAuthTag: encrypted.authTag,
    disabledAt: null,
    disabledReason: null,
    nextAttemptAt: now,
    consecutiveFailures: 0,
    consecutiveRejections: 0,
    firstUnauthorizedAt: null,
    consecutiveUnauthorized: 0,
    nextProbeAt: null,
    probeBackoffMs: null,
    probeStoppedAt: null,
    lastError: null,
    configuredBy: input.configuredBy,
    updatedAt: now,
  };
  const [row] = await executor.insert(agentInboxPushRegistrations)
    .values({ agentId: input.agentId, ...values, createdAt: now })
    .onConflictDoUpdate({ target: agentInboxPushRegistrations.agentId, set: values })
    .returning();
  addTraceEvent("agent_inbox_push.registration.put", { outcome: "stored" });
  activeWorker?.kick(input.agentId);
  return toStatus(row);
}

export async function deleteAgentInboxPushRegistration(
  input: { agentId: string; serverId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const deleted = await executor.delete(agentInboxPushRegistrations).where(and(
    eq(agentInboxPushRegistrations.agentId, input.agentId),
    eq(agentInboxPushRegistrations.serverId, input.serverId),
  )).returning({ id: agentInboxPushRegistrations.id });
  return deleted.length > 0;
}


// ---------------------------------------------------------------------------
// Notice

/**
 * One conversation in a notice: the inbox row, without attention hints and
 * with only its latest seq, as a decimal string (`latestSeq`; absent when the
 * row has none, e.g. a third-party event). An agent passes `channelId:latestSeq`
 * back as `/events?wait_for=`, so its pull waits for the inbox chain to hold
 * the message.
 */
export type AgentInboxNoticeTarget = Pick<AgentInboxTargetRow,
  "target" | "channelId" | "channelType" | "pendingCount" | "firstPendingMsgId" | "latestMsgId"
  | "latestSenderName" | "latestSenderType" | "flags"> & { latestSeq?: string };

export interface AgentInboxNotice {
  schema: typeof AGENT_INBOX_NOTICE_SCHEMA;
  noticeId: string;
  recipientAgentId: string;
  occurredAt: string;
  /** `formatAgentInboxDelta(targets)`: the same "Inbox update" text a managed agent gets. */
  text: string;
  targets: AgentInboxNoticeTarget[];
}

const NOTICE_TARGET_KEYS = [
  "target", "channelId", "channelType", "pendingCount", "firstPendingMsgId", "latestMsgId",
  "latestSenderName", "latestSenderType", "flags",
] as const satisfies readonly (keyof AgentInboxNoticeTarget & keyof AgentInboxTargetRow)[];

function toNoticeTarget(row: AgentInboxTargetRow): AgentInboxNoticeTarget {
  const target: Partial<AgentInboxNoticeTarget> = {};
  for (const key of NOTICE_TARGET_KEYS) {
    if (row[key] !== undefined) Object.assign(target, { [key]: row[key] });
  }
  // Decimal string: seqs are bigint in Postgres, and a string stays exact in
  // any receiver's JSON parser should one ever pass 2^53.
  if (typeof row.latestSeq === "number" && Number.isSafeInteger(row.latestSeq) && row.latestSeq > 0) {
    target.latestSeq = String(row.latestSeq);
  }
  return target as AgentInboxNoticeTarget;
}

/**
 * A third-party app event has no durable inbox row, so it gets a row of its
 * own addressed `agent-event:<id8>`, the target `raft message read` re-reads
 * it by. One event is one row, so the same event announced twice (direct push
 * and sweep, or a retry) is one row with one pending message.
 */
function thirdPartyEventRow(message: AgentMessage): AgentInboxTargetRow | null {
  const eventId = message.third_party_event?.id;
  if (typeof eventId !== "string" || eventId.length === 0) return null;
  return {
    target: `agent-event:${eventId.slice(0, 8)}`,
    pendingCount: 1,
    firstPendingMsgId: eventId,
    latestMsgId: eventId,
    latestSenderName: message.sender_name,
    latestSenderType: "third_party_app",
    flags: [],
  };
}

function isThirdPartyEventTarget(target: string): boolean {
  return target.startsWith("agent-event:");
}

/** Pending rows of one agent, merged by target (seqs kept internally for "latest"). */
class PendingNotice {
  readonly rows = new Map<string, AgentInboxTargetRow>();
  /** Expiry of each third-party event row, by target: an expired event is never announced. */
  readonly eventExpiresAtMs = new Map<string, number>();
  /** Earliest message write among the pending rows (latency: write -> 2xx). */
  oldestWriteAtMs: number | null = null;

  addMessage(message: AgentMessage): void {
    const eventRow = message.third_party_event ? thirdPartyEventRow(message) : null;
    if (message.third_party_event && !eventRow) return;
    if (eventRow) {
      const expiresAt = Date.parse(message.third_party_event?.expires_at ?? "");
      if (Number.isFinite(expiresAt)) this.eventExpiresAtMs.set(eventRow.target, expiresAt);
      this.addRow(eventRow);
    } else {
      for (const row of projectAgentInboxSnapshot([message])) this.addRow(row);
    }
    const writtenAt = typeof message.timestamp === "string" ? Date.parse(message.timestamp) : Number.NaN;
    if (Number.isFinite(writtenAt)) this.oldestWriteAtMs = Math.min(this.oldestWriteAtMs ?? writtenAt, writtenAt);
  }

  /** Drop third-party event rows whose event has expired. */
  dropExpired(nowMs: number): void {
    for (const [target, expiresAtMs] of this.eventExpiresAtMs) {
      if (expiresAtMs > nowMs) continue;
      this.rows.delete(target);
      this.eventExpiresAtMs.delete(target);
    }
  }

  addRow(row: AgentInboxTargetRow): void {
    const existing = this.rows.get(row.target);
    if (!existing) {
      this.rows.set(row.target, { ...row, flags: [...row.flags] });
      return;
    }
    // The same event again: still one event.
    if (isThirdPartyEventTarget(row.target)) return;
    const newer = (row.latestSeq ?? 0) >= (existing.latestSeq ?? 0) ? row : existing;
    const older = newer === row ? existing : row;
    this.rows.set(row.target, {
      ...newer,
      pendingCount: existing.pendingCount + row.pendingCount,
      firstPendingMsgId: (older.firstPendingSeq ?? 0) <= (newer.firstPendingSeq ?? 0)
        ? older.firstPendingMsgId ?? newer.firstPendingMsgId
        : newer.firstPendingMsgId ?? older.firstPendingMsgId,
      firstPendingSeq: Math.min(older.firstPendingSeq ?? Infinity, newer.firstPendingSeq ?? Infinity) === Infinity
        ? undefined
        : Math.min(older.firstPendingSeq ?? Infinity, newer.firstPendingSeq ?? Infinity),
      flags: [...new Set([...existing.flags, ...row.flags])].sort(),
    });
  }

  /** Merge another pending notice in (a failed notice put back under newer rows). */
  absorb(other: PendingNotice): void {
    for (const row of other.rows.values()) this.addRow(row);
    for (const [target, expiresAtMs] of other.eventExpiresAtMs) {
      if (!this.eventExpiresAtMs.has(target)) this.eventExpiresAtMs.set(target, expiresAtMs);
    }
    if (other.oldestWriteAtMs !== null) {
      this.oldestWriteAtMs = Math.min(this.oldestWriteAtMs ?? other.oldestWriteAtMs, other.oldestWriteAtMs);
    }
  }

  get empty(): boolean {
    return this.rows.size === 0;
  }

  toNotice(agentId: string, now: Date): AgentInboxNotice {
    const rows = [...this.rows.values()].sort((a, b) => (b.latestSeq ?? 0) - (a.latestSeq ?? 0) || a.target.localeCompare(b.target));
    return {
      schema: AGENT_INBOX_NOTICE_SCHEMA,
      noticeId: `ntc_${randomUUID()}`,
      recipientAgentId: agentId,
      occurredAt: now.toISOString(),
      text: formatAgentInboxDelta(rows),
      targets: rows.map(toNoticeTarget),
    };
  }
}

export function signAgentInboxPushBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

type AttemptOutcome =
  | { kind: "delivered" }
  | { kind: "rejected"; error: string }
  | { kind: "unauthorized"; error: "http_401" }
  | { kind: "bad_request"; error: string }
  | { kind: "retry"; error: string; retryAfterMs: number | null };

function parseRetryAfterMs(value: string | undefined, now: Date): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  let ms: number | null = null;
  if (/^\d+$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) ms = date - now.getTime();
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

function classify(status: number, errorCode: string | null, retryAfter: string | undefined, now: Date): AttemptOutcome {
  if (status >= 200 && status < 300) return { kind: "delivered" };
  if (status === 401) return { kind: "unauthorized", error: "http_401" };
  if (status === 404 || status === 410) return { kind: "rejected", error: `http_${status}` };
  if (status === 400) return { kind: "bad_request", error: "http_400" };
  if (status === 429) return { kind: "retry", error: "http_429", retryAfterMs: parseRetryAfterMs(retryAfter, now) };
  // A 503 may say when to come back, but never later than the backoff cap.
  if (status === 503) {
    const retryAfterMs = parseRetryAfterMs(retryAfter, now);
    return { kind: "retry", error: "http_503", retryAfterMs: retryAfterMs === null ? null : Math.min(retryAfterMs, AGENT_INBOX_PUSH_RETRY_CAP_MS) };
  }
  return { kind: "retry", error: status > 0 ? `http_${status}` : (errorCode ?? "network_error"), retryAfterMs: null };
}

export function agentInboxPushRetryDelayMs(
  consecutiveFailures: number,
  schedule: readonly number[] = AGENT_INBOX_PUSH_RETRY_DELAYS_MS,
): number {
  const index = Math.min(Math.max(consecutiveFailures, 1), schedule.length) - 1;
  return schedule[index]!;
}

class StepTimeout extends Error {
  constructor(step: string, ms: number) {
    super(`${step} timed out after ${ms} ms`);
    this.name = "AgentInboxNoticeStepTimeout";
  }
}

/** Race a step against its bound. The step keeps running in the background; its result is ignored. */
function withStepTimeout<T>(step: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setClockTimeout(() => reject(new StepTimeout(step, ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearClockTimeout(timer));
}

/**
 * The registration (enabled or not) and its live delivery authority, or why it
 * may not push. `ownerRevoked`: the bound credential's revocation was the
 * owner's own doing (they revoked it, or it was their own key that a cascade
 * of theirs revoked) or a rotation, so the owner is not told about the stop.
 */
async function loadRegistrationAuthority(agentId: string, executor: DatabaseExecutor) {
  const [row] = await executor.select({
    registration: agentInboxPushRegistrations,
    credentialRevokedAt: agentCredentials.revokedAt,
    credentialRevokedByUserId: agentCredentials.revokedByUserId,
    credentialRevokedReason: agentCredentials.revokedReason,
    credentialCreatedByUserId: agentCredentials.createdByUserId,
    runtime: agents.runtime,
    agentServerId: agents.serverId,
    agentDeletedAt: agents.deletedAt,
    assistantPausedAt: agents.assistantPausedAt,
    assistantOwnerUserId: agents.assistantOwnerUserId,
    creatorType: agents.creatorType,
    creatorId: agents.creatorId,
  }).from(agentInboxPushRegistrations)
    .innerJoin(agentCredentials, eq(agentCredentials.id, agentInboxPushRegistrations.credentialId))
    .innerJoin(agents, eq(agents.id, agentInboxPushRegistrations.agentId))
    .where(eq(agentInboxPushRegistrations.agentId, agentId))
    .limit(1);
  if (!row) return null;
  const disabledReason: AgentInboxPushDisabledReason | null = row.credentialRevokedAt
    ? "credential_revoked"
    : row.agentDeletedAt || !isExternalAgentRuntime(row.runtime) || row.agentServerId !== row.registration.serverId
      ? "agent_inactive"
      : null;
  const ownerId = row.creatorType === "user" ? row.creatorId : null;
  // A rotation replaced the credential on purpose; its holder registers again with the new one.
  const ownerRevoked = row.credentialRevokedReason === "rotated" || (ownerId !== null && (
    row.credentialRevokedByUserId === ownerId
    || (row.credentialRevokedByUserId === null && row.credentialCreatedByUserId === ownerId)
  ));
  return { registration: row.registration, disabledReason, ownerRevoked, paused: row.assistantPausedAt !== null, assistantOwnerUserId: row.assistantOwnerUserId };
}

/** The enabled registration and its live delivery authority, or why it may not push. */
async function loadSendable(agentId: string, executor: DatabaseExecutor) {
  const loaded = await loadRegistrationAuthority(agentId, executor);
  return loaded && loaded.registration.disabledAt === null ? loaded : null;
}

/**
 * Stop the registration: only the NULL -> set transition of disabled_at, so of
 * concurrent failures (replicas, retries) exactly one disables. The same UPDATE
 * claims the owner's notice when `notifyCause` is given and no notice went out
 * in the last 24 hours, so exactly one caller is told to send it; and an
 * endpoint_rejected stop gets its first recovery probe an hour out.
 */
async function disableRegistration(executor: DatabaseExecutor, input: {
  registrationId: string;
  reason: AgentInboxPushDisabledReason;
  now: Date;
  lastError?: string;
  notifyCause: AgentInboxPushPausedCause | null;
}): Promise<{ disabled: boolean; notify: boolean }> {
  const t = agentInboxPushRegistrations;
  const probe = input.reason === "endpoint_rejected";
  const nowIso = input.now.toISOString();
  const noticeCutoffIso = new Date(input.now.getTime() - AGENT_INBOX_PUSH_DISABLED_NOTICE_INTERVAL_MS).toISOString();
  const [row] = await executor.update(t).set({
    disabledAt: input.now,
    disabledReason: input.reason,
    ...(input.lastError ? { lastError: input.lastError } : {}),
    nextProbeAt: probe ? new Date(input.now.getTime() + AGENT_INBOX_PUSH_PROBE_FIRST_DELAY_MS) : null,
    probeBackoffMs: probe ? AGENT_INBOX_PUSH_PROBE_FIRST_DELAY_MS : null,
    probeStoppedAt: null,
    ...(input.notifyCause ? {
      lastDisabledNoticeAt: sql`CASE WHEN ${t.lastDisabledNoticeAt} IS NULL OR ${t.lastDisabledNoticeAt} <= ${noticeCutoffIso}::timestamptz
        THEN ${nowIso}::timestamptz ELSE ${t.lastDisabledNoticeAt} END`,
    } : {}),
    updatedAt: input.now,
  }).where(and(eq(t.id, input.registrationId), isNull(t.disabledAt)))
    .returning({ lastDisabledNoticeAt: t.lastDisabledNoticeAt });
  if (!row) return { disabled: false, notify: false };
  const notify = input.notifyCause !== null && row.lastDisabledNoticeAt?.getTime() === input.now.getTime();
  addTraceEvent("agent_inbox_push.disabled", { reason: input.reason, owner_notice: notify });
  return { disabled: true, notify };
}

/** Post the owner's notice a disable claimed. Best effort: the disable stands either way. */
async function notifyOwnerOfDisable(
  notifier: AgentInboxPushOwnerNotifier | undefined,
  agentId: string,
  cause: AgentInboxPushPausedCause,
): Promise<void> {
  if (!notifier) return;
  try {
    if (await notifier({ agentId, cause }) === false) {
      console.warn("[AgentInboxPush] owner notice not posted (no owner or DM)");
    }
  } catch (error) {
    console.error("[AgentInboxPush] owner notice failed", serializeErrorForLog(error));
  }
}

interface NoticePostResult {
  status: number;
  retryAfter?: string;
  errorCode: string | null;
  responseRequestId: string | null;
  timing?: WebhookPostTiming;
  timeoutPhase: WebhookPostError["timeoutPhase"];
}

/** The signed, bounded POST of one notice to the registration's endpoint (public HTTPS only, SSRF-checked). */
async function postNotice(
  registration: RegistrationRow,
  notice: AgentInboxNotice,
  post: WebhookPost | undefined,
  traceId: string | null,
): Promise<NoticePostResult> {
  const body = JSON.stringify(notice);
  const result: NoticePostResult = { status: 0, errorCode: null, responseRequestId: null, timeoutPhase: null };
  try {
    const secret = decryptWebhookSigningSecret({
      ciphertext: registration.secretCiphertext,
      iv: registration.secretIv,
      authTag: registration.secretAuthTag,
    });
    const response = await withStepTimeout("POST", AGENT_INBOX_NOTICE_POST_TIMEOUT_MS, (post ?? postPublicHttps)({
      endpointUrl: registration.endpointUrl,
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body, "utf8").toString(),
        "user-agent": "Raft-Agent-Inbox/2.0",
        "x-raft-delivery-id": notice.noticeId,
        "x-raft-signature-256": signAgentInboxPushBody(secret, body),
        // This notice span's trace id, for the receiver to log (correlation);
        // omitted when no tracer records the span.
        ...raftTraceIdHeaders(traceId),
      },
    }));
    result.status = response.status;
    result.retryAfter = response.retryAfter;
    result.responseRequestId = response.requestId ?? null;
    result.timing = response.timing;
  } catch (error) {
    result.errorCode = appWebhookDeliveryErrorCode(error);
    // The phases that did complete (connect, TLS) before the failure, and
    // where a timeout stopped.
    if (error instanceof WebhookPostError) {
      result.timing = error.timing;
      result.timeoutPhase = error.timeoutPhase;
    }
  }
  return result;
}

export type AgentInboxNoticeMode = "direct" | "retry" | "sweep";
/** Why the sweep sends: unread written after the last notice, or a reminder of unread still pending. */
export type AgentInboxNoticeSweepReason = "new" | "remind";

export interface AgentInboxNoticeResult {
  outcome: "delivered" | "rejected" | "bad_request" | "retry" | "backoff" | "disabled" | "paused" | "unregistered" | "nothing_to_send";
  /** When a failed notice should be tried again (in-memory retry on this replica). */
  retryInMs?: number;
}

/**
 * POST one notice for the agent and record the outcome on the registration.
 * Failure counters are updated with SQL arithmetic, so replicas notifying
 * concurrently never lose a count; a success resets them.
 */
export async function sendAgentInboxNotice(input: {
  agentId: string;
  pending: PendingNotice;
  mode: AgentInboxNoticeMode;
  reason?: AgentInboxNoticeSweepReason;
  post?: WebhookPost;
  tracer?: Tracer;
  clock?: () => Date;
  executor?: DatabaseExecutor;
  /** Told when this send stopped the registration and claimed the owner's notice. */
  notifyOwner?: AgentInboxPushOwnerNotifier;
}): Promise<AgentInboxNoticeResult> {
  const executor = input.executor ?? getDb();
  const clock = input.clock ?? currentDate;
  const t = agentInboxPushRegistrations;
  const sendable = await loadSendable(input.agentId, executor);
  if (!sendable) return { outcome: "unregistered" };
  const { registration } = sendable;
  const now = clock();
  if (sendable.disabledReason) {
    // A revoked credential is told to the owner unless the revocation was
    // theirs; an inactive agent (deleted, no longer External) is not.
    const notifyCause = sendable.disabledReason === "credential_revoked" && !sendable.ownerRevoked ? "credential_revoked" : null;
    const { notify } = await disableRegistration(executor, {
      registrationId: registration.id, reason: sendable.disabledReason, now, lastError: sendable.disabledReason, notifyCause,
    });
    if (notify && notifyCause) await notifyOwnerOfDisable(input.notifyOwner, input.agentId, notifyCause);
    return { outcome: "disabled" };
  }
  // A personal assistant an admin paused: nothing wakes it. Not a disable: the
  // unread stays and the sweep announces it once its owner starts it again.
  if (sendable.paused) {
    addTraceEvent("agent_inbox_push.paused");
    return { outcome: "paused" };
  }
  // A personal assistant acts as its owner: while the owner's require-SSO refuses them, nothing
  // wakes it either (RFC 083 §6.2). Like a pause: the unread stays, and a later send announces it.
  if (sendable.assistantOwnerUserId) {
    const [owner] = await executor.select({ email: users.email }).from(users).where(eq(users.id, sendable.assistantOwnerUserId));
    if (owner && !(await assistantOwnerPassesSso({ userId: sendable.assistantOwnerUserId, email: owner.email }, executor)).ok) {
      addTraceEvent("agent_inbox_push.owner_sso_required");
      return { outcome: "paused" };
    }
  }
  // Only third-party events that expired while waiting: nothing left to announce.
  input.pending.dropExpired(now.getTime());
  if (input.pending.empty) return { outcome: "nothing_to_send" };
  // A failing endpoint is on its backoff; the notice waits (merged) until then.
  if (registration.consecutiveFailures > 0 && registration.nextAttemptAt.getTime() > now.getTime()) {
    return { outcome: "backoff", retryInMs: registration.nextAttemptAt.getTime() - now.getTime() };
  }

  // A sweep send already holds the lease it claimed (claimSweepNotice). A direct
  // or retry send takes the same lease before its POST, so a sweep on another
  // replica doesn't send a second "new" for this registration while the POST is
  // in flight (seen in prod 10-05: a slow receiver plus the 1-minute sweep made
  // pairs). No CAS: the direct notice carries the newest state and goes anyway.
  // A failed or crashed send needs no cleanup; the lease just expires.
  const directLease = input.mode === "sweep" ? null : new Date(now.getTime() + AGENT_INBOX_NOTICE_DIRECT_LEASE_MS);
  if (directLease) {
    await executor.update(t).set({ leaseExpiresAt: directLease, updatedAt: now }).where(eq(t.id, registration.id));
  }

  const baseTracer = input.tracer ?? noopTracer;
  // Tag the notice (and anything under it) with the receiving agent's and its
  // server's hashes, so duplicate/late notices group per agent or server in one query.
  const tracer = createScopedTracer(baseTracer, {
    ...agentIdHashAttrs(input.agentId),
    ...serverIdHashAttrs(registration.serverId),
  });
  const notice = input.pending.toNotice(input.agentId, now);
  const span = tracer.startSpan("server.agent_push.notice", {
    surface: "server",
    kind: "internal",
    attrs: { mode: input.mode, ...(input.reason ? { reason: input.reason } : {}), targets_count: notice.targets.length },
  });
  try {
    return await runWithTraceSpan(span, async (): Promise<AgentInboxNoticeResult> => {
      const { status, retryAfter, errorCode, responseRequestId, timing, timeoutPhase } = await postNotice(
        registration, notice, input.post, baseTracer === noopTracer ? null : currentRaftTraceId(),
      );
      const finishedAt = clock();
      const outcome = classify(status, errorCode, retryAfter, finishedAt);
      const latencyMs = input.pending.oldestWriteAtMs === null ? null : finishedAt.getTime() - input.pending.oldestWriteAtMs;
      const endAttrs = {
        mode: input.mode,
        ...(input.reason ? { reason: input.reason } : {}),
        outcome: outcome.kind,
        http_status: status || null,
        targets_count: notice.targets.length,
        pending_count: notice.targets.reduce((sum, target) => sum + target.pendingCount, 0),
        // Earliest message in the notice: its write to the receiver's answer.
        latency_ms: latencyMs,
        error_code: outcome.kind === "delivered" ? null : outcome.error,
        // connect: TCP/TLS never finished; response: connected, no first byte.
        "push.timeout_phase": timeoutPhase,
        "push.response_request_id": responseRequestId,
        // Cumulative ms from the start of the POST: DNS lookup, TCP connect, TLS
        // handshake, first response byte. connect/tls are absent on a reused socket.
        ...(timing ? {
          "push.dns_ms": timing.dnsMs,
          "push.connect_ms": timing.connectMs ?? null,
          "push.tls_ms": timing.tlsMs ?? null,
          "push.ttfb_ms": timing.ttfbMs ?? null,
          "push.socket_reused": timing.socketReused,
        } : {}),
      };

      if (outcome.kind === "delivered") {
        await executor.update(t).set({
          consecutiveFailures: 0,
          consecutiveRejections: 0,
          firstUnauthorizedAt: null,
          consecutiveUnauthorized: 0,
          lastAttemptAt: finishedAt,
          lastDeliveryAt: finishedAt,
          lastError: null,
          updatedAt: finishedAt,
        }).where(eq(t.id, registration.id));
        span.end("ok", { attrs: endAttrs });
        return { outcome: "delivered" };
      }

      const [counted] = await executor.update(t).set({
        consecutiveFailures: sql`${t.consecutiveFailures} + 1`,
        // Each run counts only its own kind: a 401 neither counts toward nor
        // keeps the 404/410 run, and any other outcome ends a run of 401s.
        consecutiveRejections: outcome.kind === "rejected" ? sql`${t.consecutiveRejections} + 1` : 0,
        firstUnauthorizedAt: outcome.kind === "unauthorized"
          ? sql`coalesce(${t.firstUnauthorizedAt}, ${finishedAt.toISOString()}::timestamptz)`
          : null,
        consecutiveUnauthorized: outcome.kind === "unauthorized" ? sql`${t.consecutiveUnauthorized} + 1` : 0,
        lastAttemptAt: finishedAt,
        lastError: outcome.error,
        updatedAt: finishedAt,
      }).where(eq(t.id, registration.id)).returning({
        consecutiveFailures: t.consecutiveFailures,
        consecutiveRejections: t.consecutiveRejections,
        firstUnauthorizedAt: t.firstUnauthorizedAt,
        consecutiveUnauthorized: t.consecutiveUnauthorized,
      });
      if (!counted) {
        span.end("ok", { attrs: endAttrs });
        return { outcome: "unregistered" };
      }
      const stop = (outcome.kind === "rejected" && counted.consecutiveRejections >= AGENT_INBOX_PUSH_REJECTION_LIMIT)
        || (outcome.kind === "unauthorized" && counted.firstUnauthorizedAt !== null
          && counted.consecutiveUnauthorized >= AGENT_INBOX_PUSH_UNAUTHORIZED_MIN_COUNT
          && finishedAt.getTime() - counted.firstUnauthorizedAt.getTime() >= AGENT_INBOX_PUSH_UNAUTHORIZED_DISABLE_AFTER_MS);
      if (stop) {
        const { notify } = await disableRegistration(executor, {
          registrationId: registration.id, reason: "endpoint_rejected", now: finishedAt, notifyCause: "endpoint_failing",
        });
        span.end("ok", { attrs: { ...endAttrs, disabled: true } });
        if (notify) await notifyOwnerOfDisable(input.notifyOwner, input.agentId, "endpoint_failing");
        return { outcome: "disabled" };
      }
      if (outcome.kind === "bad_request") {
        console.warn("[AgentInboxPush] receiver refused a notice with 400; retrying on the long schedule");
      }
      const retryInMs = outcome.kind === "retry" && outcome.retryAfterMs !== null
        ? outcome.retryAfterMs
        : agentInboxPushRetryDelayMs(
            counted.consecutiveFailures,
            outcome.kind === "bad_request" ? AGENT_INBOX_PUSH_BAD_REQUEST_RETRY_DELAYS_MS : AGENT_INBOX_PUSH_RETRY_DELAYS_MS,
          );
      await executor.update(t).set({ nextAttemptAt: new Date(finishedAt.getTime() + retryInMs) }).where(eq(t.id, registration.id));
      span.end("ok", { attrs: { ...endAttrs, retry_in_ms: retryInMs } });
      return { outcome: outcome.kind === "unauthorized" ? "rejected" : outcome.kind, retryInMs };
    }, tracer).catch((error: unknown) => {
      span.end("error", { attrs: { mode: input.mode, error_class: errorClassOf(error) } });
      throw error;
    });
  } finally {
    // Hand the registration back right away, but only if the lease is still ours
    // (a newer direct send may have taken its own). Best effort: if this fails the
    // lease simply expires.
    if (directLease) {
      await executor.update(t).set({ leaseExpiresAt: null }).where(and(
        eq(t.id, registration.id),
        sql`date_trunc('milliseconds', ${t.leaseExpiresAt}) = ${directLease.toISOString()}::timestamptz`,
      )).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Sweep

/**
 * The inbox rows a notice for this agent would carry right now, from its
 * durable inbox (bounded read), and whether any unread was written after its
 * last delivered notice. Null when the inbox cannot be read.
 */
async function readUnreadForNotice(
  agentOrchestrator: AgentOrchestrator,
  agentId: string,
  lastDeliveryAt: Date | null,
): Promise<{ pending: PendingNotice; newSinceLastNotice: boolean; maxSeq: number } | null> {
  const pulled = await withStepTimeout(
    "inbox read",
    AGENT_INBOX_NOTICE_SWEEP_READ_TIMEOUT_MS,
    messageService.pullExternalAgentInboxUnshared(agentOrchestrator, agentId),
  );
  if (pulled.status !== "pulled") return null;
  // Rows a cursor-mode pull already handed over are known to the agent; they
  // stay unread only until its next pull acknowledges them. Neither a lost
  // notice nor a reminder applies to them (a reminder there just triggers the
  // acknowledging pull of an agent that read once and went idle).
  const [handed] = await getDb().select({ seqs: agentInboxEventsPendingAcks.seqs })
    .from(agentInboxEventsPendingAcks)
    .where(eq(agentInboxEventsPendingAcks.agentId, agentId))
    .limit(1);
  const handedOver = new Set(Array.isArray(handed?.seqs) ? handed.seqs : []);
  const pending = new PendingNotice();
  let newSinceLastNotice = false;
  let maxSeq = 0;
  for (const message of pulled.messages) {
    if (typeof message.seq === "number" && handedOver.has(message.seq)) continue;
    pending.addMessage(message);
    if (typeof message.seq === "number") maxSeq = Math.max(maxSeq, message.seq);
    const writtenAt = typeof message.timestamp === "string" ? Date.parse(message.timestamp) : Number.NaN;
    if (lastDeliveryAt === null || !Number.isFinite(writtenAt) || writtenAt > lastDeliveryAt.getTime()) newSinceLastNotice = true;
  }
  // Third-party events have no row in the chain; the agent's unacknowledged,
  // unexpired ones are read from their own table. One written after the last
  // delivered notice was never announced (its direct notice was lost).
  const pendingEvents = await withStepTimeout(
    "agent event read",
    AGENT_INBOX_NOTICE_SWEEP_READ_TIMEOUT_MS,
    oauthService.listPendingThirdPartyAgentEventMessages({ agentId, limit: SWEEP_EVENT_LIMIT }),
  );
  for (const message of pendingEvents) {
    pending.addMessage(message);
    const writtenAt = typeof message.timestamp === "string" ? Date.parse(message.timestamp) : Number.NaN;
    if (lastDeliveryAt === null || !Number.isFinite(writtenAt) || writtenAt > lastDeliveryAt.getTime()) newSinceLastNotice = true;
  }
  return { pending, newSinceLastNotice, maxSeq };
}

/**
 * Claim one sweep send on the registration row so exactly one replica sends it
 * (every replica sweeps the same rows). A reminder claims its pending state in
 * reminded_max_seq, so a backlog left unread is reminded once, not every
 * interval and not once per replica. A "new" notice claims with a
 * compare-and-set on last_attempt_at; a direct notice that touched the row in
 * between wins, which is fine: it covers the same unread. Both hold a short
 * lease (lease_expires_at, one POST timeout) until the send finishes, when
 * last_attempt_at is overwritten with the finish time; a crash mid-send just
 * lets the lease expire.
 */
async function claimSweepNotice(input: {
  agentId: string;
  reason: AgentInboxNoticeSweepReason;
  maxSeq: number;
  observedLastAttemptAt: Date | null;
  now: Date;
}): Promise<Date | null> {
  const t = agentInboxPushRegistrations;
  const lease = { leaseExpiresAt: new Date(input.now.getTime() + AGENT_INBOX_NOTICE_POST_TIMEOUT_MS) };
  const [claimed] = await getDb().update(t)
    .set(input.reason === "remind"
      ? { remindedMaxSeq: input.maxSeq, lastAttemptAt: input.now, updatedAt: input.now, ...lease }
      : { lastAttemptAt: input.now, updatedAt: input.now, ...lease })
    .where(and(
      eq(t.agentId, input.agentId),
      // Another replica's sweep send is in flight: last_attempt_at and
      // last_delivery_at only move when it finishes, so without this lease a
      // sweep reading the row mid-send would claim the same "new" notice again.
      sql`(${t.leaseExpiresAt} IS NULL OR ${t.leaseExpiresAt} < ${input.now.toISOString()}::timestamptz)`,
      input.reason === "remind"
        ? sql`coalesce(${t.remindedMaxSeq}, 0) < ${input.maxSeq}`
        : input.observedLastAttemptAt === null
          ? isNull(t.lastAttemptAt)
          : sql`date_trunc('milliseconds', ${t.lastAttemptAt}) = ${input.observedLastAttemptAt.toISOString()}::timestamptz`,
    ))
    .returning({ id: t.id });
  return claimed ? lease.leaseExpiresAt : null;
}

/**
 * Send a notice for each enabled registration (not backing off) whose inbox has
 * unread, when some was written after its last delivered notice ("new") or
 * that notice is older than the reminder interval and the pending state was
 * not reminded of already ("remind"). Idempotent: every
 * replica may run it; a duplicate notice is harmless.
 */
export async function sweepAgentInboxNotices(input: {
  agentOrchestrator: AgentOrchestrator;
  post?: WebhookPost;
  tracer?: Tracer;
  clock?: () => Date;
  agentIds?: readonly string[];
  skip?: (agentId: string) => boolean;
  remindAfterMs?: number;
  notifyOwner?: AgentInboxPushOwnerNotifier;
}): Promise<{ checked: number; sent: number; failed: number }> {
  const clock = input.clock ?? currentDate;
  const remindAfterMs = input.remindAfterMs ?? AGENT_INBOX_NOTICE_REMIND_AFTER_MS;
  const tracer = input.tracer ?? noopTracer;
  const t = agentInboxPushRegistrations;
  const span = tracer.startSpan("server.agent_push.sweep", { surface: "server", kind: "internal" });
  const totals = { checked: 0, sent: 0, failed: 0 };
  try {
    const now = clock();
    const due = await getDb().select({
      agentId: t.agentId,
      lastDeliveryAt: t.lastDeliveryAt,
      lastAttemptAt: t.lastAttemptAt,
      remindedMaxSeq: t.remindedMaxSeq,
    })
      .from(t)
      .where(and(
        isNull(t.disabledAt),
        sql`(${t.consecutiveFailures} = 0 OR ${t.nextAttemptAt} <= ${now.toISOString()}::timestamptz)`,
        // A paused assistant is not woken (sendAgentInboxNotice refuses too).
        sql`NOT EXISTS (SELECT 1 FROM ${agents} a WHERE a.id = ${t.agentId} AND a.assistant_paused_at IS NOT NULL)`,
        ...(input.agentIds ? [sql`${t.agentId} IN ${input.agentIds}`] : []),
      ))
      .limit(SWEEP_BATCH_SIZE);
    for (const { agentId, lastDeliveryAt, lastAttemptAt, remindedMaxSeq } of due) {
      if (input.skip?.(agentId)) continue;
      totals.checked += 1;
      try {
        const unread = await readUnreadForNotice(input.agentOrchestrator, agentId, lastDeliveryAt);
        if (!unread) continue;
        if (unread.pending.empty) {
          if (remindedMaxSeq !== null) {
            await getDb().update(t).set({ remindedMaxSeq: null })
              .where(and(eq(t.agentId, agentId), eq(t.remindedMaxSeq, remindedMaxSeq)));
          }
          continue;
        }
        const reason: AgentInboxNoticeSweepReason | null = unread.newSinceLastNotice
          ? "new"
          : (lastDeliveryAt === null || now.getTime() - lastDeliveryAt.getTime() >= remindAfterMs)
            && unread.maxSeq > (remindedMaxSeq ?? 0)
            ? "remind"
            : null;
        if (!reason) continue;
        const leaseExpiresAt = await claimSweepNotice({ agentId, reason, maxSeq: unread.maxSeq, observedLastAttemptAt: lastAttemptAt, now });
        if (!leaseExpiresAt) {
          addTraceEvent("agent_inbox_push.sweep_claim_lost", { reason });
          continue;
        }
        let delivered = false;
        try {
          const result = await runWithTraceSpan(span, () => sendAgentInboxNotice({
            agentId, pending: unread.pending, mode: "sweep", reason, post: input.post, tracer, clock, notifyOwner: input.notifyOwner,
          }), tracer);
          delivered = result.outcome === "delivered";
        } finally {
          // End the lease; a failed or thrown reminder also releases its claim
          // so the backoff retry can send it.
          await getDb().update(t).set({
            leaseExpiresAt: null,
            ...(!delivered && reason === "remind" ? { remindedMaxSeq: sql`CASE WHEN ${t.remindedMaxSeq} = ${unread.maxSeq} THEN ${remindedMaxSeq} ELSE ${t.remindedMaxSeq} END` } : {}),
          }).where(and(
            eq(t.agentId, agentId),
            // Only our own lease: a send that outlived it may have been re-claimed.
            sql`date_trunc('milliseconds', ${t.leaseExpiresAt}) = ${leaseExpiresAt.toISOString()}::timestamptz`,
          ));
        }
        if (delivered) totals.sent += 1;
        else totals.failed += 1;
      } catch (error) {
        totals.failed += 1;
        console.error("[AgentInboxPush] sweep notice failed", serializeErrorForLog(error));
      }
    }
    span.end("ok", { attrs: { checked: totals.checked, sent: totals.sent, failed: totals.failed } });
    return totals;
  } catch (error) {
    span.end("error", { attrs: { error_class: errorClassOf(error) } });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Recovery probe

/** The probe's backoff after a failed probe scheduled with `previousMs`: doubled, capped at 24 hours. */
export function agentInboxPushNextProbeBackoffMs(previousMs: number | null): number {
  return Math.min(Math.max(previousMs ?? AGENT_INBOX_PUSH_PROBE_FIRST_DELAY_MS, AGENT_INBOX_PUSH_PROBE_FIRST_DELAY_MS) * 2, AGENT_INBOX_PUSH_PROBE_MAX_DELAY_MS);
}

/**
 * Probe each endpoint_rejected registration whose probe is due: a notice with
 * no targets ("Inbox update: no pending targets"), signed and bounded like any
 * notice. A push is only a wake signal (the agent pulls /events), so an extra
 * one is harmless. A 2xx re-enables the registration (no owner notice) and
 * `onRecovered` lets the sweep announce what is unread; anything else doubles
 * the backoff, up to 24 hours. Each probe is claimed on the row (next_probe_at
 * moved past the POST), so one replica sends it. A registration whose
 * credential was revoked or whose agent went away since is not probed: it gets
 * that reason instead, which no probe can recover from. A registration stopped
 * for 30 days stops being probed (probe_stopped_at) and is never claimed
 * again; a new PUT clears that.
 */
export async function probeDisabledAgentInboxPushRegistrations(input: {
  post?: WebhookPost;
  tracer?: Tracer;
  clock?: () => Date;
  agentIds?: readonly string[];
  onRecovered?: (agentId: string) => void;
} = {}): Promise<{ probed: number; recovered: number }> {
  const clock = input.clock ?? currentDate;
  const tracer = input.tracer ?? noopTracer;
  const t = agentInboxPushRegistrations;
  const totals = { probed: 0, recovered: 0 };
  // Due: next_probe_at has passed, or is unset (stopped before this probe existed, or by a replica
  // that predates it), which probes at once.
  const probeDue = (at: Date) => sql`coalesce(${t.nextProbeAt}, '-infinity'::timestamptz) <= ${at.toISOString()}::timestamptz`;
  const due = await getDb().select({ id: t.id, agentId: t.agentId }).from(t).where(and(
    isNotNull(t.disabledAt),
    eq(t.disabledReason, "endpoint_rejected"),
    isNull(t.probeStoppedAt),
    probeDue(clock()),
    // A paused assistant is not woken; its probe waits until it is started again.
    sql`NOT EXISTS (SELECT 1 FROM ${agents} a WHERE a.id = ${t.agentId} AND a.assistant_paused_at IS NOT NULL)`,
    ...(input.agentIds ? [sql`${t.agentId} IN ${input.agentIds}`] : []),
  )).limit(SWEEP_BATCH_SIZE);
  for (const { id, agentId } of due) {
    try {
      // The claim moves next_probe_at past this probe's POST, so one replica sends it.
      const now = clock();
      const [claimed] = await getDb().update(t)
        .set({ nextProbeAt: new Date(now.getTime() + AGENT_INBOX_NOTICE_DIRECT_LEASE_MS) })
        .where(and(eq(t.id, id), isNotNull(t.disabledAt), eq(t.disabledReason, "endpoint_rejected"), isNull(t.probeStoppedAt), probeDue(now)))
        .returning({ disabledAt: t.disabledAt, probeBackoffMs: t.probeBackoffMs });
      if (!claimed?.disabledAt) continue;
      const stillDisabled = and(
        eq(t.id, id),
        eq(t.disabledReason, "endpoint_rejected"),
        sql`date_trunc('milliseconds', ${t.disabledAt}) = ${claimed.disabledAt.toISOString()}::timestamptz`,
      );
      const loaded = await loadRegistrationAuthority(agentId, getDb());
      // Gone, or re-registered (a PUT) since the claim: nothing to probe.
      if (!loaded || loaded.registration.disabledAt?.getTime() !== claimed.disabledAt.getTime()) continue;
      if (now.getTime() - claimed.disabledAt.getTime() >= AGENT_INBOX_PUSH_PROBE_GIVE_UP_AFTER_MS) {
        // Stopped for 30 days: give up for good (no owner notice); only a new PUT resumes delivery.
        await getDb().update(t).set({ probeStoppedAt: now, nextProbeAt: null, updatedAt: now }).where(stillDisabled);
        addTraceEvent("agent_inbox_push.probe_stopped");
        continue;
      }
      if (loaded.disabledReason) {
        await getDb().update(t).set({
          disabledReason: loaded.disabledReason, lastError: loaded.disabledReason, nextProbeAt: null, probeBackoffMs: null, updatedAt: now,
        }).where(stillDisabled);
        continue;
      }
      totals.probed += 1;
      const span = tracer.startSpan("server.agent_push.probe", {
        surface: "server",
        kind: "internal",
        attrs: { ...agentIdHashAttrs(agentId), ...serverIdHashAttrs(loaded.registration.serverId) },
      });
      const result = await runWithTraceSpan(span, () => postNotice(
        loaded.registration, new PendingNotice().toNotice(agentId, now), input.post, tracer === noopTracer ? null : currentRaftTraceId(),
      ), tracer);
      const finishedAt = clock();
      const outcome = classify(result.status, result.errorCode, result.retryAfter, finishedAt);
      if (outcome.kind === "delivered") {
        const [recovered] = await getDb().update(t).set({
          disabledAt: null,
          disabledReason: null,
          consecutiveFailures: 0,
          consecutiveRejections: 0,
          firstUnauthorizedAt: null,
          consecutiveUnauthorized: 0,
          nextProbeAt: null,
          probeBackoffMs: null,
          nextAttemptAt: finishedAt,
          lastAttemptAt: finishedAt,
          lastError: null,
          updatedAt: finishedAt,
        }).where(stillDisabled).returning({ id: t.id });
        span.end("ok", { attrs: { outcome: "recovered", http_status: result.status } });
        if (recovered) {
          totals.recovered += 1;
          addTraceEvent("agent_inbox_push.recovered");
          input.onRecovered?.(agentId);
        }
        continue;
      }
      const backoffMs = agentInboxPushNextProbeBackoffMs(claimed.probeBackoffMs);
      await getDb().update(t).set({
        nextProbeAt: new Date(finishedAt.getTime() + backoffMs),
        probeBackoffMs: backoffMs,
        lastAttemptAt: finishedAt,
        lastError: outcome.error,
        updatedAt: finishedAt,
      }).where(stillDisabled);
      span.end("ok", { attrs: { outcome: outcome.kind, http_status: result.status || null, error_code: outcome.error, next_probe_in_ms: backoffMs } });
    } catch (error) {
      console.error("[AgentInboxPush] recovery probe failed", serializeErrorForLog(error));
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Worker

interface AgentNoticeState {
  pending: PendingNotice;
  inFlight: boolean;
  retryTimer: unknown;
}

interface ActiveWorker {
  kick(agentId: string): void;
}

let activeWorker: ActiveWorker | null = null;

/**
 * Per replica: notices on delivery (merged per agent while one is in flight or
 * backing off, retried in memory with the latest merged state) and the
 * periodic sweep.
 */
export function startAgentInboxPushWorker(input: {
  agentOrchestrator: AgentOrchestrator;
  post?: WebhookPost;
  /** Required: the drain/notice spans must reach the server's trace sink (no silent noop in production wiring). */
  tracer: Tracer;
  clock?: () => Date;
  sweepIntervalMs?: number;
  /** Test seam: the in-memory retry timer's delay for a given backoff. */
  retryTimerMs?: (backoffMs: number) => number;
  /** Posts the owner's notice when a registration stops (server.ts: the agent's DM with its owner). */
  notifyOwner?: AgentInboxPushOwnerNotifier;
}) {
  const states = new Map<string, AgentNoticeState>();
  let stopped = false;
  let sweeping = false;

  const stateFor = (agentId: string): AgentNoticeState => {
    let state = states.get(agentId);
    if (!state) {
      state = { pending: new PendingNotice(), inFlight: false, retryTimer: null };
      states.set(agentId, state);
    }
    return state;
  };

  const send = async (agentId: string, mode: AgentInboxNoticeMode): Promise<void> => {
    const state = states.get(agentId);
    if (!state || state.inFlight || state.pending.empty || stopped) return;
    if (mode !== "retry" && state.retryTimer !== null) return; // waiting out a backoff
    state.inFlight = true;
    const taken = state.pending;
    state.pending = new PendingNotice();
    let result: AgentInboxNoticeResult;
    try {
      result = await sendAgentInboxNotice({
        agentId, pending: taken, mode, post: input.post, tracer: input.tracer, clock: input.clock, notifyOwner: input.notifyOwner,
      });
    } catch (error) {
      console.error("[AgentInboxPush] notice failed", serializeErrorForLog(error));
      result = { outcome: "retry", retryInMs: AGENT_INBOX_PUSH_RETRY_DELAYS_MS[0] };
    } finally {
      state.inFlight = false;
    }
    // Paused: dropped here; the sweep announces what is still unread once the owner starts it again.
    if (result.outcome === "delivered" || result.outcome === "disabled" || result.outcome === "paused" || result.outcome === "unregistered" || result.outcome === "nothing_to_send") {
      if (result.outcome !== "delivered") state.pending = new PendingNotice();
      if (!state.pending.empty) void send(agentId, "direct");
      else if (state.retryTimer === null) states.delete(agentId);
      return;
    }
    // Failed or backing off: the newer rows supersede, the failed ones are
    // merged back; one retry later sends the latest merged state.
    taken.absorb(state.pending);
    state.pending = taken;
    if (state.retryTimer !== null || stopped) return;
    state.retryTimer = setClockTimeout(() => {
      state.retryTimer = null;
      void send(agentId, "retry");
    }, (input.retryTimerMs ?? ((ms: number) => ms))(result.retryInMs ?? AGENT_INBOX_PUSH_RETRY_DELAYS_MS[0]!));
  };

  const onDelivered = (agentId: unknown, message?: unknown) => {
    if (typeof agentId !== "string" || stopped) return;
    const candidate = message as AgentMessage | undefined;
    if (!candidate || typeof candidate !== "object") return;
    // A persisted message (positive seq), or a third-party app event, which has
    // no durable row and is announced by its event id.
    const durable = Number.isInteger(candidate.seq) && (candidate.seq ?? 0) > 0 && !candidate.third_party_event;
    if (!durable && !candidate.third_party_event?.id) return;
    stateFor(agentId).pending.addMessage(candidate);
    void send(agentId, "direct");
  };
  input.agentOrchestrator.on("external-inbox-delivered", onDelivered);

  const sweep = (agentIds?: readonly string[]) => {
    if (sweeping && !agentIds) return;
    if (!agentIds) sweeping = true;
    sweepAgentInboxNotices({
      agentOrchestrator: input.agentOrchestrator,
      post: input.post,
      tracer: input.tracer,
      clock: input.clock,
      agentIds,
      // An agent with a notice pending or in flight here is covered already.
      skip: (agentId) => states.has(agentId),
      notifyOwner: input.notifyOwner,
    })
      .catch((error) => console.error("[AgentInboxPush] sweep failed", serializeErrorForLog(error)))
      .finally(() => {
        if (!agentIds) sweeping = false;
      });
  };
  // Stopped endpoints are probed on the same interval, on a chain of their own
  // so slow probes never hold up the sweep. One that answers is swept at once,
  // so its unread is announced.
  let probing = false;
  const probe = () => {
    if (probing) return;
    probing = true;
    probeDisabledAgentInboxPushRegistrations({
      post: input.post,
      tracer: input.tracer,
      clock: input.clock,
      onRecovered: (agentId) => {
        if (!stopped) sweep([agentId]);
      },
    })
      .catch((error) => console.error("[AgentInboxPush] recovery probes failed", serializeErrorForLog(error)))
      .finally(() => {
        probing = false;
      });
  };
  const handle = setClockInterval(() => {
    sweep();
    probe();
  }, input.sweepIntervalMs ?? AGENT_INBOX_NOTICE_SWEEP_INTERVAL_MS);
  if (typeof handle === "object" && handle && "unref" in handle && typeof handle.unref === "function") handle.unref();
  const worker: ActiveWorker = { kick: (agentId) => sweep([agentId]) };
  activeWorker = worker;
  return {
    /** Resolves when no notice is in flight or pending on this replica (tests). */
    async idle() {
      while ([...states.values()].some((state) => state.inFlight || (!state.pending.empty && state.retryTimer === null))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    stop() {
      stopped = true;
      input.agentOrchestrator.off("external-inbox-delivered", onDelivered);
      clearClockInterval(handle);
      for (const state of states.values()) if (state.retryTimer !== null) clearClockTimeout(state.retryTimer);
      states.clear();
      if (activeWorker === worker) activeWorker = null;
    },
  };
}

export { PendingNotice as AgentInboxPendingNotice };
