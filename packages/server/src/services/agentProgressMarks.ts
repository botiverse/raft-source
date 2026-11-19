/**
 * #proj-runtime:#62: when an agent last moved anything forward on the server,
 * for the repeated-wake guard (agentRepeatedWakeGuard.ts).
 *
 * Progress is a write through the Agent API that succeeded (a send, a task or
 * reaction change, any route with a write budget: AGENT_API_WRITE_BUDGET_ROUTES)
 * or the agent's read position moving. An inbox check or a read that finds
 * nothing new marks nothing.
 *
 * The mark crosses replicas through Redis: an agent's Agent API requests can
 * land on any replica, its activity only on the one holding its Computer's
 * connection. A Redis failure reads as "progress now", so a lost mark can only
 * keep an agent running, never stop one.
 */
import { getRedis, isRedisAvailable } from "../redis";

const KEY_PREFIX = "agent:progress-at:";
/** A mark is compared with the agent's previous turn end; an agent makes progress only inside a turn, so hours are plenty. */
const TTL_SECONDS = 6 * 60 * 60;
const LOCAL_MARKS_MAX = 20_000;

const localMarks = new Map<string, number>();

function remember(map: Map<string, number>, agentId: string, atMs: number): void {
  map.delete(agentId);
  map.set(agentId, atMs);
  if (map.size > LOCAL_MARKS_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** The agent moved something forward now. Never throws and never waits. */
export function markAgentProgress(agentId: string, atMs: number = Date.now()): void {
  remember(localMarks, agentId, atMs);
  if (!isRedisAvailable()) return;
  void getRedis().set(`${KEY_PREFIX}${agentId}`, String(atMs), "EX", TTL_SECONDS).catch(() => {});
}

/**
 * When the agent last made progress, as far as this replica and Redis know;
 * null when never (within the TTL). A failed Redis read answers `nowMs`.
 */
export async function agentProgressAtMs(agentId: string, nowMs: number = Date.now()): Promise<number | null> {
  const local = localMarks.get(agentId) ?? null;
  if (!isRedisAvailable()) return local;
  try {
    const stored = Number(await getRedis().get(`${KEY_PREFIX}${agentId}`));
    const shared = Number.isFinite(stored) && stored > 0 ? stored : null;
    if (shared === null) return local;
    return local === null ? shared : Math.max(local, shared);
  } catch {
    return nowMs;
  }
}

/** Tests only. */
export function resetAgentProgressMarksForTests(): void {
  localMarks.clear();
}
