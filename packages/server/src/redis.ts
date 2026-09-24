import Redis, { type RedisOptions } from "ioredis";
import { redisErrors, redisConnected } from "./metrics.js";

let _redis: Redis | null = null;
let _redisSub: Redis | null = null;
let _redisPub: Redis | null = null;
let _redisReplicaSub: Redis | null = null;
let _redisUrl: string | null = null;
let _redisOpts: RedisOptions | null = null;

function attachRedisClientMetrics(name: string, client: Redis) {
  client.on("error", (err) => {
    redisErrors.labels(name).inc();
    console.error(`[${name}] error:`, err.message);
  });
  client.on("connect", () => {
    redisConnected.labels(name).set(1);
    console.log(`[${name}] connected`);
  });
  client.on("close", () => redisConnected.labels(name).set(0));
}

/**
 * Initialize Redis connections. Call once at startup.
 * Creates 3 connections: general, pub, sub (Socket.io adapter needs dedicated pub/sub pair).
 */
export function initRedis(redisUrl: string) {
  // Fly.io internal networking uses IPv6 (6PN). When the Redis URL points to a
  // *.internal host, force IPv6 so ioredis doesn't try IPv4 and fail/timeout.
  const needsIPv6 = /\.internal[:/]/.test(redisUrl) || redisUrl.endsWith(".internal");
  const opts: RedisOptions = { maxRetriesPerRequest: null };
  if (needsIPv6) opts.family = 6;
  _redisUrl = redisUrl;
  _redisOpts = opts;

  _redis = new Redis(redisUrl, opts);
  _redisPub = new Redis(redisUrl, opts);
  _redisSub = new Redis(redisUrl, opts);
  _redisReplicaSub = new Redis(redisUrl, opts);

  for (const [name, client] of [["redis", _redis], ["redis_pub", _redisPub], ["redis_sub", _redisSub], ["redis_replica_sub", _redisReplicaSub]] as const) {
    attachRedisClientMetrics(name, client);
  }
}

/** General-purpose Redis client (commands, pub, locks, caches) */
export function getRedis(): Redis {
  if (!_redis) throw new Error("Redis not initialized — call initRedis() first");
  return _redis;
}

/** Dedicated publisher for Socket.io Redis adapter */
export function getRedisPub(): Redis {
  if (!_redisPub) throw new Error("Redis not initialized");
  return _redisPub;
}

/** Dedicated subscriber for Socket.io Redis adapter */
export function getRedisSub(): Redis {
  if (!_redisSub) throw new Error("Redis not initialized");
  return _redisSub;
}

/** Dedicated subscriber for ReplicaRouter cross-replica pub/sub */
export function getRedisReplicaSub(): Redis {
  if (!_redisReplicaSub) throw new Error("Redis not initialized");
  return _redisReplicaSub;
}

/** Recreate the dedicated ReplicaRouter subscriber after subscriber-mode drift. */
export function resetRedisReplicaSub(): Redis {
  if (!_redisUrl || !_redisOpts) throw new Error("Redis not initialized");
  try {
    _redisReplicaSub?.disconnect();
  } catch {
    // best effort: the replacement client below is authoritative
  }
  _redisReplicaSub = new Redis(_redisUrl, _redisOpts);
  attachRedisClientMetrics("redis_replica_sub", _redisReplicaSub);
  return _redisReplicaSub;
}

/** Returns true if Redis is configured and available */
export function isRedisAvailable(): boolean {
  return _redis !== null;
}

export async function shutdownRedis() {
  await Promise.all([
    _redis?.quit(),
    _redisPub?.quit(),
    _redisSub?.quit(),
    _redisReplicaSub?.quit(),
  ]);
}
