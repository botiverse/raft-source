/**
 * Asking the owners of other people's agents on your Computers to move them
 * (POST /api/me/account/deletion/notify-agent-owners; artin/Tenny 2026-11-04,
 * #triage:d10ace06). Such an agent blocks the deletion request (409
 * `others_agents_on_computers`, requests.ts): the person cannot move it
 * themself, so they ask, and its owner gets a system notice in their DM with
 * the agent (agentActionRequiredNoticeService.ts `computer_owner_leaving`):
 * which Computer, that it goes offline when its owner submits their account
 * deletion, and to move the agent. Nothing about the person beyond that.
 *
 * At most once per person and agent per 24 hours. When each was last sent
 * (`ownerNotifiedAt` on GET and in the 409) is kept for 30 days in Redis
 * across replicas, else in this process's memory (without Redis the server
 * runs as one replica; the pattern of fixedWindowRateLimit.ts). A Redis error
 * falls back to memory. Losing it (a Redis flush, a restart without Redis)
 * only lets the person ask again sooner; no table for that.
 *
 * Revoking one Computer's key from the web is refused the same way (409
 * `others_agents_on_computer`, routes/servers.ts), and its
 * POST /servers/:id/machines/:machineId/notify-agent-owners asks through
 * notifyAgentOwners too (notice `computer_detach_requested`), under the same
 * once-per-person-and-agent limit: one ask covers both.
 */
import { getRedis, isRedisAvailable } from "../../redis";
import { serializeErrorForLog } from "../../tracing/safeErrorLog";
import type { AgentOwner } from "../computerAgents";

/** How often one person may ask about one agent. */
export const AGENT_OWNER_NOTICE_INTERVAL_MS = 24 * 60 * 60_000;
/** How long `ownerNotifiedAt` is remembered. */
const AGENT_OWNER_NOTICE_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Most agent ids one call may name. */
export const AGENT_OWNER_NOTICE_MAX_IDS = 200;

export type AgentOwnerNoticeSkipReason = "not_on_your_computer" | "no_owner" | "rate_limited" | "not_delivered";

export type NotifyAgentOwnersResult = {
  notified: { agentId: string; notifiedAt: string }[];
  skipped: { agentId: string; reason: AgentOwnerNoticeSkipReason; nextAllowedAt?: string }[];
};

const key = (requesterId: string, agentId: string) => `slock:account-deletion:owner-notice:${requesterId}:${agentId}`;

const memory = new Map<string, number>();

function pruneMemory(nowMs: number): void {
  if (memory.size <= 10_000) return;
  for (const [k, at] of memory) if (at + AGENT_OWNER_NOTICE_RETENTION_MS <= nowMs) memory.delete(k);
}

function readMemory(k: string, nowMs: number): number | null {
  const at = memory.get(k);
  if (at === undefined) return null;
  if (at + AGENT_OWNER_NOTICE_RETENTION_MS <= nowMs) { memory.delete(k); return null; }
  return at;
}

/** When `requesterId` last asked the owner of each of these agents (absent: never, or over 30 days ago). */
export async function readOwnerNotifiedAt(requesterId: string, agentIds: readonly string[], nowMs = Date.now()): Promise<Map<string, Date>> {
  const result = new Map<string, Date>();
  if (agentIds.length === 0) return result;
  const keys = agentIds.map((agentId) => key(requesterId, agentId));
  let values: (number | null)[] | null = null;
  if (isRedisAvailable()) {
    try {
      values = (await getRedis().mget(...keys)).map((raw) => (raw === null ? null : Number(raw)));
    } catch (err) {
      console.warn("[account-deletion] owner notice times: Redis read failed, using memory:", serializeErrorForLog(err));
    }
  }
  values ??= keys.map((k) => readMemory(k, nowMs));
  agentIds.forEach((agentId, index) => {
    const at = values![index];
    if (at !== null && at !== undefined && Number.isFinite(at)) result.set(agentId, new Date(at));
  });
  return result;
}

/** When the person last asked about an agent, and when they may ask again (null: now). */
export type OwnerNotifyTimes = { ownerNotifiedAt: string | null; ownerNextNotifyAt: string | null };

/** `ownerNotifiedAt` and `ownerNextNotifyAt` for one agent, from when this person last asked (if ever). */
export function ownerNotifyTimes(notifiedAt: Date | undefined, nowMs: number): OwnerNotifyTimes {
  if (!notifiedAt) return { ownerNotifiedAt: null, ownerNextNotifyAt: null };
  const next = notifiedAt.getTime() + AGENT_OWNER_NOTICE_INTERVAL_MS;
  return { ownerNotifiedAt: notifiedAt.toISOString(), ownerNextNotifyAt: next > nowMs ? new Date(next).toISOString() : null };
}

/** These agents with the notice times filled in (outside any transaction: it reads Redis). */
export async function withOwnerNotifyTimes<T extends { id: string }>(requesterId: string, list: readonly T[], nowMs = Date.now()): Promise<(T & OwnerNotifyTimes)[]> {
  const notified = list.length === 0 ? new Map<string, Date>() : await readOwnerNotifiedAt(requesterId, list.map((agent) => agent.id), nowMs);
  return list.map((agent) => ({ ...agent, ...ownerNotifyTimes(notified.get(agent.id), nowMs) }));
}

/** Records ARGV[1] unless the last ask was under 24 hours ago: {1, previous or ""} when recorded, {0, previous} when not. */
const CLAIM = `
local prev = redis.call("GET", KEYS[1])
if prev and tonumber(prev) > tonumber(ARGV[1]) - tonumber(ARGV[2]) then return {0, prev} end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[3])
return {1, prev or ""}`;

type Claim = { claimed: true; previous: number | null } | { claimed: false; previous: number };

async function claim(k: string, nowMs: number): Promise<Claim> {
  if (isRedisAvailable()) {
    try {
      const [recorded, previousRaw] = await getRedis().eval(CLAIM, 1, k, String(nowMs), String(AGENT_OWNER_NOTICE_INTERVAL_MS), String(AGENT_OWNER_NOTICE_RETENTION_MS)) as [number, string];
      if (Number(recorded) !== 1) return { claimed: false, previous: Number(previousRaw) };
      return { claimed: true, previous: previousRaw === "" ? null : Number(previousRaw) };
    } catch (err) {
      console.warn("[account-deletion] owner notice claim: Redis failed, using memory:", serializeErrorForLog(err));
    }
  }
  const previous = readMemory(k, nowMs);
  if (previous !== null && previous > nowMs - AGENT_OWNER_NOTICE_INTERVAL_MS) return { claimed: false, previous };
  memory.set(k, nowMs);
  pruneMemory(nowMs);
  return { claimed: true, previous };
}

/** Undoes a claim whose notice was not posted: the earlier time comes back (or none). */
async function release(k: string, nowMs: number, previous: number | null): Promise<void> {
  if (isRedisAvailable()) {
    try {
      const redis = getRedis();
      if ((await redis.get(k)) !== String(nowMs)) return;
      if (previous === null) await redis.del(k);
      else await redis.set(k, String(previous), "PX", Math.max(1, previous + AGENT_OWNER_NOTICE_RETENTION_MS - nowMs));
      return;
    } catch (err) {
      console.warn("[account-deletion] owner notice release: Redis failed:", serializeErrorForLog(err));
    }
  }
  if (memory.get(k) !== nowMs) return;
  if (previous === null) memory.delete(k);
  else memory.set(k, previous);
}

/**
 * Body of POST /notify-agent-owners: `{ agentIds }`, a non-empty list of at
 * most AGENT_OWNER_NOTICE_MAX_IDS non-empty strings (repeats collapse).
 * Null when it is not.
 */
export function parseNotifyAgentOwnersBody(body: unknown): string[] | null {
  const agentIds = parseAgentIdList((body && typeof body === "object" ? body as { agentIds?: unknown } : {}).agentIds);
  return agentIds && agentIds.length > 0 ? agentIds : null;
}

/** A list of at most AGENT_OWNER_NOTICE_MAX_IDS non-empty strings, repeats collapsed (empty allowed); null when it is not one. */
export function parseAgentIdList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > AGENT_OWNER_NOTICE_MAX_IDS) return null;
  if (!value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100)) return null;
  return [...new Set(value as string[])];
}

/** An agent whose owner may be asked to move it: its Computer's name goes into the notice. */
export type BlockingAgent = { id: string; owner: AgentOwner | null; computer: { name: string } };

/**
 * For each id: one of `blocking` (someone else's agents on `requesterId`'s
 * live Computers, findOthersAgentsOnComputers, or on the one Computer they
 * are removing: what the 409 lists) with an owner, not asked about in the last 24
 * hours, gets the notice through `post` (the action-required notice, to its
 * owner); anything else is skipped with why. `post` answering false (the
 * notice could not be posted) gives the claim back: `not_delivered`.
 */
export async function notifyAgentOwners(input: {
  requesterId: string;
  agentIds: readonly string[];
  blocking: readonly BlockingAgent[];
  now?: Date;
  post: (agent: { agentId: string; ownerUserId: string; computerName: string }) => Promise<boolean>;
}): Promise<NotifyAgentOwnersResult> {
  const nowMs = (input.now ?? new Date()).getTime();
  const blocking = new Map(input.blocking.map((agent) => [agent.id, agent]));
  const result: NotifyAgentOwnersResult = { notified: [], skipped: [] };
  for (const agentId of input.agentIds) {
    const agent = blocking.get(agentId);
    if (!agent) { result.skipped.push({ agentId, reason: "not_on_your_computer" }); continue; }
    if (!agent.owner) { result.skipped.push({ agentId, reason: "no_owner" }); continue; }
    const k = key(input.requesterId, agentId);
    const claimed = await claim(k, nowMs);
    if (!claimed.claimed) {
      result.skipped.push({ agentId, reason: "rate_limited", nextAllowedAt: new Date(claimed.previous + AGENT_OWNER_NOTICE_INTERVAL_MS).toISOString() });
      continue;
    }
    let posted = false;
    try {
      posted = await input.post({ agentId, ownerUserId: agent.owner.id, computerName: agent.computer.name });
    } catch (err) {
      console.error(`[account-deletion] owner notice for agent ${agentId} failed:`, serializeErrorForLog(err));
    }
    if (!posted) {
      await release(k, nowMs, claimed.previous);
      result.skipped.push({ agentId, reason: "not_delivered" });
      continue;
    }
    result.notified.push({ agentId, notifiedAt: new Date(nowMs).toISOString() });
  }
  return result;
}

/** Tests only: forget this process's notice times. */
export function __clearAgentOwnerNoticeMemoryForTests(): void {
  memory.clear();
}
