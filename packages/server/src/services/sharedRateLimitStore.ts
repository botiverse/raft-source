import type { NextFunction, Request, Response } from "express";
import { MemoryStore, type ClientRateLimitInfo, type Options, type Store } from "express-rate-limit";
import { setRequestTraceRateLimiter } from "../middleware/requestObservability";
import { getRedis, isRedisAvailable } from "../redis";

// An express-rate-limit store whose counts hold across replicas: one Redis
// counter per key and window (INCR and its TTL in one Lua call, the pattern
// of fixedWindowRateLimit.ts). Without Redis the server runs as one replica,
// so this process's memory is the whole count; a Redis error also falls back
// to the memory count for that request, so an outage limits per replica
// instead of refusing everyone or admitting everyone.

/** INCR the window counter, start its TTL on the first hit (and repair a lost one); returns {count, ttl ms}. */
const INCREMENT = `
local n = redis.call("INCR", KEYS[1])
if n == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then redis.call("PEXPIRE", KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}`;

/** DECR an existing counter (a request the limiter decided not to count); never below zero, never creates one. */
const DECREMENT = `
local n = redis.call("GET", KEYS[1])
if n and tonumber(n) > 0 then redis.call("DECR", KEYS[1]) end
return 0`;

export class SharedRateLimitStore implements Store {
  readonly prefix: string;
  readonly localKeys = false;
  private windowMs = 60_000;
  private readonly memory = new MemoryStore();

  /** `name` keeps each limiter's counters apart in Redis. */
  constructor(name: string) {
    this.prefix = `rl:${name}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.memory.init(options);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    if (isRedisAvailable()) {
      try {
        const [count, ttlMs] = await getRedis().eval(INCREMENT, 1, this.prefix + key, String(this.windowMs)) as [number, number];
        return { totalHits: Number(count), resetTime: new Date(Date.now() + Number(ttlMs)) };
      } catch {
        // Fall through to this replica's count.
      }
    }
    return this.memory.increment(key);
  }

  async decrement(key: string): Promise<void> {
    if (isRedisAvailable()) {
      try {
        await getRedis().eval(DECREMENT, 1, this.prefix + key);
        return;
      } catch {
        // Fall through to this replica's count.
      }
    }
    await this.memory.decrement(key);
  }

  async resetKey(key: string): Promise<void> {
    if (isRedisAvailable()) {
      try {
        await getRedis().del(this.prefix + key);
      } catch {
        // The memory count below is still reset.
      }
    }
    await this.memory.resetKey(key);
  }

  shutdown(): void {
    this.memory.shutdown();
  }
}

/**
 * A limiter's store and its 429 answer: the same body and status as
 * express-rate-limit's default handler, plus the limiter's name on the
 * request's span (`rate_limiter`), so refusals can be split by limiter.
 */
export function sharedRateLimit(name: string): Pick<Options, "store" | "handler"> {
  return {
    store: new SharedRateLimitStore(name),
    handler: async (req: Request, res: Response, _next: NextFunction, options: Options) => {
      setRequestTraceRateLimiter(res, name);
      res.status(options.statusCode);
      const message = typeof options.message === "function" ? await options.message(req, res) : options.message;
      if (!res.writableEnded) res.send(message);
    },
  };
}
