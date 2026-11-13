/**
 * Re-delivery of pending third-party app events (`third_party_agent_events`)
 * to managed agents (agents run by a Raft Computer).
 *
 * An app event has no durable chain row, so the resume catch-up never carries
 * it. Its only push is the one made when it is written (POST
 * /api/oauth/agent-events, `deliverSystemAppAgentEvent`): when that push is
 * parked because the agent's computer is offline, and the park outlives the
 * in-memory ack-retry record (30 min), nothing sent it again. The row stayed
 * `delivering` until some unrelated wake made the agent check its messages.
 *
 * Two triggers re-send such rows through `deliverMessage`, the path the first
 * push takes, so every delivery gate applies again (stopped agent, reset,
 * crash-loop hold, passive scope, RaftBench, the wake plan):
 *
 * - `machine_ready` (the reconnect pass): the replica that receives the
 *   computer's `ready` (it holds the socket), for the managed agents assigned
 *   to it, and only after a real outage (planReconnectRedelivery): one longer
 *   than the parked ack-retry record lives (shorter ones are that record's
 *   job), with a known start, from a daemon that reports delivered events.
 *   It only looks at rows created during the outage (from its start, less
 *   the heartbeat timeout and 30 s, since a half-open socket is only noticed
 *   that late), the events that cannot have reached the computer; an online
 *   agent's older unread rows are never touched by it. For those rows, in
 *   this order (so the backlog is cleaned before anything is sent):
 *   1. older than 24 h: marked `expired` (`expired_stale_backlog`);
 *   2. of the rest due now (last push at least 2 minutes ago), the 20 newest
 *      are kept, the others marked `expired` (`expired_over_cap`);
 *   3. the summary of 1 and 2 (count per app) goes ahead of the late note on
 *      the first kept event the agent accepts (`summary_attached`).
 * - `sweep` (safety net, OFF by default: `THIRD_PARTY_EVENT_REDELIVERY_SWEEP_ENABLED`).
 *   The server cannot tell a row that never reached the computer from one the
 *   agent was told about (an "Inbox update" notice) and has not read, and
 *   each re-send to an idle agent is a paid wake: an ignored notification
 *   could wake its agent about eight times a day. It stays off until the
 *   daemon's receipt is recorded and the sweep can skip received rows.
 *   When on: every 5 minutes, each replica, for the managed
 *   agents whose computer is connected to it (and reports delivered events).
 *   It never marks anything expired and sends no summary: rows older than
 *   24 h are just not sent again (their own `expires_at` still governs them),
 *   and past the 20 newest due rows per agent the rest wait for a later pass
 *   (`deferred_over_cap`): the agent is online, so they may already sit
 *   unread in its computer's inbox. A row is due once its last push is at
 *   least 10 minutes old, and then backs off exponentially (it waits at least
 *   as long as it had been pending at its last push): at most about eight
 *   sends in its 24 h.
 *
 * Both leave rows created in the last 31 minutes alone: a parked ack-retry
 * record for them may still live on the replica that made the first push
 * (it re-sends them when the computer is back), and this replica cannot see
 * it; a later sweep (when the sweep is on) picks them up once that record has expired.
 *
 * Both then run the kept rows through their system app's delivery guard
 * (`systemAppDeliveryGuards`: vetoed rows are expired, withheld rows left as
 * they are), claim each with a compare-and-set on its row (status pending and
 * `updated_at` still before its wait, set to now: two replicas or two passes
 * never both send it), and send them oldest first, each prefixed with a note
 * that it is late. Event ids this replica still has an ack-retry record or a
 * pending start for are skipped (that record re-sends them). Re-sending to an
 * online agent is harmless: its daemon drops a copy it holds
 * (`samePendingDelivery`) or has already shown (`dropped_already_consumed`).
 *
 * Never touched here: rows already delivered or rejected, rows past
 * `expires_at`, external agents (their inbox push sweep covers them), and
 * `system.assistant` rows (hosted assistants with no computer; left as they
 * are until their delivery write-back is fixed).
 *
 * Known gap: when the reconnect pass delivers nothing to an agent (e.g. its
 * computer was offline for more than 24 h, so every outage row was stale, or
 * every kept row was refused), the agent is not told about the expired rows.
 * A standalone notice needs a real address, i.e. a new system-app event source
 * (a `system_app` value: migration + delivery guard).
 *
 * Kill switch: THIRD_PARTY_EVENT_REDELIVERY_ENABLED=false turns every pass
 * into a no-op (default on).
 */
import { and, asc, eq, inArray, isNull, ne, not, or, sql, type SQL } from "drizzle-orm";
import {
  EXTERNAL_AGENT_RUNTIME_ID,
  compareComputerVersions,
  currentDate,
  formatUtcTimestamp,
  isComputerSemver,
  noopTracer,
  renderThirdPartyInertText,
  type AgentMessage,
  type Tracer,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, oauthClients, thirdPartyAgentEvents } from "../db/schema";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import type { AgentMessageDeliveryResult, AgentOrchestrator } from "./agentOrchestrator";
import { THIRD_PARTY_EVENT_APP_COLUMNS, buildThirdPartyAgentMessage } from "./oauthService";
import { partitionDeliverableSystemAppEvents } from "./systemAppDeliveryGuards";

export type ThirdPartyEventRedeliveryTrigger = "machine_ready" | "sweep";

/** Only rows created this recently are delivered again. */
export const THIRD_PARTY_EVENT_REDELIVERY_MAX_AGE_MS = 24 * 60 * 60_000;
/**
 * Per agent per pass: the newest this many due rows are sent. The rest are
 * expired (and summarised) by the reconnect pass, left pending by the sweep.
 */
export const THIRD_PARTY_EVENT_REDELIVERY_PER_AGENT_CAP = 20;
/** Per pass: at most this many rows sent; agents past it wait for the next pass (untouched). */
export const THIRD_PARTY_EVENT_REDELIVERY_TOTAL_CAP = 100;
/** Machine ready: a row's last push (or claim) must be at least this old before it is sent again. */
export const THIRD_PARTY_EVENT_REDELIVERY_GRACE_MS = 2 * 60_000;
/** Sweep: the minimum wait since a row's last push (the backoff can make it longer). */
export const THIRD_PARTY_EVENT_REDELIVERY_SWEEP_GRACE_MS = 10 * 60_000;
export const THIRD_PARTY_EVENT_REDELIVERY_SWEEP_INTERVAL_MS = 5 * 60_000;
/**
 * Reconnect pass: rows created this long before the outage start still count
 * as outage rows: the heartbeat timeout (AgentOrchestrator
 * MACHINE_HEARTBEAT_TIMEOUT_MS, 60 s) plus 30 s, since a socket that went
 * half-open is only closed (and the close time recorded) that much later.
 */
export const THIRD_PARTY_EVENT_REDELIVERY_OUTAGE_SLACK_MS = 90_000;
/**
 * Both passes: rows newer than the parked ack-retry record lifetime
 * (`parkedMaxMs`) plus this margin are left to that record, which may live on
 * another replica.
 */
export const THIRD_PARTY_EVENT_REDELIVERY_PARK_MARGIN_MS = 60_000;
/** AgentOrchestrator.AGENT_DELIVERY_PARKED_MAX_MS, the default `parkedMaxMs`. */
const DEFAULT_PARKED_MAX_MS = 30 * 60_000;
/**
 * First daemon that reports the third-party events it served as delivered
 * (task #175, #8564). An older one never does, so every pass would send it
 * the same rows again: both triggers skip its machines.
 */
export const THIRD_PARTY_EVENT_DELIVERED_REPORT_DAEMON_VERSION = "1.0.40";
/** Bounds the candidate read of one pass; rows past it are seen by the next pass. */
const CANDIDATE_READ_LIMIT = 5_000;
/** App display names in the summary are cut to this many characters. */
const SUMMARY_APP_NAME_MAX_CHARS = 40;

/** Never re-delivered, expired or summarised here (see the header). */
const EXCLUDED_SYSTEM_APP = "system.assistant";

/**
 * Agent-facing copy (English), in one place for review.
 * - `lateNote` prefixes every re-delivered event (both triggers). `{createdAt}`
 *   is the event's creation time in the `time=` header format
 *   (formatUtcTimestamp, e.g. 2026-10-22 22:50:00Z).
 * - `notDelivered*` (reconnect pass only) goes ahead of the late note on the
 *   first event re-delivered to the agent in that pass. `{count}`: the outage
 *   rows that pass expired for the agent (older than 24 h, or beyond the
 *   newest `{cap}`); `{apps}`: their count per app display name, e.g.
 *   "Reminder 2, Stamp 1".
 */
export const THIRD_PARTY_EVENT_REDELIVERY_COPY = {
  lateNote: "Delivered late: this app notification was created at {createdAt} and did not reach you then. Check that it still applies before you act on it.",
  notDeliveredOne: "1 app notification ({apps}) from while your computer was offline was not delivered: it was older than 24 hours, or beyond the newest {cap}. If you were waiting on it, check the app that sends it.",
  notDeliveredMany: "{count} app notifications ({apps}) from while your computer was offline were not delivered: they were older than 24 hours, or beyond the newest {cap}. If you were waiting on one, check the app that sends it.",
} as const;

export const THIRD_PARTY_EVENT_REDELIVERY_ENABLED_ENV = "THIRD_PARTY_EVENT_REDELIVERY_ENABLED";

export const THIRD_PARTY_EVENT_REDELIVERY_SWEEP_ENABLED_ENV = "THIRD_PARTY_EVENT_REDELIVERY_SWEEP_ENABLED";

/**
 * The sweep is off unless THIRD_PARTY_EVENT_REDELIVERY_SWEEP_ENABLED is true / 1 / on
 * (see the header: it cannot tell an unread notice from a lost delivery). Read on
 * every tick, so it can be turned on or off without a restart. The reconnect pass
 * does not depend on it.
 */
export function isThirdPartyEventRedeliverySweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[THIRD_PARTY_EVENT_REDELIVERY_SWEEP_ENABLED_ENV]?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "on";
}

/** Kill switch: on unless THIRD_PARTY_EVENT_REDELIVERY_ENABLED is false / 0 / off. */
export function isThirdPartyEventRedeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[THIRD_PARTY_EVENT_REDELIVERY_ENABLED_ENV]?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off");
}

/** True when this daemon version reports delivered third-party events (unknown: no). */
export function daemonReportsDeliveredThirdPartyEvents(version: string | null | undefined): boolean {
  if (!version || !isComputerSemver(version)) return false;
  return compareComputerVersions(version, THIRD_PARTY_EVENT_DELIVERED_REPORT_DAEMON_VERSION) >= 0;
}

export type ReconnectRedeliveryPlan =
  | { action: "run"; outageStartedAt: Date; outageMs: number }
  | { action: "skipped_old_daemon" | "skipped_unknown_disconnect" | "skipped_heartbeat_read_failed" }
  | { action: "skipped_short_outage"; outageMs: number };

/**
 * The outage start a `ready` is judged by. The persisted last heartbeat must
 * be known and predate the new connection (a pong on the new connection
 * overwrites it): without it the start is unknown, even when this replica
 * saw a socket close, since that close may belong to an older session. This
 * replica's close time of the previous connection replaces it only when it
 * is not earlier than the heartbeat (the later time: a shorter outage).
 */
export type OutageStart = { kind: "known"; at: Date } | { kind: "unknown" } | { kind: "heartbeat_read_failed" };

export function resolveOutageStart(input: {
  lastHeartbeat: Date | null | "read_failed";
  closedAt: number | undefined;
  connectedAt: number;
}): OutageStart {
  if (input.lastHeartbeat === "read_failed") return { kind: "heartbeat_read_failed" };
  const heartbeat = input.lastHeartbeat?.getTime();
  if (heartbeat === undefined || heartbeat > input.connectedAt) return { kind: "unknown" };
  const closedAt = input.closedAt;
  const at = closedAt !== undefined && closedAt >= heartbeat && closedAt <= input.connectedAt ? closedAt : heartbeat;
  return { kind: "known", at: new Date(at) };
}

/**
 * Whether a `ready` starts a reconnect pass. `ready` comes with every socket
 * reconnect (deploys, network blips): only an outage longer than the parked
 * ack-retry record lives (`parkedMaxMs`; shorter ones are that record's job)
 * with a known start does. Unknown start: skipped (fail safe; the sweep still
 * runs).
 */
export function planReconnectRedelivery(input: {
  daemonVersion: string | null | undefined;
  outageStart: OutageStart;
  reconnectedAt: Date;
  parkedMaxMs: number;
}): ReconnectRedeliveryPlan {
  if (!daemonReportsDeliveredThirdPartyEvents(input.daemonVersion)) return { action: "skipped_old_daemon" };
  if (input.outageStart.kind === "heartbeat_read_failed") return { action: "skipped_heartbeat_read_failed" };
  if (input.outageStart.kind === "unknown") return { action: "skipped_unknown_disconnect" };
  const outageStartedAt = input.outageStart.at;
  const outageMs = input.reconnectedAt.getTime() - outageStartedAt.getTime();
  if (outageMs < input.parkedMaxMs) return { action: "skipped_short_outage", outageMs };
  return { action: "run", outageStartedAt, outageMs };
}

export type ThirdPartyEventRedeliverer = Pick<AgentOrchestrator, "deliverMessage">;

type EventRow = typeof thirdPartyAgentEvents.$inferSelect;

/** The note that prefixes a re-delivered event's text. */
export function formatThirdPartyEventLateNote(createdAt: Date): string {
  return THIRD_PARTY_EVENT_REDELIVERY_COPY.lateNote.replace("{createdAt}", formatUtcTimestamp(createdAt));
}

/** An app display name fit for one line of the summary: no control characters, at most 40 characters. */
export function boundSummaryAppName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const oneLine = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim() || "App";
  // An external app's name is its own text, and this summary may ride on a Raft
  // system app's event, which is delivered as written: make the name inert here.
  const flat = renderThirdPartyInertText({ field: "app_name", value: oneLine });
  const chars = [...flat];
  return chars.length <= SUMMARY_APP_NAME_MAX_CHARS ? flat : `${chars.slice(0, SUMMARY_APP_NAME_MAX_CHARS - 1).join("").trimEnd()}…`;
}

/**
 * The summary of the rows a reconnect pass expired for one agent, by app
 * display name (most first, then by name). Null when there are none.
 */
export function formatNotDeliveredThirdPartyEventsSummary(countsByApp: ReadonlyMap<string, number>): string | null {
  const bounded = new Map<string, number>();
  for (const [app, n] of countsByApp) {
    const name = boundSummaryAppName(app);
    bounded.set(name, (bounded.get(name) ?? 0) + n);
  }
  const count = [...bounded.values()].reduce((sum, n) => sum + n, 0);
  if (count === 0) return null;
  const apps = [...bounded.entries()]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([app, n]) => `${app} ${n}`)
    .join(", ");
  const template = count === 1
    ? THIRD_PARTY_EVENT_REDELIVERY_COPY.notDeliveredOne
    : THIRD_PARTY_EVENT_REDELIVERY_COPY.notDeliveredMany;
  return template
    .replace("{count}", String(count))
    .replace("{apps}", apps)
    .replace("{cap}", String(THIRD_PARTY_EVENT_REDELIVERY_PER_AGENT_CAP));
}

/**
 * The message the first push sends (buildThirdPartyAgentMessage: same id,
 * original timestamp, so `time=` stays the creation time), its text prefixed
 * with the late note, and with `summary` ahead of that when given. Only the
 * re-delivery path adds them.
 */
export function buildRedeliveredThirdPartyAgentMessage(input: {
  event: EventRow;
  clientKey: string;
  clientName: string;
}, summary: string | null = null): AgentMessage {
  const message = buildThirdPartyAgentMessage(input);
  const prefix = [summary, formatThirdPartyEventLateNote(input.event.createdAt)].filter(Boolean).join("\n\n");
  return { ...message, content: `${prefix}\n\n${message.content}` };
}

const t = thirdPartyAgentEvents;

/** Pending, not past expires_at, not a hosted assistant's row. */
function pendingPredicates(now: Date): SQL[] {
  return [
    or(eq(t.status, "queued"), eq(t.status, "delivering"))!,
    isNull(t.deliveredAt),
    sql`${t.expiresAt} > ${now}`,
    or(isNull(t.systemApp), ne(t.systemApp, EXCLUDED_SYSTEM_APP))!,
  ];
}

type PassScope =
  | { trigger: "sweep" }
  | { trigger: "machine_ready"; outageStartedAt: Date };

/** Reconnect pass: only rows created during the outage. */
function scopePredicates(scope: PassScope): SQL[] {
  if (scope.trigger === "sweep") return [];
  return [sql`${t.createdAt} >= ${new Date(scope.outageStartedAt.getTime() - THIRD_PARTY_EVENT_REDELIVERY_OUTAGE_SLACK_MS)}`];
}

/**
 * Pending, in scope, recent enough but older than any park, not excluded, and
 * its wait since the last push is over.
 */
function duePredicates(now: Date, scope: PassScope, excludeEventIds: readonly string[], parkedMaxMs: number): SQL[] {
  const staleBefore = new Date(now.getTime() - THIRD_PARTY_EVENT_REDELIVERY_MAX_AGE_MS);
  const parkCutoff = new Date(now.getTime() - parkedMaxMs - THIRD_PARTY_EVENT_REDELIVERY_PARK_MARGIN_MS);
  const wait = scope.trigger === "machine_ready"
    ? sql`${t.updatedAt} <= ${new Date(now.getTime() - THIRD_PARTY_EVENT_REDELIVERY_GRACE_MS)}`
    // Exponential: wait at least as long as the row had been pending at its last push.
    : sql`${t.updatedAt} <= ${now}::timestamptz - greatest(${THIRD_PARTY_EVENT_REDELIVERY_SWEEP_GRACE_MS}::double precision * interval '1 millisecond', ${t.updatedAt} - ${t.createdAt})`;
  return [
    ...pendingPredicates(now),
    ...scopePredicates(scope),
    sql`${t.createdAt} > ${staleBefore}`,
    sql`${t.createdAt} <= ${parkCutoff}`,
    wait,
    ...(excludeEventIds.length > 0 ? [not(inArray(t.id, [...excludeEventIds]))] : []),
  ];
}

export type ThirdPartyEventRedeliveryResult = {
  outcome: "disabled" | "no_agents" | "processed";
  /** Reconnect pass: outage rows older than 24 h, expired. */
  expiredStaleBacklog: number;
  /** Reconnect pass: due outage rows past the per-agent cap, expired. */
  expiredOverCap: number;
  /** Sweep: due rows past the per-agent cap, left pending for a later pass. */
  deferredOverCap: number;
  /** Re-delivered events the summary rode on (accepted by deliverMessage; the daemon may still drop a copy it has). */
  summaryAttached: number;
  guardRejected: number;
  guardHeld: number;
  claimed: number;
  /** deliverMessage answered `queued`. */
  redelivered: number;
  /** deliverMessage answered `dropped` (a delivery gate: stopped agent, scope, ...). */
  dropped: number;
  failed: number;
  capped: boolean;
  skippedAgents: number;
};

function emptyResult(outcome: ThirdPartyEventRedeliveryResult["outcome"]): ThirdPartyEventRedeliveryResult {
  return {
    outcome, expiredStaleBacklog: 0, expiredOverCap: 0, deferredOverCap: 0, summaryAttached: 0, guardRejected: 0, guardHeld: 0,
    claimed: 0, redelivered: 0, dropped: 0, failed: 0, capped: false, skippedAgents: 0,
  };
}

/**
 * One pass over these managed agents (see the header). The caller passes only
 * managed agents on computers whose daemon reports delivered events, and, for
 * the reconnect pass, the outage start (planReconnectRedelivery).
 * `excludeEventIds`: events this replica still re-sends itself (ack-retry
 * record, pending start). `machineId` is a trace attribute.
 */
export async function redeliverPendingThirdPartyAgentEvents(input: PassScope & {
  agentIds: readonly string[];
  deliverer: ThirdPartyEventRedeliverer;
  excludeEventIds?: readonly string[];
  /** The parked ack-retry record lifetime (AgentOrchestrator.AGENT_DELIVERY_PARKED_MAX_MS). */
  parkedMaxMs?: number;
  tracer?: Tracer;
  machineId?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<ThirdPartyEventRedeliveryResult> {
  const agentIds = [...new Set(input.agentIds)];
  if (agentIds.length === 0) return emptyResult("no_agents");
  const tracer = input.tracer ?? noopTracer;
  const span = tracer.startSpan("server.third_party_event.redeliver", {
    surface: "server",
    kind: "internal",
    attrs: {
      trigger: input.trigger,
      agents_count: agentIds.length,
      excluded_in_flight: input.excludeEventIds?.length ?? 0,
      ...(input.machineId ? { machine_id: input.machineId } : {}),
    },
  });
  const result = emptyResult("processed");
  const endAttrs = () => ({
    outcome: result.outcome,
    expired_stale_backlog: result.expiredStaleBacklog,
    expired_over_cap: result.expiredOverCap,
    deferred_over_cap: result.deferredOverCap,
    summary_attached: result.summaryAttached,
    guard_rejected: result.guardRejected,
    guard_held: result.guardHeld,
    claimed: result.claimed,
    redelivered: result.redelivered,
    dropped: result.dropped,
    failed: result.failed,
    capped: result.capped,
    skipped_agents: result.skippedAgents,
  });
  if (!isThirdPartyEventRedeliveryEnabled(input.env)) {
    result.outcome = "disabled";
    span.end("ok", { attrs: endAttrs() });
    return result;
  }
  try {
    const scope: PassScope = input.trigger === "sweep" ? { trigger: "sweep" } : { trigger: "machine_ready", outageStartedAt: input.outageStartedAt };
    await runPass(agentIds, scope, input, result, (name, attrs) => span.addEvent(name, attrs));
    span.end("ok", { attrs: endAttrs() });
    return result;
  } catch (err) {
    span.end("error", { attrs: { ...endAttrs(), error_class: err instanceof Error ? err.name : "unknown" } });
    throw err;
  }
}

async function runPass(
  agentIds: string[],
  scope: PassScope,
  input: { deliverer: ThirdPartyEventRedeliverer; excludeEventIds?: readonly string[]; parkedMaxMs?: number; now?: Date },
  result: ThirdPartyEventRedeliveryResult,
  addEvent: (name: string, attrs: Record<string, string | number | boolean>) => void,
): Promise<void> {
  const db = getDb();
  const now = input.now ?? currentDate();
  const reconnect = scope.trigger === "machine_ready";
  const excludeEventIds = input.excludeEventIds ?? [];
  const parkedMaxMs = input.parkedMaxMs ?? DEFAULT_PARKED_MAX_MS;
  // Reconnect pass: what it expired, per agent, for the summary.
  const expiredByAgent = new Map<string, string[]>();
  const noteExpired = (row: { id: string; agentId: string }, outcome: "expired_stale_backlog" | "expired_over_cap") => {
    const list = expiredByAgent.get(row.agentId) ?? [];
    list.push(row.id);
    expiredByAgent.set(row.agentId, list);
    addEvent("server.third_party_event.redeliver.expired", { third_party_event_id: row.id, agent_id: row.agentId, outcome });
  };

  // 1. Reconnect pass only: outage rows older than 24 h, expired (never sent).
  // The sweep expires nothing: it just does not send rows that old.
  if (reconnect) {
    const staleBefore = new Date(now.getTime() - THIRD_PARTY_EVENT_REDELIVERY_MAX_AGE_MS);
    const stale = await db.update(t)
      .set({ status: "expired", updatedAt: now })
      .where(and(inArray(t.agentId, agentIds), ...pendingPredicates(now), ...scopePredicates(scope), sql`${t.createdAt} <= ${staleBefore}`))
      .returning({ id: t.id, agentId: t.agentId });
    result.expiredStaleBacklog = stale.length;
    for (const row of stale) noteExpired(row, "expired_stale_backlog");
  }

  // 2. Rows due now, ranked newest first per agent (one query for all agents).
  const ranked = await db.select({
    id: t.id,
    agentId: t.agentId,
    rank: sql<number>`(row_number() over (partition by ${t.agentId} order by ${t.createdAt} desc, ${t.id} desc))::int`,
  })
    .from(t)
    .where(and(inArray(t.agentId, agentIds), ...duePredicates(now, scope, excludeEventIds, parkedMaxMs)))
    .orderBy(asc(t.agentId), asc(t.createdAt))
    .limit(CANDIDATE_READ_LIMIT);
  // Nothing to send: no summary either (the known gap in the header).
  if (ranked.length === 0) return;

  const byAgent = new Map<string, { keep: string[]; overCap: string[] }>();
  for (const row of ranked) {
    let entry = byAgent.get(row.agentId);
    if (!entry) byAgent.set(row.agentId, entry = { keep: [], overCap: [] });
    (Number(row.rank) <= THIRD_PARTY_EVENT_REDELIVERY_PER_AGENT_CAP ? entry.keep : entry.overCap).push(row.id);
  }

  // Total cap: whole agents, in order; the rest wait for the next pass, untouched.
  const processed: string[] = [];
  let budget = THIRD_PARTY_EVENT_REDELIVERY_TOTAL_CAP;
  for (const [agentId, entry] of byAgent) {
    if (processed.length > 0 && entry.keep.length > budget) {
      result.capped = true;
      result.skippedAgents += 1;
      continue;
    }
    processed.push(agentId);
    budget -= entry.keep.length;
  }

  // 3. Over the per-agent cap. Reconnect pass (outage rows only): expired and
  // summarised. Sweep: left pending, the agent is online and may have them unread.
  const overCapIds = processed.flatMap((agentId) => byAgent.get(agentId)!.overCap);
  if (overCapIds.length > 0) result.capped = true;
  if (overCapIds.length > 0 && !reconnect) {
    result.deferredOverCap = overCapIds.length;
  } else if (overCapIds.length > 0) {
    const expired = await db.update(t)
      .set({ status: "expired", updatedAt: now })
      .where(and(inArray(t.id, overCapIds), ...pendingPredicates(now)))
      .returning({ id: t.id, agentId: t.agentId });
    result.expiredOverCap = expired.length;
    for (const row of expired) noteExpired(row, "expired_over_cap");
  }

  // 4. The kept rows, through the system-app delivery guards (vetoed: expired;
  // withheld: left as they are), then claimed.
  const keepIds = processed.flatMap((agentId) => byAgent.get(agentId)!.keep);
  const rows = keepIds.length === 0 ? [] : await db.select({ event: t, ...THIRD_PARTY_EVENT_APP_COLUMNS })
    .from(t)
    .leftJoin(oauthClients, eq(oauthClients.id, t.clientId))
    .where(inArray(t.id, keepIds))
    .orderBy(asc(t.createdAt), asc(t.id));
  const guarded = await partitionDeliverableSystemAppEvents(rows, (row) => row.event, { executor: db });
  result.guardRejected = guarded.vetoed.length;
  result.guardHeld = guarded.withheld.length;
  for (const row of guarded.vetoed) {
    addEvent("server.third_party_event.redeliver.guarded", { third_party_event_id: row.event.id, agent_id: row.event.agentId, outcome: "guard_rejected" });
  }
  for (const row of guarded.withheld) {
    addEvent("server.third_party_event.redeliver.guarded", { third_party_event_id: row.event.id, agent_id: row.event.agentId, outcome: "guard_held" });
  }

  const claimedIds = guarded.deliverable.length === 0 ? new Set<string>() : new Set((await db.update(t)
    .set({ status: "delivering", updatedAt: now })
    .where(and(inArray(t.id, guarded.deliverable.map((row) => row.event.id)), ...duePredicates(now, scope, excludeEventIds, parkedMaxMs)))
    .returning({ id: t.id })).map((row) => row.id));
  result.claimed = claimedIds.size;

  // 5. Per agent, the events oldest first. Reconnect pass: the summary of what
  // it expired for the agent rides on the first event deliverMessage accepts
  // (summary_attached: the daemon may still drop that copy). No event
  // accepted, no summary: the known gap in the header.
  const toSend = new Map<string, typeof guarded.deliverable>();
  for (const row of guarded.deliverable) {
    if (!claimedIds.has(row.event.id)) continue;
    const list = toSend.get(row.event.agentId) ?? [];
    list.push(row);
    toSend.set(row.event.agentId, list);
  }
  const summaries = await summariesByAgent(expiredByAgent, [...toSend.keys()]);
  for (const agentId of processed) {
    let summary = summaries.get(agentId) ?? null;
    for (const row of toSend.get(agentId) ?? []) {
      let delivery: AgentMessageDeliveryResult;
      try {
        delivery = await input.deliverer.deliverMessage(agentId, buildRedeliveredThirdPartyAgentMessage(row, summary));
      } catch (err) {
        result.failed += 1;
        console.warn("[ThirdPartyEventRedelivery] delivery failed", serializeErrorForLog(err));
        addEvent("server.third_party_event.redeliver.sent", { third_party_event_id: row.event.id, agent_id: agentId, outcome: "failed" });
        continue;
      }
      if (delivery.status === "queued") {
        result.redelivered += 1;
        if (summary) {
          result.summaryAttached += 1;
          addEvent("server.third_party_event.redeliver.summary_attached", {
            third_party_event_id: row.event.id,
            agent_id: agentId,
            expired_count: expiredByAgent.get(agentId)?.length ?? 0,
          });
          summary = null;
        }
      } else {
        result.dropped += 1;
      }
      addEvent("server.third_party_event.redeliver.sent", {
        third_party_event_id: row.event.id,
        agent_id: agentId,
        outcome: delivery.status,
        reason: delivery.reason,
      });
    }
  }
}

/**
 * Reconnect pass: each agent's summary of the rows the pass expired for it,
 * named by the app display name the Apps tab uses (THIRD_PARTY_EVENT_APP_COLUMNS),
 * for the agents that have an event to send (one query).
 */
async function summariesByAgent(
  expiredByAgent: ReadonlyMap<string, readonly string[]>,
  sendingAgentIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = sendingAgentIds.flatMap((agentId) => expiredByAgent.get(agentId) ?? []);
  const summaries = new Map<string, string>();
  if (ids.length === 0) return summaries;
  const rows = await getDb().select({ agentId: t.agentId, clientName: THIRD_PARTY_EVENT_APP_COLUMNS.clientName })
    .from(t)
    .leftJoin(oauthClients, eq(oauthClients.id, t.clientId))
    .where(inArray(t.id, ids));
  const counts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const byApp = counts.get(row.agentId) ?? new Map<string, number>();
    byApp.set(row.clientName, (byApp.get(row.clientName) ?? 0) + 1);
    counts.set(row.agentId, byApp);
  }
  for (const [agentId, byApp] of counts) {
    const summary = formatNotDeliveredThirdPartyEventsSummary(byApp);
    if (summary) summaries.set(agentId, summary);
  }
  return summaries;
}

/**
 * The managed agents on these machines (this replica's connected computers,
 * an IN list) that have a pending app event the sweep could send (one query).
 * External agents are left to their inbox push.
 *
 * Plan risk: `agents.daemon_id` has no index, so this reads agents by the
 * IN list without one. The list is only the machines connected to this
 * replica and the join starts from the pending, recent event rows
 * (idx_third_party_agent_events_agent_status), so it stays small; add an
 * index on agents(daemon_id) if the sweep span shows this query growing.
 */
export async function listManagedAgentsWithPendingThirdPartyEvents(input: {
  machineIds: readonly string[];
  parkedMaxMs?: number;
  now?: Date;
}): Promise<string[]> {
  if (input.machineIds.length === 0) return [];
  const now = input.now ?? currentDate();
  const rows = await getDb().selectDistinct({ agentId: t.agentId })
    .from(t)
    .innerJoin(agents, eq(agents.id, t.agentId))
    .where(and(
      inArray(agents.machineId, [...input.machineIds]),
      isNull(agents.deletedAt),
      ne(agents.runtime, EXTERNAL_AGENT_RUNTIME_ID),
      ...pendingPredicates(now),
      sql`${t.createdAt} > ${new Date(now.getTime() - THIRD_PARTY_EVENT_REDELIVERY_MAX_AGE_MS)}`,
      sql`${t.createdAt} <= ${new Date(now.getTime() - (input.parkedMaxMs ?? DEFAULT_PARKED_MAX_MS) - THIRD_PARTY_EVENT_REDELIVERY_PARK_MARGIN_MS)}`,
    ));
  return rows.map((row) => row.agentId);
}

/** How long shutdown waits for a sweep pass in flight. */
const SWEEP_STOP_WAIT_MS = 10_000;

/** The sweep (safety net): one pass every few minutes over this replica's connected computers. */
export function startThirdPartyEventRedeliveryWorker(input: {
  agentOrchestrator: Pick<AgentOrchestrator, "sweepPendingThirdPartyAgentEvents">;
  intervalMs?: number;
  stopWaitMs?: number;
  env?: NodeJS.ProcessEnv;
}): { stop(): Promise<void>; kick(): void } {
  let current: Promise<void> | null = null;
  let stopped = false;
  const kick = () => {
    if (current || stopped) return;
    if (!isThirdPartyEventRedeliverySweepEnabled(input.env)) return;
    current = input.agentOrchestrator.sweepPendingThirdPartyAgentEvents()
      .catch((err) => console.error("[ThirdPartyEventRedelivery] sweep failed", serializeErrorForLog(err)))
      .finally(() => { current = null; });
  };
  const handle = setInterval(kick, input.intervalMs ?? THIRD_PARTY_EVENT_REDELIVERY_SWEEP_INTERVAL_MS);
  handle.unref?.();
  return {
    kick,
    /** Stops the timer, then waits (bounded) for the pass in flight. */
    async stop() {
      stopped = true;
      clearInterval(handle);
      if (!current) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        current,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, input.stopWaitMs ?? SWEEP_STOP_WAIT_MS); timer.unref?.(); }),
      ]);
      if (timer) clearTimeout(timer);
    },
  };
}
