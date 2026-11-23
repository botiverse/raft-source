import {
  currentTimeMs,
  safeParseProcJobsSnapshot,
  type ProcJobsSnapshot,
} from "@botiverse/raft-shared";

import { getRedis, isRedisAvailable } from "../redis";
import {
  createRuntimeAccountUsageRoutingBackend,
  type RuntimeAccountUsageCacheBackend,
} from "./runtimeAccountUsageCacheService";

/**
 * The last `raft proc` job snapshot of each Computer (docs/contracts/proc-jobs.md),
 * as the server kept it: already capped and filtered to the agents assigned
 * to the Computer (agentOrchestrator `ingestProcJobsSnapshot`). Kept 15
 * minutes: a Computer reports every 5, so a missing key is "unknown" (an
 * offline or older Computer), never "no jobs".
 */
export const PROC_JOBS_CACHE_TTL_SECONDS = 15 * 60;
const CACHE_KEY_PREFIX = "slock:proc-jobs:v1";

export type ProcJobsCacheBackend = Pick<RuntimeAccountUsageCacheBackend, "get" | "set">;

type LocalEntry = { value: string; expiresAtMs: number };
const localEntries = new Map<string, LocalEntry>();

const localBackend: RuntimeAccountUsageCacheBackend = {
  async get(key) {
    const entry = localEntries.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= currentTimeMs()) {
      localEntries.delete(key);
      return null;
    }
    return entry.value;
  },
  async set(key, value, ttlSeconds) {
    localEntries.set(key, { value, expiresAtMs: currentTimeMs() + ttlSeconds * 1_000 });
  },
  async setIfAbsent(key, value, ttlSeconds) {
    if (await this.get(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  },
};

const redisBackend: RuntimeAccountUsageCacheBackend = {
  async get(key) {
    return getRedis().get(key);
  },
  async set(key, value, ttlSeconds) {
    await getRedis().set(key, value, "EX", ttlSeconds);
  },
  async setIfAbsent(key, value, ttlSeconds) {
    return (await getRedis().set(key, value, "EX", ttlSeconds, "NX")) === "OK";
  },
};

/** Redis when it is up (every replica reads one copy), this replica's memory otherwise; the usage cache's routing. */
function defaultBackend(): ProcJobsCacheBackend {
  return createRuntimeAccountUsageRoutingBackend({
    isSharedAvailable: isRedisAvailable,
    shared: redisBackend,
    local: localBackend,
  });
}

export function procJobsCacheKey(machineId: string): string {
  return `${CACHE_KEY_PREFIX}:${machineId}`;
}

export class ProcJobsCacheService {
  constructor(private readonly backend: ProcJobsCacheBackend = defaultBackend()) {}

  /** Re-validated on write (strict schema): what is not a snapshot is not kept. */
  async write(machineId: string, value: unknown): Promise<ProcJobsSnapshot | null> {
    const parsed = safeParseProcJobsSnapshot(value);
    if (!parsed.success) return null;
    await this.backend.set(procJobsCacheKey(machineId), JSON.stringify(parsed.data), PROC_JOBS_CACHE_TTL_SECONDS);
    return parsed.data;
  }

  /** Null: no snapshot within the TTL, or one that no longer reads (unknown). */
  async read(machineId: string): Promise<ProcJobsSnapshot | null> {
    const raw = await this.backend.get(procJobsCacheKey(machineId));
    if (!raw) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = safeParseProcJobsSnapshot(value);
    return parsed.success ? parsed.data : null;
  }
}

export const procJobsCacheService = new ProcJobsCacheService();
