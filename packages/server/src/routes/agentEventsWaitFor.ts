// `GET /internal/agent-api/events?wait_for=<target_id>:<seq>[,...]`: wait,
// briefly, for the agent inbox chain to catch up to a push notice.
//
// A notice is sent the moment a message is delivered, while `/events` takes
// its candidate conversations from the RisingWave chain (rw_agent_inbox_v7),
// which trails Postgres (p50 ~2.6 s, p99 ~24 s, stalls of 20-37 s). An agent
// that pulls on the notice right away would get `events: []`. With wait_for it
// passes the notice's (channelId, latestSeq) pairs, and the route re-checks
// only those rows of the chain, with backoff, up to a cap, before its normal
// pull. Still behind at the cap: the response says so (`has_more: true`,
// `retry_after_ms`) and the client asks again, sending `wait_attempt` (its
// prior retries for this notice) so the server can back off without keeping
// any state.
// There is deliberately no Postgres read of the missing messages: the chain
// is the only source of an external agent's persisted messages.
//
// target_id is the notice target's `channelId`: the agent-facing channel id
// (a thread's or task conversation's own channel; for a joint channel the
// agent's LOCAL projection), the id space of rw_agent_inbox_v7.target_id.
import { currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import { getRisingWavePoolState } from "../db/risingwave";
import * as channelService from "../services/channelService";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { findRisingWaveOverload } from "./errorResponse";
import { isRisingWaveOverloadRecent, noteRisingWaveOverloadSeen } from "./rwStaleRead";

export const AGENT_EVENTS_WAIT_FOR_MAX_PAIRS = 20;
/** Backoff between re-checks: 200, 400, 800, 1600, ... ms, the last sleep cut at the cap. */
export const AGENT_EVENTS_WAIT_FOR_FIRST_DELAY_MS = 200;
const DEFAULT_MAX_WAIT_MS = 6_000;
const MAX_MAX_WAIT_MS = 30_000;
const DEFAULT_MAX_WAITERS = 100;
/**
 * `retry_after_ms` when the chain was still behind at the cap: a backoff the
 * server picks from the client's `wait_attempt` (prior retries for this
 * notice), 1000 * 2^attempt up to AGENT_EVENTS_WAIT_FOR_MAX_RETRY_AFTER_MS.
 */
export const AGENT_EVENTS_WAIT_FOR_FIRST_RETRY_AFTER_MS = 1_000;
/**
 * The longest `retry_after_ms`, and the one used whatever the attempt when
 * the wait was skipped to spare RisingWave (overloaded, this process at its
 * cap of waiters) or the chain could not be read: retry later, not sooner.
 */
export const AGENT_EVENTS_WAIT_FOR_MAX_RETRY_AFTER_MS = 8_000;
/** `wait_attempt` values above this are clamped (the backoff is at its max long before). */
const MAX_WAIT_ATTEMPT = 1_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEQ_RE = /^[0-9]{1,16}$/;

/** One wait_for pair: the notice target's channelId and its latestSeq. */
export type AgentEventsWaitPair = { targetId: string; seq: number };

/**
 * none: nothing to wait for (no wait_for, every pair covered by `since` or by
 * the first check, or not an external agent); caught_up: satisfied after at
 * least one re-check; cap: still behind at the cap; overloaded: skipped or cut
 * short because RisingWave is overloaded; waiter_limit: skipped because this
 * process has its cap of waiters; unavailable: RisingWave unconfigured or the
 * check failed for another reason (the pull would see no chain either).
 */
export type AgentEventsWaitOutcome = "none" | "caught_up" | "cap" | "overloaded" | "waiter_limit" | "unavailable";

export type AgentEventsWaitResult = {
  outcome: AgentEventsWaitOutcome;
  waitedMs: number;
  /** Chain reads made (the first check included). */
  checks: number;
  /** Pairs not yet satisfied (before the pull; see unsatisfiedAfterPull). */
  unsatisfied: AgentEventsWaitPair[];
};

export type ParsedAgentEventsWaitFor =
  | { ok: true; pairs: AgentEventsWaitPair[] }
  | { ok: false; error: string };

/**
 * `<target_id>:<seq>[,<target_id>:<seq>...]`, at most
 * AGENT_EVENTS_WAIT_FOR_MAX_PAIRS pairs; target_id a channel uuid, seq a
 * positive decimal integer. A target given twice keeps its highest seq.
 * Absent or empty: no pairs.
 */
export function parseAgentEventsWaitFor(raw: unknown): ParsedAgentEventsWaitFor {
  if (raw === undefined) return { ok: true, pairs: [] };
  if (typeof raw !== "string") return { ok: false, error: "wait_for must be given once" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, pairs: [] };
  const parts = trimmed.split(",");
  if (parts.length > AGENT_EVENTS_WAIT_FOR_MAX_PAIRS) {
    return { ok: false, error: `wait_for takes at most ${AGENT_EVENTS_WAIT_FOR_MAX_PAIRS} pairs` };
  }
  const byTarget = new Map<string, number>();
  for (const part of parts) {
    const pair = part.trim();
    const colon = pair.lastIndexOf(":");
    const targetId = colon > 0 ? pair.slice(0, colon).toLowerCase() : "";
    const seqText = colon > 0 ? pair.slice(colon + 1) : "";
    const seq = Number(seqText);
    if (!UUID_RE.test(targetId) || !SEQ_RE.test(seqText) || !Number.isSafeInteger(seq) || seq <= 0) {
      return { ok: false, error: "wait_for must be <target_id>:<seq> pairs (channel id, positive integer seq), comma-separated" };
    }
    byTarget.set(targetId, Math.max(byTarget.get(targetId) ?? 0, seq));
  }
  return { ok: true, pairs: [...byTarget].map(([targetId, seq]) => ({ targetId, seq })) };
}

/** `AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_MS` (default 6000, 0 disables waiting, at most 30000). */
export function resolveAgentEventsWaitMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_MS?.trim();
  if (!raw) return DEFAULT_MAX_WAIT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(Math.floor(parsed), MAX_MAX_WAIT_MS) : DEFAULT_MAX_WAIT_MS;
}

/** `AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_WAITERS` (default 100): concurrent waits per process. */
export function resolveAgentEventsMaxWaiters(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_EVENTS_WAIT_FOR_CHAIN_MAX_WAITERS?.trim();
  if (!raw) return DEFAULT_MAX_WAITERS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_MAX_WAITERS;
}

type WaitDeps = {
  readSeqs: typeof channelService.readAgentInboxChainTargetSeqs;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  /** RisingWave is overloaded right now: no optional reads. */
  overloaded: () => boolean;
};

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setClockTimeout(done, ms) as { unref?: () => void };
    timer?.unref?.();
    signal?.addEventListener("abort", done, { once: true });
  });
}

const defaultDeps: WaitDeps = {
  readSeqs: (agentId, targetIds) => channelService.readAgentInboxChainTargetSeqs(agentId, targetIds),
  sleep: sleepUnlessAborted,
  now: currentTimeMs,
  // A recent rw_overloaded in this process, or RW pool acquires already queued.
  overloaded: () => isRisingWaveOverloadRecent() || getRisingWavePoolState().rw_pool_waiting > 0,
};

let testDeps: Partial<WaitDeps> = {};
let activeWaiters = 0;

/** TEST-ONLY: replace the chain read, sleep, clock or overload signal (an empty object restores them). */
export function __setAgentEventsWaitForDepsForTests(deps: Partial<WaitDeps>): void {
  testDeps = deps;
}

/** Waits sleeping right now in this process (tests). */
export function agentEventsActiveWaiters(): number {
  return activeWaiters;
}

function deps(): WaitDeps {
  return { ...defaultDeps, ...testDeps };
}

function caughtUp(pair: AgentEventsWaitPair, row: channelService.AgentInboxChainSeqRow | undefined): boolean {
  if (!row) return false;
  // No agent row: the message is in the chain once its conversation is (the
  // agent has nothing to be offered there: read already, deleted, not visible).
  if (!row.inAgentInbox) return (row.targetLatestSeq ?? 0) >= pair.seq;
  return Math.max(row.latestSeq ?? 0, row.maxMentionSeq ?? 0) >= pair.seq || row.lastReadSeq >= pair.seq;
}

/**
 * Wait until the chain holds every pair (or `since` covers it), or the cap.
 * Holds no database connection or transaction while sleeping: each check is
 * one RW read that returns its connection. Never throws.
 */
export async function waitForAgentInboxChain(input: {
  agentId: string;
  pairs: readonly AgentEventsWaitPair[];
  sinceSeq: number | null;
  maxWaitMs?: number;
  maxWaiters?: number;
  signal?: AbortSignal;
}): Promise<AgentEventsWaitResult> {
  const d = deps();
  const startedAt = d.now();
  // A pair at or below `since` was already handed over: nothing to wait for.
  let pending = input.pairs.filter((pair) => input.sinceSeq === null || pair.seq > input.sinceSeq);
  const result = (outcome: AgentEventsWaitOutcome, checks: number): AgentEventsWaitResult => ({
    outcome, waitedMs: Math.max(0, d.now() - startedAt), checks, unsatisfied: pending,
  });
  if (pending.length === 0) return result("none", 0);
  if (d.overloaded()) return result("overloaded", 0);
  const maxWaitMs = input.maxWaitMs ?? resolveAgentEventsWaitMaxMs();
  const maxWaiters = input.maxWaiters ?? resolveAgentEventsMaxWaiters();
  const deadline = startedAt + maxWaitMs;
  let checks = 0;
  let delayMs = AGENT_EVENTS_WAIT_FOR_FIRST_DELAY_MS;
  let waiting = false;
  try {
    for (;;) {
      checks += 1;
      let rows: channelService.AgentInboxChainSeqRow[] | null;
      try {
        rows = await d.readSeqs(input.agentId, pending.map((pair) => pair.targetId));
      } catch (error) {
        if (findRisingWaveOverload(error)) {
          noteRisingWaveOverloadSeen(d.now());
          return result("overloaded", checks);
        }
        console.error("internal.agent-api.events wait_for chain check failed:", serializeErrorForLog(error));
        return result("unavailable", checks);
      }
      if (rows === null) return result("unavailable", checks);
      const byTarget = new Map(rows.map((row) => [row.targetId, row]));
      pending = pending.filter((pair) => !caughtUp(pair, byTarget.get(pair.targetId)));
      if (pending.length === 0) return result(checks === 1 ? "none" : "caught_up", checks);
      const remainingMs = deadline - d.now();
      if (remainingMs <= 0 || input.signal?.aborted) return result("cap", checks);
      if (!waiting) {
        if (activeWaiters >= maxWaiters) return result("waiter_limit", checks);
        activeWaiters += 1;
        waiting = true;
      }
      await d.sleep(Math.min(delayMs, remainingMs), input.signal);
      delayMs *= 2;
      if (d.overloaded()) return result("overloaded", checks);
    }
  } finally {
    if (waiting) activeWaiters -= 1;
  }
}

/**
 * After the pull: a pair whose message the pull found is satisfied whatever
 * the wait saw (the pull reads the chain again, later).
 */
export function unsatisfiedAfterPull(
  unsatisfied: readonly AgentEventsWaitPair[],
  events: ReadonlyArray<{ channel_id?: unknown; seq?: unknown }>,
): AgentEventsWaitPair[] {
  if (unsatisfied.length === 0) return [];
  const returned = new Map<string, number>();
  for (const event of events) {
    const seq = Number(event.seq);
    if (typeof event.channel_id !== "string" || !Number.isFinite(seq)) continue;
    const id = event.channel_id.toLowerCase();
    returned.set(id, Math.max(returned.get(id) ?? 0, seq));
  }
  return unsatisfied.filter((pair) => (returned.get(pair.targetId) ?? 0) < pair.seq);
}

export type ParsedAgentEventsWaitAttempt = { ok: true; attempt: number } | { ok: false; error: string };

/**
 * `wait_attempt`: how many times the client already retried for the current
 * notice (absent or empty: 0); a non-negative integer, large values clamped.
 */
export function parseAgentEventsWaitAttempt(raw: unknown): ParsedAgentEventsWaitAttempt {
  if (raw === undefined) return { ok: true, attempt: 0 };
  if (typeof raw !== "string") return { ok: false, error: "wait_attempt must be given once" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, attempt: 0 };
  if (!/^[0-9]+$/.test(trimmed)) return { ok: false, error: "wait_attempt must be a non-negative integer" };
  return { ok: true, attempt: Math.min(Number(trimmed), MAX_WAIT_ATTEMPT) };
}

/**
 * The `retry_after_ms` for pairs still unsatisfied after a wait with this
 * outcome: min(1000 * 2^attempt, 8000), or 8000 whatever the attempt when
 * RisingWave was spared (overloaded, waiter_limit) or unreadable (unavailable).
 */
export function agentEventsRetryAfterMs(outcome: AgentEventsWaitOutcome, attempt: number): number {
  if (outcome === "overloaded" || outcome === "waiter_limit" || outcome === "unavailable") {
    return AGENT_EVENTS_WAIT_FOR_MAX_RETRY_AFTER_MS;
  }
  const exponent = Math.min(Math.max(Math.floor(attempt), 0), 10);
  return Math.min(AGENT_EVENTS_WAIT_FOR_FIRST_RETRY_AFTER_MS * 2 ** exponent, AGENT_EVENTS_WAIT_FOR_MAX_RETRY_AFTER_MS);
}
