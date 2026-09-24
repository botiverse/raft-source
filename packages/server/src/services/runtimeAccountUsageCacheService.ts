import {
  currentTimeMs,
  RUNTIME_ACCOUNT_USAGE_PROVIDERS,
  safeParseRuntimeAccountUsageSnapshot,
  type RuntimeAccountUsageProvider,
  type RuntimeAccountUsageSnapshot,
} from "@botiverse/raft-shared";

import { getRedis, isRedisAvailable } from "../redis.js";

export const RUNTIME_ACCOUNT_USAGE_CACHE_TTL_SECONDS = 24 * 60 * 60;
export const RUNTIME_ACCOUNT_USAGE_REFRESH_COOLDOWN_SECONDS = 2 * 60;
const CACHE_KEY_PREFIX = "slock:runtime-account-usage:v2";
const REFRESH_KEY_PREFIX = "slock:runtime-account-usage-refresh:v2";

export type RuntimeAccountUsageCacheRead =
  | { state: "missing"; snapshot: null }
  | { state: "fresh" | "stale"; snapshot: RuntimeAccountUsageSnapshot };

export interface RuntimeAccountUsageCacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
}

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

export function createRuntimeAccountUsageRoutingBackend({
  isSharedAvailable,
  shared,
  local,
}: {
  isSharedAvailable: () => boolean;
  shared: RuntimeAccountUsageCacheBackend;
  local: RuntimeAccountUsageCacheBackend;
}): RuntimeAccountUsageCacheBackend {
  const current = () => isSharedAvailable() ? shared : local;
  return {
    async get(key) {
      return current().get(key);
    },
    async set(key, value, ttlSeconds) {
      await current().set(key, value, ttlSeconds);
    },
    async setIfAbsent(key, value, ttlSeconds) {
      return current().setIfAbsent(key, value, ttlSeconds);
    },
  };
}

function defaultBackend(): RuntimeAccountUsageCacheBackend {
  return createRuntimeAccountUsageRoutingBackend({
    isSharedAvailable: isRedisAvailable,
    shared: redisBackend,
    local: localBackend,
  });
}

function isProvider(value: string): value is RuntimeAccountUsageProvider {
  return (RUNTIME_ACCOUNT_USAGE_PROVIDERS as readonly string[]).includes(value);
}

function cacheKey(machineId: string, provider: RuntimeAccountUsageProvider): string {
  return `${CACHE_KEY_PREFIX}:${machineId}:${provider}`;
}

function refreshKey(machineId: string, provider: RuntimeAccountUsageProvider): string {
  return `${REFRESH_KEY_PREFIX}:${machineId}:${provider}`;
}

export class RuntimeAccountUsageCacheService {
  constructor(
    private readonly backend: RuntimeAccountUsageCacheBackend = defaultBackend(),
    private readonly now: () => number = currentTimeMs,
  ) {}

  async write(machineId: string, value: unknown): Promise<RuntimeAccountUsageSnapshot | null> {
    const parsed = safeParseRuntimeAccountUsageSnapshot(value);
    if (!parsed.success) return null;
    const snapshot = parsed.data;
    await this.backend.set(
      cacheKey(machineId, snapshot.provider),
      JSON.stringify(snapshot),
      RUNTIME_ACCOUNT_USAGE_CACHE_TTL_SECONDS,
    );
    return snapshot;
  }

  async read(machineId: string, providerValue: string): Promise<RuntimeAccountUsageCacheRead> {
    if (!isProvider(providerValue)) return { state: "missing", snapshot: null };
    const raw = await this.backend.get(cacheKey(machineId, providerValue));
    if (!raw) return { state: "missing", snapshot: null };
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { state: "missing", snapshot: null };
    }
    const parsed = safeParseRuntimeAccountUsageSnapshot(value);
    if (!parsed.success || parsed.data.provider !== providerValue) {
      return { state: "missing", snapshot: null };
    }
    return {
      state: Date.parse(parsed.data.staleAfter) <= this.now() ? "stale" : "fresh",
      snapshot: parsed.data,
    };
  }

  async tryAcquireRefresh(machineId: string, providerValue: string): Promise<boolean> {
    if (!isProvider(providerValue)) return false;
    return this.backend.setIfAbsent(
      refreshKey(machineId, providerValue),
      "1",
      RUNTIME_ACCOUNT_USAGE_REFRESH_COOLDOWN_SECONDS,
    );
  }
}

export const runtimeAccountUsageCacheService = new RuntimeAccountUsageCacheService();

export function __clearRuntimeAccountUsageLocalCacheForTests(): void {
  localEntries.clear();
}
