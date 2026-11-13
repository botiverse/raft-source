import { getRedis, isRedisAvailable } from "../redis";

// A fixed-window budget that holds across replicas (the pattern of
// machineConnectRateLimit): one counter per name and window, INCR and its TTL
// in one Lua call in Redis. Without Redis the server runs as one replica
// (Redis is what enables multi-replica support), so this process's memory is
// the whole count. A Redis error falls back to the memory count instead of
// failing open. Used by the interactive link card limits
// (linkCardActionLimits.ts) and the card message update limits
// (messageCardService.ts) and the agent API's write budgets
// (agentApiWriteLimits.ts); each holds its own counter, so its memory and its
// test reset are its own.

export type FixedWindowAdmission = { admitted: true } | { admitted: false; retryAfterSeconds: number };

/** INCRBY the window counter by ARGV[2] units, start its TTL on the first hit (and repair a lost one); returns {count, ttl seconds}. */
const COUNT = `
local units = tonumber(ARGV[2] or "1")
local n = redis.call("INCRBY", KEYS[1], units)
if n == units then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then redis.call("EXPIRE", KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}`;

export interface FixedWindowCounter {
  /** Spends `units` (default one) of `name`'s window of `windowSeconds`; refused once more than `limit` were spent in it. */
  admit(name: string, limit: number, windowSeconds: number, nowMs?: number, units?: number): Promise<FixedWindowAdmission>;
  /** Tests only: forget this process's counts. */
  clear(): void;
}

export function createFixedWindowCounter(): FixedWindowCounter {
  const memory = new Map<string, { count: number; resetAtMs: number }>();
  const countInMemory = (name: string, windowSeconds: number, nowMs: number, units: number): [number, number] => {
    let entry = memory.get(name);
    if (!entry || entry.resetAtMs <= nowMs) {
      entry = { count: 0, resetAtMs: nowMs + windowSeconds * 1000 };
      memory.set(name, entry);
    }
    entry.count += units;
    if (memory.size > 10_000) {
      for (const [k, v] of memory) if (v.resetAtMs <= nowMs) memory.delete(k);
    }
    return [entry.count, (entry.resetAtMs - nowMs) / 1000];
  };
  return {
    async admit(name, limit, windowSeconds, nowMs = Date.now(), units = 1) {
      const spend = Math.max(1, Math.floor(units));
      let count: number; let ttlSeconds: number;
      if (isRedisAvailable()) {
        try {
          const result = await getRedis().eval(COUNT, 1, name, String(windowSeconds), String(spend)) as [number, number];
          [count, ttlSeconds] = [Number(result[0]), Number(result[1])];
        } catch {
          [count, ttlSeconds] = countInMemory(name, windowSeconds, nowMs, spend);
        }
      } else {
        [count, ttlSeconds] = countInMemory(name, windowSeconds, nowMs, spend);
      }
      return count <= limit ? { admitted: true } : { admitted: false, retryAfterSeconds: Math.max(1, Math.ceil(ttlSeconds)) };
    },
    clear: () => memory.clear(),
  };
}
