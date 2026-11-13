import assert from "node:assert/strict";
import { vi } from "vitest";
import * as redis from "../redis";

/**
 * A Redis double for the counts replicas share, on a clock the test moves:
 * the fixed-window counter's script (services/fixedWindowRateLimit.ts: INCRBY
 * and a TTL on one key) and the slots' (services/sharedSlots.ts: leases in a
 * sorted set, ZREM to give one back). Every replica of a test talks to it, as
 * to the one Redis; `failing` throws on every call (Redis down).
 */
export function installFakeRedis(options: { failing?: boolean } = {}) {
  const counters = new Map<string, { count: number; expiresAtMs: number }>();
  const leases = new Map<string, Map<string, number>>();
  const clock = { now: 0 };
  const client = {
    async eval(script: string, numKeys: number, key: string, ...args: string[]) {
      if (options.failing) throw new Error("redis down");
      assert.equal(numKeys, 1);
      if (/INCRBY/.test(script)) {
        const [windowSeconds = "60", units = "1"] = args;
        let entry = counters.get(key);
        if (entry && entry.expiresAtMs <= clock.now) entry = undefined;
        const next = { count: (entry?.count ?? 0) + Number(units), expiresAtMs: entry?.expiresAtMs ?? clock.now + Number(windowSeconds) * 1000 };
        counters.set(key, next);
        return [next.count, Math.ceil((next.expiresAtMs - clock.now) / 1000)];
      }
      if (/ZREMRANGEBYSCORE/.test(script)) {
        const [nowMs, expiresAtMs, limit, id] = args;
        const held = leases.get(key) ?? new Map<string, number>();
        for (const [lease, until] of held) if (until <= Number(nowMs)) held.delete(lease);
        leases.set(key, held);
        if (held.size >= Number(limit)) return 0;
        held.set(id!, Number(expiresAtMs));
        return 1;
      }
      throw new Error(`unexpected script: ${script.trim().slice(0, 60)}`);
    },
    async zrem(key: string, member: string) {
      if (options.failing) throw new Error("redis down");
      return leases.get(key)?.delete(member) ? 1 : 0;
    },
  };
  const spies = [
    vi.spyOn(redis, "isRedisAvailable").mockReturnValue(true),
    vi.spyOn(redis, "getRedis").mockReturnValue(client as unknown as ReturnType<typeof redis.getRedis>),
  ];
  return { counters, leases, clock, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}
