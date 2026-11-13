import { randomUUID } from "node:crypto";
import { getRedis, isRedisAvailable } from "../redis";

// At most `limit` holders of one name at once, across replicas: a lease per
// holder in one Redis sorted set (member: the lease's id, score: when it
// expires), taken and given back in one Lua call each. A lease ends when its
// holder gives it back, or at its expiry should the holder never do so (a
// replica that died mid-way), so a slot is never lost for longer than the
// lease. Without Redis the server runs as one replica, so this process's
// memory holds the leases; a Redis error on taking also falls back to memory
// (per replica) rather than refusing everyone or admitting everyone, as the
// fixed-window budgets do (fixedWindowRateLimit.ts). Used for Artifacts'
// concurrent imports (apps/artifacts/import.ts).

export type SlotLease = { taken: true; release(): Promise<void> } | { taken: false };

/** Drop expired leases, then add this one if fewer than ARGV[3] remain; 1 taken, 0 not. */
const TAKE = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call("ZADD", KEYS[1], ARGV[2], ARGV[4])
local keep = tonumber(ARGV[2]) - tonumber(ARGV[1])
if redis.call("PTTL", KEYS[1]) < keep then redis.call("PEXPIRE", KEYS[1], keep) end
return 1`;

export interface SharedSlots {
  /** A lease on one of `name`'s `limit` slots for at most `leaseMs`, or none when all are held. */
  take(name: string, limit: number, leaseMs: number, nowMs?: number): Promise<SlotLease>;
  /** Tests only: forget this process's leases. */
  clear(): void;
}

export function createSharedSlots(): SharedSlots {
  const memory = new Map<string, Map<string, number>>();
  const takeInMemory = (name: string, limit: number, expiresAtMs: number, nowMs: number, id: string): boolean => {
    const leases = memory.get(name) ?? new Map<string, number>();
    for (const [lease, until] of leases) if (until <= nowMs) leases.delete(lease);
    if (leases.size >= limit) return false;
    leases.set(id, expiresAtMs);
    memory.set(name, leases);
    return true;
  };
  const releaseInMemory = (name: string, id: string) => {
    const leases = memory.get(name);
    leases?.delete(id);
    if (leases?.size === 0) memory.delete(name);
  };
  return {
    async take(name, limit, leaseMs, nowMs = Date.now()) {
      const id = randomUUID();
      const expiresAtMs = nowMs + leaseMs;
      let where: "redis" | "memory" = "memory";
      let taken: boolean;
      if (isRedisAvailable()) {
        try {
          taken = Number(await getRedis().eval(TAKE, 1, name, String(nowMs), String(expiresAtMs), String(limit), id)) === 1;
          where = "redis";
        } catch {
          taken = takeInMemory(name, limit, expiresAtMs, nowMs, id);
        }
      } else {
        taken = takeInMemory(name, limit, expiresAtMs, nowMs, id);
      }
      if (!taken) return { taken: false };
      let held = true;
      return {
        taken: true,
        async release() {
          if (!held) return;
          held = false;
          if (where === "memory") {
            releaseInMemory(name, id);
            return;
          }
          // Best effort: a lease not given back ends at its expiry.
          await getRedis().zrem(name, id).catch(() => undefined);
        },
      };
    },
    clear: () => memory.clear(),
  };
}
