/**
 * Per-key connect budget for `/daemon/connect`, checked before credential
 * verification. An old daemon (or two daemons sharing one key) can reconnect
 * in a tight loop; every attempt otherwise costs an argon2 verify (~220 ms
 * when no HMAC secret is configured) plus registry work, even when it is going
 * to be refused (2026-10-20 incident: one key at ~28k connects/hour, ELB 502s).
 *
 * Keyed on the fingerprint of the presented key (sha256 prefix, what the auth
 * span already logs), so it costs one hash and one Redis round trip and needs
 * no lookup. Counted across replicas in Redis (fixed window); without Redis,
 * per replica in memory. Fails open: a Redis error admits the connect.
 */
import { getRedis, isRedisAvailable } from "../redis";

/** Connect attempts one key may start per window; a reconnect hand-off fits, a loop does not. */
export const MACHINE_CONNECT_RATE_LIMIT_MAX = 3;
export const MACHINE_CONNECT_RATE_LIMIT_WINDOW_SECONDS = 30;

export type MachineConnectAdmission = { admitted: true } | { admitted: false; retryAfterSeconds: number };

const key = (fingerprint: string) => `slock:machine-connect:${fingerprint}`;

/** INCR the window counter, start its TTL on the first hit; returns {count, ttl seconds}. */
const COUNT_CONNECT = `
local n = redis.call("INCR", KEYS[1])
if n == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then redis.call("EXPIRE", KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}`;

const memory = new Map<string, { count: number; resetAtMs: number }>();

function decide(count: number, ttlSeconds: number): MachineConnectAdmission {
  if (count <= MACHINE_CONNECT_RATE_LIMIT_MAX) return { admitted: true };
  return { admitted: false, retryAfterSeconds: Math.max(1, Math.ceil(ttlSeconds)) };
}

export async function admitMachineConnect(fingerprint: string, nowMs = Date.now()): Promise<MachineConnectAdmission> {
  if (!isRedisAvailable()) {
    let entry = memory.get(fingerprint);
    if (!entry || entry.resetAtMs <= nowMs) {
      entry = { count: 0, resetAtMs: nowMs + MACHINE_CONNECT_RATE_LIMIT_WINDOW_SECONDS * 1000 };
      memory.set(fingerprint, entry);
    }
    entry.count += 1;
    if (memory.size > 10_000) {
      for (const [k, v] of memory) if (v.resetAtMs <= nowMs) memory.delete(k);
    }
    return decide(entry.count, (entry.resetAtMs - nowMs) / 1000);
  }
  try {
    const result = await getRedis().eval(COUNT_CONNECT, 1, key(fingerprint), String(MACHINE_CONNECT_RATE_LIMIT_WINDOW_SECONDS)) as [number, number];
    return decide(Number(result[0]), Number(result[1]));
  } catch {
    return { admitted: true };
  }
}

/**
 * Per source address, failed verifications only. A key-fingerprint budget does
 * not bound random keys (each is a fresh bucket that still pays argon2), and a
 * plain per-address connect budget would throttle every machine behind one
 * proxy edge (the address is the CloudFront edge unless viewer headers are
 * trusted). Counting only rejected handshakes caps the random-key case and never
 * touches machines whose keys verify.
 */
export const MACHINE_CONNECT_FAILURES_PER_ADDRESS_MAX = 30;
export const MACHINE_CONNECT_FAILURES_WINDOW_SECONDS = 60;

const failureKey = (address: string) => `slock:machine-connect-failures:${address}`;
const failures = new Map<string, { count: number; resetAtMs: number }>();

/** Whether this address may try to verify a key now (read only; failures are counted after a rejection). */
export async function admitMachineConnectFromAddress(address: string, nowMs = Date.now()): Promise<MachineConnectAdmission> {
  if (!isRedisAvailable()) {
    const entry = failures.get(address);
    if (!entry || entry.resetAtMs <= nowMs || entry.count < MACHINE_CONNECT_FAILURES_PER_ADDRESS_MAX) return { admitted: true };
    return { admitted: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAtMs - nowMs) / 1000)) };
  }
  try {
    const redis = getRedis();
    const count = Number(await redis.get(failureKey(address)) ?? 0);
    if (count < MACHINE_CONNECT_FAILURES_PER_ADDRESS_MAX) return { admitted: true };
    const ttl = Number(await redis.ttl(failureKey(address)));
    return { admitted: false, retryAfterSeconds: Math.max(1, ttl > 0 ? ttl : MACHINE_CONNECT_FAILURES_WINDOW_SECONDS) };
  } catch {
    return { admitted: true };
  }
}

/** A handshake from this address failed credential verification. */
export async function recordMachineConnectAuthFailure(address: string, nowMs = Date.now()): Promise<void> {
  if (!isRedisAvailable()) {
    let entry = failures.get(address);
    if (!entry || entry.resetAtMs <= nowMs) {
      entry = { count: 0, resetAtMs: nowMs + MACHINE_CONNECT_FAILURES_WINDOW_SECONDS * 1000 };
      failures.set(address, entry);
    }
    entry.count += 1;
    return;
  }
  try {
    await getRedis().eval(COUNT_CONNECT, 1, failureKey(address), String(MACHINE_CONNECT_FAILURES_WINDOW_SECONDS));
  } catch {
    // Fail open: an uncounted failure only loosens the cap.
  }
}

/**
 * Keys that verified recently pass an exhausted address budget (their own key
 * budget still applies). Behind one CloudFront edge, stale daemons of deleted or
 * revoked Computers fail a couple of times a minute each; without this they
 * would hold every healthy machine behind that edge at 429. A fingerprint only
 * gets here by verifying, so random keys stay capped by the address budget.
 */
export const MACHINE_CONNECT_VERIFIED_TTL_SECONDS = 7 * 24 * 60 * 60;
const verifiedKey = (fingerprint: string) => `slock:machine-connect-ok:${fingerprint}`;
const verified = new Map<string, number>();

/** A handshake with this key fingerprint verified. */
export async function recordMachineConnectVerified(fingerprint: string, nowMs = Date.now()): Promise<void> {
  if (!isRedisAvailable()) {
    verified.set(fingerprint, nowMs + MACHINE_CONNECT_VERIFIED_TTL_SECONDS * 1000);
    if (verified.size > 10_000) {
      for (const [k, expiresAtMs] of verified) if (expiresAtMs <= nowMs) verified.delete(k);
    }
    return;
  }
  try {
    await getRedis().set(verifiedKey(fingerprint), "1", "EX", MACHINE_CONNECT_VERIFIED_TTL_SECONDS);
  } catch {
    // Not remembered: this key is only subject to the address budget again.
  }
}

export async function isMachineConnectVerified(fingerprint: string, nowMs = Date.now()): Promise<boolean> {
  if (!isRedisAvailable()) return (verified.get(fingerprint) ?? 0) > nowMs;
  try {
    return (await getRedis().exists(verifiedKey(fingerprint))) === 1;
  } catch {
    return false;
  }
}

/**
 * Keys whose rejection cannot turn into an accept on its own (the server is
 * gone, the key matches nothing, was migrated, or its Computer was deleted or
 * revoked). Stale daemons retry these every ~16 s around the clock (~211
 * rejections a minute in production, each an argon2 verify); a remembered
 * rejection is answered with the same 401 and reason without verifying. Keyed
 * on the full-key fingerprint, so nobody else can plant one. A Computer whose
 * machine was unlinked can be linked again, so that reason is not remembered.
 */
export const MACHINE_CONNECT_REJECTION_TTL_SECONDS = 10 * 60;
export const MACHINE_CONNECT_CACHED_REJECTION_REASONS: readonly string[] = [
  "server_not_found",
  "machine_key_invalid",
  "legacy_machine_key_migrated",
  "computer_not_found",
  "computer_revoked",
];
export interface CachedMachineConnectRejection {
  reason: string;
  stage: string;
  principalKind: string;
}
const rejectionKey = (fingerprint: string) => `slock:machine-connect-rejected:${fingerprint}`;
const rejections = new Map<string, { value: CachedMachineConnectRejection; expiresAtMs: number }>();

export async function rememberMachineConnectRejection(fingerprint: string, rejection: CachedMachineConnectRejection, nowMs = Date.now()): Promise<void> {
  if (!MACHINE_CONNECT_CACHED_REJECTION_REASONS.includes(rejection.reason)) return;
  if (!isRedisAvailable()) {
    rejections.set(fingerprint, { value: rejection, expiresAtMs: nowMs + MACHINE_CONNECT_REJECTION_TTL_SECONDS * 1000 });
    if (rejections.size > 10_000) {
      for (const [k, v] of rejections) if (v.expiresAtMs <= nowMs) rejections.delete(k);
    }
    return;
  }
  try {
    await getRedis().set(rejectionKey(fingerprint), JSON.stringify(rejection), "EX", MACHINE_CONNECT_REJECTION_TTL_SECONDS);
  } catch {
    // Not remembered: the next attempt verifies again.
  }
}

export async function cachedMachineConnectRejection(fingerprint: string, nowMs = Date.now()): Promise<CachedMachineConnectRejection | null> {
  if (!isRedisAvailable()) {
    const entry = rejections.get(fingerprint);
    return entry && entry.expiresAtMs > nowMs ? entry.value : null;
  }
  try {
    const raw = await getRedis().get(rejectionKey(fingerprint));
    if (!raw) return null;
    const value = JSON.parse(raw) as CachedMachineConnectRejection;
    return MACHINE_CONNECT_CACHED_REJECTION_REASONS.includes(value?.reason) && typeof value.stage === "string" && typeof value.principalKind === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Test seam: forget the in-memory windows (CI runs these tests without Redis). */
export function __resetMachineConnectRateLimitForTests(): void {
  memory.clear();
  failures.clear();
  verified.clear();
  rejections.clear();
}
