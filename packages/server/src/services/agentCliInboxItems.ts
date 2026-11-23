// #proj-apps:#88: whether an agent's `raft` CLI lists app items in its inbox.
//
// An app event held in the inbox without a wake (`delivery: "inbox"`), or
// merged into an earlier wake of its item (appItemWakeCoalescing), is never
// pushed: the agent sees it only in `raft inbox check`. A CLI too old to list
// app items (no `inbox-items@1`) never shows it, so for that agent the event
// is silently lost. Raft only holds or merges an event when the agent's CLI
// declared the capability.
//
// The CLI declares what it can do on every request
// (`X-Raft-Client-Capabilities`); the Server keeps the last answer per agent,
// with the Computer and daemon version it came from (the CLI ships with the
// daemon). It counts only while that Computer and version are still the
// agent's: moved to another Computer or upgraded/downgraded, the agent is
// woken until its next CLI request says again (Sage, #proj-apps:92938eb1).
// A stale "yes" is the silent miss this exists to stop; a stale "no" costs
// one extra wake.
//
// An agent on no Computer (an external agent running the CLI itself) has no
// Computer or daemon version to change, so its "yes" would last until its CLI
// said "no", and a CLI too old to send the capabilities header never does.
// For it the answer also expires: it counts only while seen within
// AGENT_CLI_INBOX_ITEMS_NO_COMPUTER_TTL_MS (`seenAt`). Its CLI refreshes
// `seenAt` at most once an hour (SEEN_AT_REFRESH_MS), so an unchanged answer
// writes at most once an hour per agent. Agents on a Computer keep the
// Computer and version rule alone.
//
// Only requests that say they come from the CLI (`X-Raft-Client: cli`) and
// carry the capabilities header count. The SDK and the daemon call the same
// API with the agent's credential without the CLI's tokens; a request with
// no header changes nothing. Hosted agents that only use the SDK are never
// recorded, so they are always woken: safe by design.

import { and, eq, sql } from "drizzle-orm";
import { hasInboxItemsCapability } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, machines } from "../db/schema";
import { serializeErrorForLog } from "../tracing/safeErrorLog";

export type AgentCliInboxItemsObservation = {
  /** Whether the CLI declared `inbox-items@1`. */
  declared: boolean;
  /** The agent's Computer when it did; null for an agent on none. */
  machineId: string | null;
  /** That Computer's daemon version (machines.daemon_version) then; null when unknown. */
  daemonVersion: string | null;
  /**
   * When the CLI last said so (ISO 8601), refreshed at most every
   * SEEN_AT_REFRESH_MS. Counts only for an agent on no Computer. Absent on
   * rows written before it existed: read as seen long ago.
   */
  seenAt?: string;
};

/** How long an agent on no Computer counts as having said what its CLI last said. */
export const AGENT_CLI_INBOX_ITEMS_NO_COMPUTER_TTL_MS = 24 * 60 * 60_000;
/** An unchanged answer rewrites `seenAt` only once it is this old. */
export const SEEN_AT_REFRESH_MS = 60 * 60_000;

/**
 * What this process last recorded per agent, so an unchanged answer writes
 * nothing. An entry lives LAST_RECORDED_TTL_MS: a request recorded just
 * before its Computer's new daemon version reached the machines row stored the
 * old version (read as "not declared here"), and is corrected on the first
 * request after the entry expires.
 */
const lastRecorded = new Map<string, { key: string; at: number }>();
const LAST_RECORDED_MAX = 50_000;
export const LAST_RECORDED_TTL_MS = 15 * 60_000;

/** For tests: forget what this process recorded. */
export function resetAgentCliInboxItemsCacheForTests(): void {
  lastRecorded.clear();
}

/**
 * Records what an agent-credential request says about the agent's CLI, in
 * the background (never throws, never delays the request). `client` is
 * `X-Raft-Client`, `capabilities` is `X-Raft-Client-Capabilities`,
 * `daemonVersionHeader` is `X-Raft-Daemon-Version` (only part of the
 * "changed?" key: what is stored is the Computer's own row).
 */
export function noteAgentCliInboxItems(input: {
  agentId: string;
  machineId: string | null;
  client: string | undefined;
  capabilities: string | undefined;
  daemonVersionHeader: string | undefined;
  now?: number;
}): void {
  if (input.client !== "cli" || input.capabilities === undefined) return;
  const declared = hasInboxItemsCapability(input.capabilities);
  const key = `${declared}|${input.machineId ?? ""}|${input.daemonVersionHeader ?? ""}`;
  const now = input.now ?? Date.now();
  const last = lastRecorded.get(input.agentId);
  if (last && last.key === key && now - last.at < LAST_RECORDED_TTL_MS) return;
  if (lastRecorded.size >= LAST_RECORDED_MAX) lastRecorded.clear();
  lastRecorded.set(input.agentId, { key, at: now });
  void recordAgentCliInboxItems(input.agentId, input.machineId, declared, new Date(now)).catch((error: unknown) => {
    lastRecorded.delete(input.agentId);
    console.warn("[agent-cli-inbox-items] record failed", serializeErrorForLog(error));
  });
}

/** Stores the observation with the Computer's current daemon version, seen `now`. Exported for tests. */
export async function recordAgentCliInboxItems(
  agentId: string,
  machineId: string | null,
  declared: boolean,
  now: Date = new Date(),
): Promise<void> {
  const db = getDb();
  let daemonVersion: string | null = null;
  if (machineId) {
    const [machine] = await db.select({ daemonVersion: machines.daemonVersion }).from(machines).where(eq(machines.id, machineId)).limit(1);
    daemonVersion = machine?.daemonVersion ?? null;
  }
  const answer = { declared, machineId, daemonVersion };
  const observation: AgentCliInboxItemsObservation = { ...answer, seenAt: now.toISOString() };
  // Only a change, or a `seenAt` due for a refresh (missing, or older than
  // SEEN_AT_REFRESH_MS), is written: an expired cache entry usually finds the
  // same answer. `seenAt` is always toISOString(), whose fixed format
  // compares as text in time order (and never fails a cast).
  const refreshBefore = new Date(now.getTime() - SEEN_AT_REFRESH_MS).toISOString();
  await db.update(agents).set({ cliInboxItems: observation }).where(and(
    eq(agents.id, agentId),
    sql`(
      (${agents.cliInboxItems} - 'seenAt') IS DISTINCT FROM ${JSON.stringify(answer)}::jsonb
      OR (${agents.cliInboxItems} ->> 'seenAt') IS NULL
      OR (${agents.cliInboxItems} ->> 'seenAt') < ${refreshBefore}
    )`,
  ));
}

/**
 * What Raft knows about the agent's CLI listing app items in its inbox:
 * `lists`, it declared so on its current Computer at that Computer's current
 * daemon version (on no Computer: within the last
 * AGENT_CLI_INBOX_ITEMS_NO_COMPUTER_TTL_MS); `old_cli`, it declared it can't
 * there; `unknown`, no answer for that Computer and version yet (never seen,
 * moved, upgraded, gone, or on no Computer not seen lately; it clears on the
 * agent's next CLI command). Only `lists` holds or merges an event.
 */
export type AgentCliInboxItemsState = "lists" | "old_cli" | "unknown";

export async function agentCliInboxItemsState(agentId: string, options: { now?: Date } = {}): Promise<AgentCliInboxItemsState> {
  const [row] = await getDb()
    .select({ observation: agents.cliInboxItems, machineId: agents.machineId, daemonVersion: machines.daemonVersion })
    .from(agents)
    .leftJoin(machines, eq(machines.id, agents.machineId))
    .where(eq(agents.id, agentId))
    .limit(1);
  const observation = row?.observation;
  if (!row || !observation) return "unknown";
  const current = observation.machineId === (row.machineId ?? null)
    && observation.daemonVersion === (row.daemonVersion ?? null);
  if (!current) return "unknown";
  if (observation.machineId === null && !seenWithinNoComputerTtl(observation.seenAt, options.now ?? new Date())) return "unknown";
  return observation.declared === true ? "lists" : "old_cli";
}

/** A `seenAt` missing (written before it existed) or unreadable counts as seen long ago. */
function seenWithinNoComputerTtl(seenAt: string | undefined, now: Date): boolean {
  const at = typeof seenAt === "string" ? Date.parse(seenAt) : Number.NaN;
  return Number.isFinite(at) && now.getTime() - at <= AGENT_CLI_INBOX_ITEMS_NO_COMPUTER_TTL_MS;
}

/** Whether the agent's CLI lists app items in its inbox (agentCliInboxItemsState is `lists`). */
export async function agentCliListsAppInboxItems(agentId: string): Promise<boolean> {
  return await agentCliInboxItemsState(agentId) === "lists";
}
