/**
 * #proj-runtime:#62: what an enforced repeated-wake trip leaves behind
 * (agentRepeatedWakeGuard.ts), shared across replicas through Redis.
 *
 * - The exclusion: the one message the agent kept being woken by is left out
 *   of its starts' unread catch-up, so a fresh process is not offered it first
 *   and the loop does not repeat on every wake. The message stays unread in
 *   its conversation; the agent can still read it, and every other message
 *   wakes it as usual. A person starting the agent (Start, Resume, Stop then
 *   Start) clears it; reading past the message ends it by itself, because the
 *   catch-up holds only unread messages. Otherwise it expires.
 * - The notice claim: the owner is told once per agent and message.
 *
 * Without Redis (one replica) both live in this process.
 */
import { getRedis, isRedisAvailable } from "../redis";

const EXCLUSION_PREFIX = "agent:repeated-wake:excluded:";
const NOTICE_PREFIX = "agent:repeated-wake:notified:";
const TTL_SECONDS = 7 * 24 * 60 * 60;

const localExclusions = new Map<string, string>();
const localNotices = new Set<string>();

export async function setRepeatedWakeExclusion(agentId: string, messageId: string): Promise<void> {
  localExclusions.set(agentId, messageId);
  if (!isRedisAvailable()) return;
  await getRedis().set(`${EXCLUSION_PREFIX}${agentId}`, messageId, "EX", TTL_SECONDS);
}

/** The message left out of this agent's catch-up, if any. A failed read leaves nothing out. */
export async function repeatedWakeExclusion(agentId: string): Promise<string | null> {
  if (!isRedisAvailable()) return localExclusions.get(agentId) ?? null;
  try {
    return (await getRedis().get(`${EXCLUSION_PREFIX}${agentId}`)) || null;
  } catch {
    return null;
  }
}

export async function clearRepeatedWakeExclusion(agentId: string): Promise<void> {
  localExclusions.delete(agentId);
  if (!isRedisAvailable()) return;
  await getRedis().del(`${EXCLUSION_PREFIX}${agentId}`);
}

/** True the first time for this agent and message (then the caller tells the owner). */
export async function claimRepeatedWakeNotice(agentId: string, messageId: string): Promise<boolean> {
  const key = `${NOTICE_PREFIX}${agentId}:${messageId}`;
  if (!isRedisAvailable()) {
    if (localNotices.has(key)) return false;
    localNotices.add(key);
    return true;
  }
  return (await getRedis().set(key, "1", "EX", TTL_SECONDS, "NX")) === "OK";
}

/** Tests only. */
export function resetRepeatedWakeStoreForTests(): void {
  localExclusions.clear();
  localNotices.clear();
}
