// New-server onboarding funnel (T3, #proj-o11y:398b8d69), in otel.logs.
//
// Derived from tables, not events: server, Computer, agent, activity and
// message rows already carry the timestamps, so the funnel covers history from
// the first run and nothing has to remember "already logged". The one fact no
// table kept, when a Computer first came online, is the write-once
// `daemons.first_connected_at` column set below.
//
// Output is aggregates only: one `server.onboarding.funnel` event per (cohort
// day, owner's first server or not, milestone) with counts and percentiles.
// Per-server rows stay inside this process. One replica computes each 6-hour
// slot, claimed in Redis like the CDC integrity check.

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  clearClockInterval,
  clearClockTimeout,
  currentDate,
  noopTracer,
  setClockInterval,
  setClockTimeout,
  type Tracer,
} from "@botiverse/raft-shared";
import { getDb, getSearchDb, isSearchQueryAbortedError, type Database } from "../db/index";
import { machines } from "../db/schema";
import { getRedis, isRedisAvailable } from "../redis";
import { REPLICA_ID } from "../replicaRouter";
import { errorClassOf } from "../tracing/semanticTrace";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { defaultQueryPg } from "./cdcIntegrityService";
import { HOSTED_CINDY_IMPORT_SOURCE } from "./hostedCindyService";

export const ONBOARDING_FUNNEL_EVENT = "server.onboarding.funnel";
export const ONBOARDING_FUNNEL_SPAN = "server.onboarding_funnel.compute";

export const ONBOARDING_FUNNEL_MILESTONES = [
  "server_created",
  "computer_added",
  "first_machine_connected",
  "first_agent_created",
  "first_agent_turn_started",
  "first_agent_reply",
  "first_result",
] as const;
export type OnboardingFunnelMilestone = (typeof ONBOARDING_FUNNEL_MILESTONES)[number];

/** Cohorts of the last 14 UTC days, today included. */
export const ONBOARDING_FUNNEL_COHORT_DAYS = 14;
const SLOT_HOURS = 6;
const CLAIM_TTL_SECONDS = SLOT_HOURS * 3600 - 300;
const DEFAULT_FIRST_RUN_DELAY_MS = 15 * 60_000;
const DEFAULT_TICK_MS = 60 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The templated opener the server posts as the onboarding agent (onboardingService). */
const OWNER_OPENER_SEND_KEY_PATTERN = "owner-opener-%";

/** One cohort server: ms from its creation to each milestone, null if not reached. */
export interface OnboardingFunnelServerRow {
  cohortDay: string;
  ownerFirstServer: boolean;
  msToMilestone: Record<OnboardingFunnelMilestone, number | null>;
}

export interface OnboardingFunnelAggregate {
  cohort_day: string;
  owner_first_server: boolean;
  milestone: OnboardingFunnelMilestone;
  cohort_size: number;
  reached: number;
  reached_1h: number;
  reached_24h: number;
  reached_7d: number;
  /** Over servers that reached the milestone only; 0 when none did. */
  p50_ms: number;
  p90_ms: number;
}

function sqlTimestamp(date: Date): string {
  return `'${date.toISOString()}'::timestamptz`;
}

/**
 * Per-server milestone times for servers created in [from, to). Every lookup
 * is bounded to the cohort's servers and their agents and walks an index from
 * the oldest row: (agent_id, created_at) on agent_activity_events and
 * (sender_id, created_at, id) on messages.
 *
 * first_result (Ferry / Nova, 2026-11-14) is stricter than first_agent_reply:
 * one of the server's own agents produced something, not only answered. It is
 * the earlier of
 *   - its first chat message with an attachment (the owner opener excluded,
 *     as for the reply), and
 *   - the first task it moved to done (task_events `status_changed` or
 *     `reopened` with payload.to = 'done' and the agent as actor).
 * Both are read through the cohort servers' own channels (idx_channels_server,
 * then idx_attachments_channel_created_linked / idx_tasks_channel_number and
 * idx_task_events_task): neither attachments nor task_events has an index by
 * uploader or actor. So a result an agent produced in another server's channel
 * is not counted.
 * Every step of that path is a `JOIN LATERAL (... OFFSET 0)`. Do not remove
 * the OFFSET 0 or turn these back into plain joins: it keeps the planner from
 * flattening the subquery, and with plain joins production scanned all of
 * attachments and task_events (AndyLok, read replica, 2026-11-14: 2.3 s and
 * 5.8 s against 0.8 s and 0.6 s, the former growing with the whole tables).
 * All steps need it, the cohort-to-channels one included: with only the last
 * steps lateral the planner walked every channel instead.
 * Publishing a Raft Artifact is NOT counted yet: what this query can read does
 * not say who published a version. Adding it later will raise the number.
 */
export function buildOnboardingFunnelSql(from: Date, to: Date): string {
  return `
WITH cohort AS (
  SELECT s.id, s.owner_id, s.created_at
  FROM servers s
  WHERE s.kind = 'normal' AND s.created_at >= ${sqlTimestamp(from)} AND s.created_at < ${sqlTimestamp(to)}
),
owner_first AS (
  SELECT s.owner_id, min(s.created_at) AS first_created_at
  FROM servers s
  WHERE s.kind = 'normal' AND s.owner_id IN (SELECT owner_id FROM cohort)
  GROUP BY s.owner_id
),
own_agents AS (
  SELECT a.id, a.server_id, a.created_at
  FROM agents a
  JOIN cohort c ON c.id = a.server_id
  WHERE a.managed_by_app_install_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM agent_runtime_provisions p
      WHERE p.agent_id = a.id AND p.import_source = '${HOSTED_CINDY_IMPORT_SOURCE}'
    )
),
agent_firsts AS (
  SELECT
    oa.server_id,
    oa.created_at,
    (SELECT e.created_at FROM agent_activity_events e
      WHERE e.agent_id = oa.id AND e.activity IN ('thinking', 'working')
      ORDER BY e.created_at LIMIT 1) AS turn_started_at,
    (SELECT m.created_at FROM messages m
      WHERE m.sender_id = oa.id::text AND m.sender_type = 'agent' AND m.message_type = 'chat'
        AND (m.agent_send_key IS NULL OR m.agent_send_key NOT LIKE '${OWNER_OPENER_SEND_KEY_PATTERN}')
      ORDER BY m.created_at LIMIT 1) AS replied_at
  FROM own_agents oa
),
agent_mins AS (
  SELECT server_id,
    min(created_at) AS agent_created_at,
    min(turn_started_at) AS turn_started_at,
    min(replied_at) AS replied_at
  FROM agent_firsts
  GROUP BY server_id
),
result_attachments AS (
  SELECT c.id AS server_id, min(m.created_at) AS attached_at
  FROM cohort c
  JOIN LATERAL (SELECT ch.id FROM channels ch WHERE ch.server_id = c.id OFFSET 0) ch ON true
  JOIN LATERAL (SELECT t.message_id FROM attachments t
                WHERE t.channel_id = ch.id AND t.message_id IS NOT NULL OFFSET 0) t ON true
  JOIN messages m ON m.id = t.message_id
  JOIN own_agents oa ON oa.server_id = c.id AND oa.id::text = m.sender_id
  WHERE m.sender_type = 'agent' AND m.message_type = 'chat'
    AND (m.agent_send_key IS NULL OR m.agent_send_key NOT LIKE '${OWNER_OPENER_SEND_KEY_PATTERN}')
  GROUP BY c.id
),
result_tasks AS (
  SELECT c.id AS server_id, min(e.created_at) AS done_at
  FROM cohort c
  JOIN LATERAL (SELECT ch.id FROM channels ch WHERE ch.server_id = c.id OFFSET 0) ch ON true
  JOIN LATERAL (SELECT k.id FROM tasks k WHERE k.channel_id = ch.id OFFSET 0) k ON true
  JOIN LATERAL (SELECT e.created_at, e.actor_id FROM task_events e
                WHERE e.task_id = k.id AND e.actor_type = 'agent'
                  AND e.event_type IN ('status_changed', 'reopened')
                  AND e.payload->>'to' = 'done' OFFSET 0) e ON true
  JOIN own_agents oa ON oa.server_id = c.id AND oa.id::text = e.actor_id
  GROUP BY c.id
),
machine_mins AS (
  SELECT d.server_id,
    min(d.created_at) AS computer_added_at,
    min(d.first_connected_at) AS machine_connected_at
  FROM daemons d
  JOIN cohort c ON c.id = d.server_id
  GROUP BY d.server_id
)
SELECT
  to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS cohort_day,
  (c.created_at = f.first_created_at) AS owner_first_server,
  extract(epoch FROM (mm.computer_added_at - c.created_at)) * 1000 AS computer_added_ms,
  extract(epoch FROM (mm.machine_connected_at - c.created_at)) * 1000 AS machine_connected_ms,
  extract(epoch FROM (am.agent_created_at - c.created_at)) * 1000 AS agent_created_ms,
  extract(epoch FROM (am.turn_started_at - c.created_at)) * 1000 AS turn_started_ms,
  extract(epoch FROM (am.replied_at - c.created_at)) * 1000 AS replied_ms,
  extract(epoch FROM (least(ra.attached_at, rt.done_at) - c.created_at)) * 1000 AS result_ms
FROM cohort c
JOIN owner_first f ON f.owner_id = c.owner_id
LEFT JOIN machine_mins mm ON mm.server_id = c.id
LEFT JOIN agent_mins am ON am.server_id = c.id
LEFT JOIN result_attachments ra ON ra.server_id = c.id
LEFT JOIN result_tasks rt ON rt.server_id = c.id
`;
}

function toMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  // A clock-skewed row never reads as "before the server existed".
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

export function parseOnboardingFunnelRows(rows: readonly Record<string, unknown>[]): OnboardingFunnelServerRow[] {
  return rows.map((row) => ({
    cohortDay: String(row.cohort_day),
    ownerFirstServer: row.owner_first_server === true || row.owner_first_server === "t",
    msToMilestone: {
      server_created: 0,
      computer_added: toMs(row.computer_added_ms),
      first_machine_connected: toMs(row.machine_connected_ms),
      first_agent_created: toMs(row.agent_created_ms),
      first_agent_turn_started: toMs(row.turn_started_ms),
      first_agent_reply: toMs(row.replied_ms),
      first_result: toMs(row.result_ms),
    },
  }));
}

/** Linear interpolation between closest ranks (Postgres percentile_cont). */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (sorted.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return Math.round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower));
}

export function summarizeOnboardingFunnel(rows: readonly OnboardingFunnelServerRow[]): OnboardingFunnelAggregate[] {
  const cohorts = new Map<string, OnboardingFunnelServerRow[]>();
  for (const row of rows) {
    const key = `${row.cohortDay}|${row.ownerFirstServer}`;
    const list = cohorts.get(key);
    if (list) list.push(row);
    else cohorts.set(key, [row]);
  }
  const aggregates: OnboardingFunnelAggregate[] = [];
  for (const key of [...cohorts.keys()].sort()) {
    const members = cohorts.get(key)!;
    const { cohortDay, ownerFirstServer } = members[0]!;
    for (const milestone of ONBOARDING_FUNNEL_MILESTONES) {
      const times = members
        .map((member) => member.msToMilestone[milestone])
        .filter((ms): ms is number => ms !== null)
        .sort((a, b) => a - b);
      aggregates.push({
        cohort_day: cohortDay,
        owner_first_server: ownerFirstServer,
        milestone,
        cohort_size: members.length,
        reached: times.length,
        reached_1h: times.filter((ms) => ms <= HOUR_MS).length,
        reached_24h: times.filter((ms) => ms <= DAY_MS).length,
        reached_7d: times.filter((ms) => ms <= 7 * DAY_MS).length,
        p50_ms: percentile(times, 0.5),
        p90_ms: percentile(times, 0.9),
      });
    }
  }
  return aggregates;
}

/** UTC 6-hour slot, e.g. `2026-10-16T18`. */
export function onboardingFunnelSlotKey(date: Date): string {
  const slotStart = new Date(date.getTime());
  slotStart.setUTCHours(Math.floor(slotStart.getUTCHours() / SLOT_HOURS) * SLOT_HOURS, 0, 0, 0);
  return slotStart.toISOString().slice(0, 13);
}

async function defaultClaimSlot(slotKey: string): Promise<boolean> {
  // No Redis: single replica / dev — just run.
  if (!isRedisAvailable()) return true;
  const result = await getRedis().set(`slock:onboarding-funnel:${slotKey}`, REPLICA_ID, "EX", CLAIM_TTL_SECONDS, "NX");
  return result === "OK";
}

/**
 * Which database the run read: the replica when one is configured, else the
 * primary. `injected` only appears in tests that pass their own reader.
 */
export type OnboardingFunnelQueryPath = "replica" | "primary" | "injected";

function defaultQueryPath(): OnboardingFunnelQueryPath {
  return getSearchDb() !== getDb() ? "replica" : "primary";
}

export interface OnboardingFunnelFailure {
  /**
   * `statement_timeout`: the primary's 60 s limit (SQLSTATE 57014).
   * `aborted`: the replica read cancelled after 60 s.
   * `query_error`: any other database error (see `sqlstate`).
   */
  reason: "statement_timeout" | "aborted" | "query_error" | "other";
  /** Five-character SQLSTATE when the database reported one, else "". Never the message: it carries the SQL. */
  sqlstate: string;
}

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/** Walks the cause chain: Drizzle wraps the pg error, without a name, in `cause`. */
export function classifyOnboardingFunnelFailure(error: unknown): OnboardingFunnelFailure {
  let sqlstate = "";
  let aborted = false;
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (isSearchQueryAbortedError(current)) aborted = true;
    const code = (current as { code?: unknown }).code;
    if (!sqlstate && typeof code === "string" && SQLSTATE_PATTERN.test(code)) sqlstate = code;
    current = (current as { cause?: unknown }).cause;
  }
  if (aborted) return { reason: "aborted", sqlstate };
  if (sqlstate === "57014") return { reason: "statement_timeout", sqlstate };
  return { reason: sqlstate ? "query_error" : "other", sqlstate };
}

export interface OnboardingFunnelDeps {
  queryPg?: (sqlText: string) => Promise<Record<string, unknown>[]>;
  /** Recorded on the span; defaults to the path `defaultQueryPg` takes. */
  queryPath?: OnboardingFunnelQueryPath;
  claimSlot?: (slotKey: string) => Promise<boolean>;
  now?: () => Date;
  tracer?: Tracer;
}

export interface OnboardingFunnelRunResult {
  outcome: "ok" | "error" | "skipped_claimed";
  aggregates: OnboardingFunnelAggregate[];
}

export async function runOnboardingFunnel(deps: OnboardingFunnelDeps = {}): Promise<OnboardingFunnelRunResult> {
  const now = (deps.now ?? currentDate)();
  const tracer = deps.tracer ?? noopTracer;
  const slot = onboardingFunnelSlotKey(now);
  if (!(await (deps.claimSlot ?? defaultClaimSlot)(slot))) return { outcome: "skipped_claimed", aggregates: [] };

  const startedAt = Date.now();
  // An injected reader (tests) names its own path; `getSearchDb` needs an initialized database.
  const path = deps.queryPath ?? (deps.queryPg ? "injected" : defaultQueryPath());
  const span = tracer.startSpan(ONBOARDING_FUNNEL_SPAN, { surface: "server", kind: "internal", attrs: { slot, path } });
  const from = new Date(now.getTime());
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - (ONBOARDING_FUNNEL_COHORT_DAYS - 1));
  let servers: OnboardingFunnelServerRow[];
  try {
    servers = parseOnboardingFunnelRows(await (deps.queryPg ?? defaultQueryPg)(buildOnboardingFunnelSql(from, now)));
  } catch (error) {
    // The slot stays claimed: a failed or timed-out query skips this cycle, no retry.
    const failure = classifyOnboardingFunnelFailure(error);
    console.warn(`[OnboardingFunnel] Slot ${slot} skipped on ${path}: ${failure.reason} ${failure.sqlstate}`.trimEnd());
    span.end("error", {
      attrs: {
        outcome: "error",
        error_class: errorClassOf(error),
        reason: failure.reason,
        sqlstate: failure.sqlstate,
        duration_ms: Date.now() - startedAt,
      },
    });
    return { outcome: "error", aggregates: [] };
  }
  const aggregates = summarizeOnboardingFunnel(servers);
  for (const aggregate of aggregates) {
    tracer.emitEvent(ONBOARDING_FUNNEL_EVENT, { surface: "server", attrs: { ...aggregate, slot } });
  }
  span.end("ok", {
    attrs: { outcome: "ok", cohort_servers: servers.length, rows: aggregates.length, duration_ms: Date.now() - startedAt },
  });
  return { outcome: "ok", aggregates };
}

export function isOnboardingFunnelDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ONBOARDING_FUNNEL_DISABLED === "1";
}

/** Ticks hourly; the slot claim makes each 6-hour slot run once across replicas. */
export function startOnboardingFunnelWorker(input: {
  tracer?: Tracer;
  firstRunDelayMs?: number;
  tickMs?: number;
  run?: typeof runOnboardingFunnel;
} = {}): { stop(): void } {
  if (isOnboardingFunnelDisabled()) return { stop() {} };
  const run = input.run ?? runOnboardingFunnel;
  let stopped = false;
  let running = false;
  let interval: unknown = null;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await run({ tracer: input.tracer });
    } catch (error) {
      console.error("[OnboardingFunnel] Run failed:", errorClassOf(error));
    } finally {
      running = false;
    }
  };
  const timeout = setClockTimeout(() => {
    if (stopped) return;
    void tick();
    interval = setClockInterval(() => void tick(), input.tickMs ?? DEFAULT_TICK_MS);
    (interval as { unref?: () => void }).unref?.();
  }, input.firstRunDelayMs ?? DEFAULT_FIRST_RUN_DELAY_MS);
  (timeout as { unref?: () => void }).unref?.();
  return {
    stop() {
      stopped = true;
      clearClockTimeout(timeout);
      if (interval !== null) clearClockInterval(interval);
    },
  };
}

/** Write-once: a reconnect matches no row. */
export async function recordMachineFirstConnected(machineId: string, db: Database = getDb()): Promise<void> {
  await db
    .update(machines)
    .set({ firstConnectedAt: sql`now()` })
    .where(and(eq(machines.id, machineId), isNull(machines.firstConnectedAt)));
}

/** Stamps `first_connected_at` on `machine:online`, the moment registerMachine marks a Computer online. */
export function startMachineFirstConnectRecorder(deps: {
  orchestrator: AgentOrchestrator;
  record?: (machineId: string) => Promise<void>;
}): () => void {
  const record = deps.record ?? recordMachineFirstConnected;
  const listener = (event: { machineId: string; serverId: string }) => {
    // Runs on every reconnect; it must never be the reason one fails.
    record(event.machineId).catch((error: unknown) => {
      console.warn(`[OnboardingFunnel] first_connected_at write failed for machine ${event.machineId}:`, errorClassOf(error));
    });
  };
  deps.orchestrator.on("machine:online", listener);
  return () => {
    deps.orchestrator.off("machine:online", listener);
  };
}
