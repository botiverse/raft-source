/**
 * Per-person budget for joint channel invites (create with invites, or invite
 * another server into an existing one). A joint invite only succeeds when the
 * invited person is an owner or admin of the target server, so whether it
 * succeeds still tells the inviter whether an address is an admin there. The
 * refusals already read alike (`joint_invitee_unavailable`); this budget makes
 * trying address after address slow.
 *
 * Counted in invited people, not requests: one request can name several
 * people on several servers. Checked before validation, so refused invites
 * count too. Keyed on the person (not the server): joining more servers must
 * not multiply the budget. Counted across replicas in Redis (fixed window);
 * without Redis, per replica in memory. Fails open: a Redis error admits.
 */
import { getRedis, isRedisAvailable } from "../redis";

/** Invited people one person may name per window: real invites fit, a sweep does not. */
export const JOINT_INVITE_RATE_LIMIT_MAX_PEOPLE = 60;
export const JOINT_INVITE_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

export type JointInviteAdmission = { admitted: true } | { admitted: false; retryAfterSeconds: number };

const key = (userId: string) => `slock:joint-invite-people:${userId}`;

/** INCRBY the window counter, start its TTL on the first hit; returns {count, ttl seconds}. */
const COUNT_PEOPLE = `
local n = redis.call("INCRBY", KEYS[1], ARGV[2])
if n == tonumber(ARGV[2]) then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then redis.call("EXPIRE", KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}`;

const memory = new Map<string, { count: number; resetAtMs: number }>();

function decide(count: number, ttlSeconds: number): JointInviteAdmission {
  if (count <= JOINT_INVITE_RATE_LIMIT_MAX_PEOPLE) return { admitted: true };
  return { admitted: false, retryAfterSeconds: Math.max(1, Math.ceil(ttlSeconds)) };
}

/** Count `people` invited people against this person's window; refuse once it is spent. */
export async function admitJointInvite(userId: string, people: number, nowMs = Date.now()): Promise<JointInviteAdmission> {
  const weight = Math.max(1, Math.floor(people));
  if (!isRedisAvailable()) {
    let entry = memory.get(userId);
    if (!entry || entry.resetAtMs <= nowMs) {
      entry = { count: 0, resetAtMs: nowMs + JOINT_INVITE_RATE_LIMIT_WINDOW_SECONDS * 1000 };
      memory.set(userId, entry);
    }
    entry.count += weight;
    if (memory.size > 10_000) {
      for (const [k, v] of memory) if (v.resetAtMs <= nowMs) memory.delete(k);
    }
    return decide(entry.count, (entry.resetAtMs - nowMs) / 1000);
  }
  try {
    const result = await getRedis().eval(COUNT_PEOPLE, 1, key(userId), String(JOINT_INVITE_RATE_LIMIT_WINDOW_SECONDS), String(weight)) as [number, number];
    return decide(Number(result[0]), Number(result[1]));
  } catch {
    return { admitted: true };
  }
}

/** Test seam: forget the in-memory windows. */
export function resetJointInviteRateLimitForTests(): void {
  memory.clear();
}
