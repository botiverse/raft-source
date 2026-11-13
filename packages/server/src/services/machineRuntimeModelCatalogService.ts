import {
  currentTimeMs,
  isRuntimeAuthRuntime,
  runtimeAuthSignsInPerProvider,
  safeParseRuntimeModelCatalogEntries,
  type MachineRuntimeModelCatalog,
} from "@botiverse/raft-shared";

import { getRedis, isRedisAvailable } from "../redis";

/**
 * One shared model-label catalog per machine (task #700): the daemon reports
 * each runtime's model list (id + the runtime's own label), this service keeps
 * it per machine, and every display surface resolves names from the same
 * copy. Redis-backed with an in-process fallback, mirroring the runtime
 * account usage cache.
 */
const CACHE_KEY_PREFIX = "slock:machine-runtime-model-catalog:v1";

/**
 * Field-per-runtime hash (key = machine): a write touches exactly one runtime
 * with HSET, so a frame on one replica and an upsert on another cannot lose
 * each other's runtime. No TTL on purpose (XX, #8634 review): a stable
 * connection reports once and never re-pushes, so an expiring entry would
 * silently drop the catalog. Fields persist until a report replaces them.
 */
export interface MachineRuntimeModelCatalogBackend {
  hGetAll(key: string): Promise<Record<string, string>>;
  hSet(key: string, field: string, value: string): Promise<void>;
}

const localHashes = new Map<string, Map<string, string>>();

const localBackend: MachineRuntimeModelCatalogBackend = {
  async hGetAll(key) {
    return Object.fromEntries(localHashes.get(key) ?? []);
  },
  async hSet(key, field, value) {
    const hash = localHashes.get(key) ?? new Map<string, string>();
    hash.set(field, value);
    localHashes.set(key, hash);
  },
};

const redisBackend: MachineRuntimeModelCatalogBackend = {
  async hGetAll(key) {
    return getRedis().hgetall(key);
  },
  async hSet(key, field, value) {
    await getRedis().hset(key, field, value);
  },
};

export function createMachineRuntimeModelCatalogRoutingBackend({
  isSharedAvailable,
  shared,
  local,
}: {
  isSharedAvailable: () => boolean;
  shared: MachineRuntimeModelCatalogBackend;
  local: MachineRuntimeModelCatalogBackend;
}): MachineRuntimeModelCatalogBackend {
  const current = () => (isSharedAvailable() ? shared : local);
  return {
    async hGetAll(key) {
      return current().hGetAll(key);
    },
    async hSet(key, field, value) {
      await current().hSet(key, field, value);
    },
  };
}

function defaultBackend(): MachineRuntimeModelCatalogBackend {
  return createMachineRuntimeModelCatalogRoutingBackend({
    isSharedAvailable: isRedisAvailable,
    shared: redisBackend,
    local: localBackend,
  });
}

function cacheKey(machineId: string): string {
  return `${CACHE_KEY_PREFIX}:${machineId}`;
}

/** Defensive re-validation of one stored runtime slice; bad slices are dropped. */
function parseStoredRuntimeSlice(raw: string): MachineRuntimeModelCatalog["runtimes"][string] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const models = safeParseRuntimeModelCatalogEntries(record.models);
  if (!models) return null;
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : "";
  return { models, updatedAt };
}

export class MachineRuntimeModelCatalogService {
  constructor(
    private readonly backend: MachineRuntimeModelCatalogBackend = defaultBackend(),
    private readonly now: () => number = currentTimeMs,
  ) {}

  async read(machineId: string): Promise<MachineRuntimeModelCatalog> {
    const raw = await this.backend.hGetAll(cacheKey(machineId));
    const catalog: MachineRuntimeModelCatalog = { runtimes: {} };
    for (const [runtime, value] of Object.entries(raw)) {
      const slice = parseStoredRuntimeSlice(value);
      if (slice) catalog.runtimes[runtime] = slice;
    }
    return catalog;
  }

  /** Whole-list replacement for one runtime (a single HSET, no read-modify-
   *  write); returns false when the report carried nothing valid, in which
   *  case the previous copy is kept. */
  async writeRuntime(machineId: string, runtime: string, models: unknown): Promise<boolean> {
    const runtimeId = runtime.trim();
    if (!runtimeId) return false;
    const parsed = safeParseRuntimeModelCatalogEntries(models);
    if (!parsed) return false;
    await this.backend.hSet(
      cacheKey(machineId),
      runtimeId,
      JSON.stringify({ models: parsed, updatedAt: new Date(this.now()).toISOString() }),
    );
    return true;
  }

  /**
   * The runtime has no models now (its own detection said so after a sign-in
   * change: Pi with no provider left). Its slice is replaced by an empty one,
   * which every read drops, so no surface offers the old models. A single
   * HSET like a write; no field delete is needed by the backends.
   */
  async clearRuntime(machineId: string, runtime: string): Promise<boolean> {
    const runtimeId = runtime.trim();
    if (!runtimeId) return false;
    await this.backend.hSet(cacheKey(machineId), runtimeId, JSON.stringify({ models: [], updatedAt: new Date(this.now()).toISOString() }));
    return true;
  }
}

export const machineRuntimeModelCatalogService = new MachineRuntimeModelCatalogService();

/**
 * One `machine:runtime_models:catalog` frame from a Computer. An empty list
 * clears the runtime's copy only when the daemon marks it authoritative and
 * the runtime signs in per provider (Pi: its last provider signed out from
 * the web, docs/contracts/runtime-auth.md §6b). Every other report is a
 * whole-list write, and an empty or malformed one keeps the previous copy.
 */
export async function applyRuntimeModelCatalogReport(
  service: Pick<MachineRuntimeModelCatalogService, "writeRuntime" | "clearRuntime">,
  machineId: string,
  report: { runtime: string; models: unknown; authoritative?: unknown },
): Promise<"written" | "cleared" | "kept"> {
  const runtime = typeof report.runtime === "string" ? report.runtime.trim() : "";
  if (
    report.authoritative === true
    && Array.isArray(report.models) && report.models.length === 0
    && isRuntimeAuthRuntime(runtime) && runtimeAuthSignsInPerProvider(runtime)
  ) {
    return (await service.clearRuntime(machineId, runtime)) ? "cleared" : "kept";
  }
  if (typeof report.runtime !== "string") return "kept";
  return (await service.writeRuntime(machineId, report.runtime, report.models)) ? "written" : "kept";
}

export function __clearMachineRuntimeModelCatalogLocalCacheForTests(): void {
  localHashes.clear();
}
