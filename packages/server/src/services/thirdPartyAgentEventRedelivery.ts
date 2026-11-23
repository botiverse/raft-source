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
 * Four triggers re-send such rows through `deliverMessage`, the path the first
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
 * - `daemon_instance_changed` (the restart pass): the replica that receives a
 *   `ready` whose daemon instance (`daemonInstanceId`, one per daemon process)
 *   differs from the one the machine last connected with
 *   (recordMachineDaemonInstance: a durable per-machine marker, swapped under a
 *   row lock so one `ready` per new instance wins, on any replica). A
 *   restarted or upgraded daemon has lost whatever it held in memory: an
 *   event it was pushed and acked (`agent:deliver:ack`) but never handed to
 *   the agent (machine ca4239b1, 11-15: a start held through an upgrade drain,
 *   resolved at shutdown) stays `delivering` with no ack-retry record left to
 *   send it. A plain socket reconnect of the same daemon re-sends nothing (a
 *   flaky network wakes no idle agent); neither do the first `ready` a machine
 *   is recorded with, a `ready` without an instance id, nor the instance the
 *   marker had just replaced coming back (A, B, A: two daemons taking turns
 *   on one machine; only their first flip counts as a restart). It looks at the
 *   agents' `delivering` rows (not `queued` ones: the next-start pass
 *   below, `runtime_ready`, sends those, a dropped-on-exit requeue or a
 *   failed push, at the agent's next runtime start; the only `queued` rows
 *   held on purpose are a system app's guard-withheld ones, and every pass
 *   runs the guard again, so they stay withheld) not coalesced into an item
 *   that already woke the agent
 *   (`wake_coalesced_at`, as selectPendingThirdPartyAgentEvents), created in
 *   the last 24 h, whose last push or claim came before the new daemon
 *   connected (a later one went to the new daemon). Unlike the reconnect pass
 *   it expires nothing and sends no summary: these rows may have reached the
 *   agent before the restart and sit unread in its inbox, so past the 20
 *   newest per agent they are left there (`deferred_over_cap`), and the first
 *   event the agent accepts says how many more wait in its inbox
 *   (`restartDeferred*`). Its note says the event is sent again after a
 *   restart and may already have been seen: the daemon's duplicate checks
 *   (`samePendingDelivery`, `dropped_already_consumed`) live in memory and
 *   start empty after the restart, so an event the agent saw before it whose
 *   delivered report was lost reaches it a second time.
 * - `runtime_ready` (the next-start pass): the replica that receives an
 *   agent's `agent:runtime:ready` (a runtime process of the agent produced its
 *   first output: any start, a server one or the daemon's own restart from
 *   its snapshot, and every turn of a per-turn runtime) sends that agent's
 *   `queued` rows. A process that ends abnormally (a stop, the fence, a
 *   crash, a provider-stream failure, a recoverable close with no wake)
 *   drops the app events it had acked and never handed over; its daemon
 *   names them (`agent:inbox:dropped_app_events`) and
 *   requeueDroppedThirdPartyAgentEvents moves them from `delivering` back to
 *   `queued` (wake_coalesced_at unchanged). Nothing at a start or wake hands
 *   `queued` app events to a managed agent otherwise (its start catch-up is
 *   the chat chain), so this pass is what sends them, once its next process
 *   runs (#raft-antiproton:#14: 16 events lost in a week, acked into a
 *   runtime-error backoff that ended in the fence or a stop). It also sends a
 *   row left `queued` by a push that failed (claim released). It only takes
 *   rows that were claimed or requeued at least once (`updated_at` after
 *   `created_at`): a row never touched since its insert is either still
 *   being pushed by the request that wrote it, or queued on purpose and
 *   never pushed (an Artifact's rename and channel-announcement notices,
 *   Artifacts task #160: they wake no agent, it reads them when something
 *   else wakes it). It also skips rows coalesced into an item that already
 *   woke the agent.
 *   Its claim makes the rows `delivering` again, so a later start of the
 *   agent sends nothing new, and a per-turn runtime's normal turns (no
 *   frame, no `queued` row) send nothing. One agent's requeues and passes
 *   run in order on the replica that holds its socket
 *   (AgentOrchestrator.chainThirdPartyEventAgentWork): a ready handled at
 *   the same time as the frame before it still finds the requeued rows. The
 *   restart pass takes only
 *   `delivering` rows and this one only `queued` rows, and each claim moves
 *   `updated_at` past the restart pass's connection time: of one `ready` and
 *   one start, a row goes out once. Past the newest 20 the rest stay
 *   `queued` (`deferred_over_cap`; the agent's next runtime start sends
 *   them), and the first event sent says how many more wait in the inbox.
 *
 * The reconnect pass and the sweep leave rows created in the last 31 minutes
 * alone: a parked ack-retry record for them may still live on the replica
 * that made the first push (it re-sends them when the computer is back), and
 * this replica cannot see it; a later sweep (when the sweep is on) picks them
 * up once that record has expired. The restart pass does not: the restart
 * left the acked rows with no record anywhere, and a parked record that still
 * re-sends one only makes a copy the daemon drops.
 *
 * All three then run the kept rows through their system app's delivery guard
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
  AGENT_INBOX_DROPPED_APP_EVENTS_MAX_IDS,
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
import { agents, machineDaemonInstances, oauthClients, thirdPartyAgentEvents } from "../db/schema";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import type { AgentMessageDeliveryResult, AgentOrchestrator } from "./agentOrchestrator";
import { THIRD_PARTY_EVENT_APP_COLUMNS, buildThirdPartyAgentMessage } from "./oauthService";
import { partitionDeliverableSystemAppEvents } from "./systemAppDeliveryGuards";

export type ThirdPartyEventRedeliveryTrigger = "machine_ready" | "sweep" | "daemon_instance_changed" | "runtime_ready";

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
 * - `lateNote` prefixes every event the reconnect pass and the sweep send
 *   again, `restartNote` every one the restart pass sends again. `{createdAt}`
 *   is the event's creation time in the `time=` header format
 *   (formatUtcTimestamp, e.g. 2026-10-22 22:50:00Z).
 * - `notDelivered*` (reconnect pass only) goes ahead of the late note on the
 *   first event re-delivered to the agent in that pass. `{count}`: the outage
 *   rows that pass expired for the agent (older than 24 h, or beyond the
 *   newest `{cap}`); `{apps}`: their count per app display name, e.g.
 *   "Reminder 2, Stamp 1".
 * - `restartDeferred*` (restart pass only) goes ahead of the restart note on
 *   the first event re-sent to the agent in that pass. `{count}`: its rows
 *   past the newest `{cap}`, left pending in its inbox, not sent again.
 * - `runtimeRestartNote` prefixes every event the next-start pass sends;
 *   `runtimeRestartDeferred*` goes ahead of it on the first one, `{count}`:
 *   the agent's rows past the newest `{cap}`, left queued in its inbox (its
 *   next runtime start sends them).
 */
export const THIRD_PARTY_EVENT_REDELIVERY_COPY = {
  lateNote: "Delivered late: this app notification was created at {createdAt} and did not reach you then. Check that it still applies before you act on it.",
  restartDeferredOne: "1 more app notification that may not have reached you before your computer restarted is in your inbox; it is not sent again. Check your inbox for it.",
  restartDeferredMany: "{count} more app notifications that may not have reached you before your computer restarted are in your inbox; they are not sent again. Check your inbox for them.",
  restartNote: "Sent again after your computer restarted: this app notification was created at {createdAt}, and the restart may have lost it before it reached you. If you already handled it, ignore this copy; otherwise check that it still applies before you act on it.",
  runtimeRestartNote: "Sent again after the agent restarted: this app notification was created at {createdAt}, and it may not have reached you before your previous run ended. If you already handled it, ignore this copy; otherwise check that it still applies before you act on it.",
  runtimeRestartDeferredOne: "1 more app notification that may not have reached you before your previous run ended is in your inbox. Check your inbox for it.",
  runtimeRestartDeferredMany: "{count} more app notifications that may not have reached you before your previous run ended are in your inbox. Check your inbox for them.",
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

/** The note that prefixes a re-delivered event's text: the restart and next-start passes' own, else the late note. */
export function formatThirdPartyEventLateNote(createdAt: Date, trigger: ThirdPartyEventRedeliveryTrigger = "machine_ready"): string {
  const template = trigger === "daemon_instance_changed"
    ? THIRD_PARTY_EVENT_REDELIVERY_COPY.restartNote
    : trigger === "runtime_ready"
      ? THIRD_PARTY_EVENT_REDELIVERY_COPY.runtimeRestartNote
      : THIRD_PARTY_EVENT_REDELIVERY_COPY.lateNote;
  return template.replace("{createdAt}", formatUtcTimestamp(createdAt));
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

/** Restart and next-start passes: the line telling the agent how many of its rows past the cap wait in its inbox. Null when none. */
export function formatRestartDeferredThirdPartyEvents(count: number, trigger: "daemon_instance_changed" | "runtime_ready" = "daemon_instance_changed"): string | null {
  if (count <= 0) return null;
  const copy = THIRD_PARTY_EVENT_REDELIVERY_COPY;
  const [one, many] = trigger === "runtime_ready"
    ? [copy.runtimeRestartDeferredOne, copy.runtimeRestartDeferredMany]
    : [copy.restartDeferredOne, copy.restartDeferredMany];
  return count === 1 ? one : many.replace("{count}", String(count));
}

/**
 * The message the first push sends (buildThirdPartyAgentMessage: same id,
 * original timestamp, so `time=` stays the creation time), its text prefixed
 * with the trigger's note, and with `summary` ahead of that when given. Only
 * the re-delivery path adds them.
 */
export function buildRedeliveredThirdPartyAgentMessage(input: {
  event: EventRow;
  clientKey: string;
  clientName: string;
}, summary: string | null = null, trigger: ThirdPartyEventRedeliveryTrigger = "machine_ready"): AgentMessage {
  const message = buildThirdPartyAgentMessage(input);
  const prefix = [summary, formatThirdPartyEventLateNote(input.event.createdAt, trigger)].filter(Boolean).join("\n\n");
  return { ...message, content: `${prefix}\n\n${message.content}` };
}

const t = thirdPartyAgentEvents;

/** Pending, not past expires_at, not a hosted assistant's row, not one sent to wake no one. */
function pendingPredicates(now: Date): SQL[] {
  return [
    or(eq(t.status, "queued"), eq(t.status, "delivering"))!,
    isNull(t.deliveredAt),
    // `delivery: "inbox"` (dm:@Remy:#1): never pushed, so never re-sent either.
    eq(t.delivery, "wake"),
    sql`${t.expiresAt} > ${now}`,
    or(isNull(t.systemApp), ne(t.systemApp, EXCLUDED_SYSTEM_APP))!,
  ];
}

type PassScope =
  | { trigger: "sweep" }
  | { trigger: "machine_ready"; outageStartedAt: Date }
  /** `daemonConnectedAt`: when the machine's new daemon instance connected. */
  | { trigger: "daemon_instance_changed"; daemonConnectedAt: Date }
  | { trigger: "runtime_ready" };

/**
 * Reconnect pass: only rows created during the outage. Restart pass: only
 * pushed rows (`delivering`), next-start pass: only `queued` rows, neither
 * coalesced into an item that already woke the agent.
 */
function scopePredicates(scope: PassScope): SQL[] {
  switch (scope.trigger) {
    case "sweep":
      return [];
    case "machine_ready":
      return [sql`${t.createdAt} >= ${new Date(scope.outageStartedAt.getTime() - THIRD_PARTY_EVENT_REDELIVERY_OUTAGE_SLACK_MS)}`];
    case "daemon_instance_changed":
      return [eq(t.status, "delivering"), isNull(t.wakeCoalescedAt)];
    case "runtime_ready":
      return [eq(t.status, "queued"), isNull(t.wakeCoalescedAt)];
  }
}

/**
 * Pending, in scope, recent enough, older than any park (not the restart and
 * next-start passes: see the header), not excluded, and its wait since the
 * last push is over (restart pass: last pushed or claimed before the new
 * daemon connected; next-start pass: claimed or requeued at least once).
 */
function duePredicates(now: Date, scope: PassScope, excludeEventIds: readonly string[], parkedMaxMs: number): SQL[] {
  const staleBefore = new Date(now.getTime() - THIRD_PARTY_EVENT_REDELIVERY_MAX_AGE_MS);
  const parkCutoff = new Date(now.getTime() - parkedMaxMs - THIRD_PARTY_EVENT_REDELIVERY_PARK_MARGIN_MS);
  const wait = scope.trigger === "machine_ready"
    ? sql`${t.updatedAt} <= ${new Date(now.getTime() - THIRD_PARTY_EVENT_REDELIVERY_GRACE_MS)}`
    : scope.trigger === "daemon_instance_changed"
      ? sql`${t.updatedAt} <= ${scope.daemonConnectedAt}`
      : scope.trigger === "runtime_ready"
        ? sql`${t.updatedAt} > ${t.createdAt}`
        // Exponential: wait at least as long as the row had been pending at its last push.
        : sql`${t.updatedAt} <= ${now}::timestamptz - greatest(${THIRD_PARTY_EVENT_REDELIVERY_SWEEP_GRACE_MS}::double precision * interval '1 millisecond', ${t.updatedAt} - ${t.createdAt})`;
  // The restart and next-start passes' rows have no parked record left (see the header).
  const parked = scope.trigger === "machine_ready" || scope.trigger === "sweep";
  return [
    ...pendingPredicates(now),
    ...scopePredicates(scope),
    sql`${t.createdAt} > ${staleBefore}`,
    ...(parked ? [sql`${t.createdAt} <= ${parkCutoff}`] : []),
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
  /** Sweep, restart and next-start passes: due rows past the per-agent cap, left pending (sweep: for a later pass; restart: in the agent's inbox; next start: queued, for its next start). */
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
 * the reconnect pass, the outage start (planReconnectRedelivery); for the
 * restart pass, when the new daemon instance connected; the next-start pass
 * gets the one agent whose runtime is ready.
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
    const scope: PassScope = input.trigger === "sweep" || input.trigger === "runtime_ready"
      ? { trigger: input.trigger }
      : input.trigger === "machine_ready"
        ? { trigger: "machine_ready", outageStartedAt: input.outageStartedAt }
        : { trigger: "daemon_instance_changed", daemonConnectedAt: input.daemonConnectedAt };
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
  // Only the reconnect pass expires (and summarises) rows: its outage rows
  // cannot have reached the computer.
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
  // summarised. Sweep and restart pass: left pending, the agent may have them unread.
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
  // (summary_attached: the daemon may still drop that copy); restart pass: the
  // count of its rows left in the inbox past the cap. No event accepted, no
  // summary: the known gap in the header.
  const toSend = new Map<string, typeof guarded.deliverable>();
  for (const row of guarded.deliverable) {
    if (!claimedIds.has(row.event.id)) continue;
    const list = toSend.get(row.event.agentId) ?? [];
    list.push(row);
    toSend.set(row.event.agentId, list);
  }
  const deferring = scope.trigger === "daemon_instance_changed" || scope.trigger === "runtime_ready" ? scope.trigger : null;
  const deferredCount = (agentId: string) => deferring ? byAgent.get(agentId)?.overCap.length ?? 0 : 0;
  const summaries = deferring
    ? new Map([...toSend.keys()].flatMap((agentId) => {
      const line = formatRestartDeferredThirdPartyEvents(deferredCount(agentId), deferring);
      return line ? [[agentId, line] as const] : [];
    }))
    : await summariesByAgent(expiredByAgent, [...toSend.keys()]);
  // One `sent` event per event sent again: ids, the trigger, the event's age.
  const sentAttrs = (event: EventRow) => ({
    third_party_event_id: event.id,
    agent_id: event.agentId,
    trigger: scope.trigger,
    age_ms: Math.max(0, now.getTime() - event.createdAt.getTime()),
  });
  for (const agentId of processed) {
    let summary = summaries.get(agentId) ?? null;
    for (const row of toSend.get(agentId) ?? []) {
      let delivery: AgentMessageDeliveryResult;
      try {
        delivery = await input.deliverer.deliverMessage(agentId, buildRedeliveredThirdPartyAgentMessage(row, summary, scope.trigger));
      } catch (err) {
        result.failed += 1;
        console.warn("[ThirdPartyEventRedelivery] delivery failed", serializeErrorForLog(err));
        addEvent("server.third_party_event.redeliver.sent", { ...sentAttrs(row.event), outcome: "failed" });
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
            deferred_count: deferredCount(agentId),
          });
          summary = null;
        }
      } else {
        result.dropped += 1;
      }
      addEvent("server.third_party_event.redeliver.sent", {
        ...sentAttrs(row.event),
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
 * What a `ready`'s daemon instance is to the machine's marker:
 * - `changed`: another instance connected last (the daemon restarted or was
 *   upgraded), and this `ready` swapped the marker to the new one;
 * - `returned_to_previous`: the instance the marker had just replaced came
 *   back (A, B, then A again). A daemon instance id is a fresh UUID per daemon
 *   process, so a restart never brings an old one back: two daemons are
 *   taking turns on the machine (two installs), and the one coming back has
 *   lost nothing to a restart. Swapped like `changed`, so the flips that
 *   follow (B again, A again) are all this, never `changed`;
 * - `first`: the machine had no marker (its first `ready` since the marker
 *   exists): recorded, nothing known to compare with;
 * - `same`: the marker already names this instance (a socket reconnect, or
 *   another `ready` of the same instance swapped it first).
 */
export type DaemonInstanceObservation = "changed" | "returned_to_previous" | "first" | "same";

/**
 * Records a `ready`'s daemon instance as the machine's last one: one
 * transaction that locks the machine's marker row (FOR UPDATE), so of two
 * `ready`s of one new instance, on one replica or two, exactly one sees
 * `changed` and the other, waiting on the lock, `same`. Throws on a database
 * error; the caller skips the restart pass then.
 */
export async function recordMachineDaemonInstance(input: {
  machineId: string;
  daemonInstanceId: string;
  now?: Date;
}): Promise<DaemonInstanceObservation> {
  const m = machineDaemonInstances;
  const now = input.now ?? currentDate();
  return getDb().transaction(async (tx) => {
    const [marker] = await tx.select({ current: m.daemonInstanceId, previous: m.previousDaemonInstanceId })
      .from(m)
      .where(eq(m.machineId, input.machineId))
      .for("update");
    if (!marker) {
      // Two first `ready`s at once: the other one's insert wins, this one is that same recording.
      const inserted = await tx.insert(m)
        .values({ machineId: input.machineId, daemonInstanceId: input.daemonInstanceId, previousDaemonInstanceId: null, updatedAt: now })
        .onConflictDoNothing({ target: m.machineId })
        .returning({ machineId: m.machineId });
      return inserted.length > 0 ? "first" : "same";
    }
    if (marker.current === input.daemonInstanceId) return "same";
    await tx.update(m)
      .set({ daemonInstanceId: input.daemonInstanceId, previousDaemonInstanceId: marker.current, updatedAt: now })
      .where(eq(m.machineId, input.machineId));
    return marker.previous === input.daemonInstanceId ? "returned_to_previous" : "changed";
  });
}

/** Why an id of an `agent:inbox:dropped_app_events` frame was not put back in the queue. */
export type DroppedAppEventIgnoredReason =
  | "over_cap"
  | "invalid_id"
  | "not_found"
  | "other_agent"
  | "not_delivering"
  | "expired"
  | "excluded_app";

export type DroppedAppEventsRequeueResult = {
  outcome: "disabled" | "processed";
  requeued: string[];
  ignored: Record<DroppedAppEventIgnoredReason, number>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An `agent:inbox:dropped_app_events` frame: the app events a runtime process
 * of `agentId` acked and dropped when it ended abnormally go back to `queued`
 * (wake_coalesced_at unchanged), for the next-start pass (see the header).
 * The frame comes from a user-controlled machine, and the caller has checked
 * that `agentId` is assigned to the sending one: only that agent's
 * `delivering`, unexpired rows move (never system.assistant ones), from the
 * first AGENT_INBOX_DROPPED_APP_EVENTS_MAX_IDS ids. Every other id is counted
 * by reason, so a machine can never make the server re-send another agent's
 * events.
 */
export async function requeueDroppedThirdPartyAgentEvents(input: {
  agentId: string;
  eventIds: readonly unknown[];
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<DroppedAppEventsRequeueResult> {
  const ignored: Record<DroppedAppEventIgnoredReason, number> = {
    over_cap: 0, invalid_id: 0, not_found: 0, other_agent: 0, not_delivering: 0, expired: 0, excluded_app: 0,
  };
  const listed = Array.isArray(input.eventIds) ? input.eventIds : [];
  ignored.over_cap = Math.max(0, listed.length - AGENT_INBOX_DROPPED_APP_EVENTS_MAX_IDS);
  const ids = new Set<string>();
  for (const id of listed.slice(0, AGENT_INBOX_DROPPED_APP_EVENTS_MAX_IDS)) {
    if (typeof id === "string" && UUID_RE.test(id)) ids.add(id.toLowerCase());
    else ignored.invalid_id += 1;
  }
  if (!isThirdPartyEventRedeliveryEnabled(input.env)) return { outcome: "disabled", requeued: [], ignored };
  if (ids.size === 0) return { outcome: "processed", requeued: [], ignored };
  const now = input.now ?? currentDate();
  const db = getDb();
  const requeued = (await db.update(t)
    // Always after created_at, even against a lagging clock: the next-start
    // pass takes only rows touched since their insert.
    .set({ status: "queued", updatedAt: sql`greatest(${now}::timestamptz, ${t.createdAt} + interval '1 millisecond')` })
    .where(and(
      inArray(t.id, [...ids]),
      eq(t.agentId, input.agentId),
      eq(t.status, "delivering"),
      isNull(t.deliveredAt),
      sql`${t.expiresAt} > ${now}`,
      or(isNull(t.systemApp), ne(t.systemApp, EXCLUDED_SYSTEM_APP))!,
    ))
    .returning({ id: t.id })).map((row) => row.id);
  const moved = new Set(requeued);
  const rest = [...ids].filter((id) => !moved.has(id));
  if (rest.length > 0) {
    const rows = await db.select({ id: t.id, agentId: t.agentId, status: t.status, expiresAt: t.expiresAt, systemApp: t.systemApp })
      .from(t)
      .where(inArray(t.id, rest));
    ignored.not_found += rest.length - rows.length;
    for (const row of rows) {
      const reason: DroppedAppEventIgnoredReason = row.agentId !== input.agentId ? "other_agent"
        : row.systemApp === EXCLUDED_SYSTEM_APP ? "excluded_app"
          : row.status === "delivering" && row.expiresAt <= now ? "expired"
            : "not_delivering";
      ignored[reason] += 1;
    }
  }
  return { outcome: "processed", requeued, ignored };
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
