import {
  clearClockTimeout,
  currentTimeMs,
  setClockTimeout,
  type RuntimeModelInfo,
  type RuntimeModelSet,
  type RuntimeModelSourceOutcome,
  type SkillInfo,
} from "@botiverse/raft-shared";
import { z } from "zod";

import { getRedis, isRedisAvailable } from "../redis";
import { RouteFailureError } from "../tracing/routeFailure";

/**
 * Read-only Computer probes behind a slow Computer (runtime models, the
 * runtime-form option sources derived from them, and an agent's skills).
 *
 * The front replica replays these reads to the replica that owns the
 * Computer's socket and gives up after 8s (machineLocalReplay
 * REPLAY_TIMEOUT_MS). The owner therefore answers within
 * COMPUTER_PROBE_WAIT_MS: the Computer's answer when it arrives in time,
 * otherwise the last good answer (`stale`) or `unavailable`. The Computer
 * request itself is not cancelled; it keeps its own budget (20s models, 15s
 * skills) and a late good answer lands in the cache, so the next open gets it.
 * A fresh answer always rewrites the cache.
 *
 * The cache is shared across replicas (Redis, with an in-process fallback like
 * runtimeAccountUsageCacheService), so a front replica whose replay failed can
 * answer from it too. Failures are never cached; records are validated on read.
 */
export const COMPUTER_PROBE_CACHE_TTL_SECONDS = 10 * 60;
/** Must stay below the replay timeout (8s), so the owner's answer reaches the front replica. */
export const COMPUTER_PROBE_WAIT_MS = 6_000;
const CACHE_KEY_PREFIX = "slock:computer-probe-cache:v1";

export type ComputerProbeState = "ok" | "stale" | "unavailable";

/**
 * ok: the Computer answered this request (any outcome). stale: it did not
 * answer in time; `value` is its last good answer, received at `fetchedAt`.
 * unavailable: it did not answer in time and there is no earlier answer.
 */
export type ComputerProbeAnswer<T> =
  | { state: "ok"; value: T }
  | { state: "stale"; value: T; fetchedAt: string }
  | { state: "unavailable" };

/** An answer's state without its value: what a response and a trace report. */
export type ComputerProbeFreshness =
  | { state: "ok" }
  | { state: "stale"; fetchedAt: string }
  | { state: "unavailable" };

export function computerProbeFreshness<T>(answer: ComputerProbeAnswer<T>): ComputerProbeFreshness {
  return answer.state === "stale" ? { state: "stale", fetchedAt: answer.fetchedAt } : { state: answer.state };
}

export interface AgentSkillsList {
  global: SkillInfo[];
  workspace: SkillInfo[];
}

/**
 * Whose skills: a list belongs to the agent on one Computer with one runtime,
 * so a move or a runtime change never serves the old list. No Computer
 * (`machineId` null): nothing is cached.
 */
export interface AgentSkillsProbeTarget {
  machineId: string | null;
  runtime: string;
  agentId: string;
}

export interface ComputerProbeCacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface ComputerProbeClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: ComputerProbeClock = {
  now: currentTimeMs,
  setTimeout: setClockTimeout,
  clearTimeout: clearClockTimeout,
};

type LocalEntry = { value: string; expiresAtMs: number };
const localEntries = new Map<string, LocalEntry>();

export function createLocalComputerProbeCacheBackend(
  now: () => number = currentTimeMs,
  entries: Map<string, LocalEntry> = localEntries,
): ComputerProbeCacheBackend {
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      entries.set(key, { value, expiresAtMs: now() + ttlSeconds * 1_000 });
    },
  };
}

/** The Redis commands this cache uses; `getRedis()` in production. */
export interface ComputerProbeRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

export function createRedisComputerProbeCacheBackend(
  client: () => ComputerProbeRedisClient = getRedis,
): ComputerProbeCacheBackend {
  return {
    async get(key) {
      return client().get(key);
    },
    async set(key, value, ttlSeconds) {
      await client().set(key, value, "EX", ttlSeconds);
    },
  };
}

export function createComputerProbeRoutingBackend({
  isSharedAvailable,
  shared,
  local,
}: {
  isSharedAvailable: () => boolean;
  shared: ComputerProbeCacheBackend;
  local: ComputerProbeCacheBackend;
}): ComputerProbeCacheBackend {
  const current = () => (isSharedAvailable() ? shared : local);
  return {
    async get(key) {
      return current().get(key);
    },
    async set(key, value, ttlSeconds) {
      await current().set(key, value, ttlSeconds);
    },
  };
}

function defaultBackend(): ComputerProbeCacheBackend {
  return createComputerProbeRoutingBackend({
    isSharedAvailable: isRedisAvailable,
    shared: createRedisComputerProbeCacheBackend(),
    local: createLocalComputerProbeCacheBackend(),
  });
}

// ---- Cache records (validated on read: the cache is a boundary).

const runtimeModelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  supportedReasoningEfforts: z.array(z.string()).optional(),
  defaultReasoningEffort: z.string().optional(),
  serviceTiers: z.array(z.string()).optional(),
  defaultServiceTier: z.string().optional(),
  verified: z.enum(["launchable", "suggestion_only"]).optional(),
});

const runtimeModelSetSchema = z.object({
  models: z.array(runtimeModelInfoSchema).min(1),
  default: z.string().optional(),
  catalog: z.object({
    protocolVersion: z.literal(1),
    runtime: z.literal("builtin"),
    runtimeVersion: z.string().min(1),
    customModelProviderIds: z.array(z.string()).optional(),
  }).optional(),
  // Disabled models stay in their own list, never in `models` (older clients offer every model).
  unavailable: z.array(z.object({ id: z.string().min(1), label: z.string(), reason: z.string() })).optional(),
});

/** Only a live list with models is cached: every other outcome is a failure or says there is nothing to list. */
const cachedModelsOutcomeSchema = z.object({
  kind: z.literal("live"),
  value: runtimeModelSetSchema,
});

const skillInfoSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  userInvocable: z.boolean(),
  sourcePath: z.string().optional(),
});

const cachedSkillsSchema = z.object({
  global: z.array(skillInfoSchema),
  workspace: z.array(skillInfoSchema),
});

// The record schemas are the shared types exactly: a field added to one side
// only fails the build instead of being dropped from (or trusted into) the cache.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
true satisfies Same<z.infer<typeof runtimeModelInfoSchema>, RuntimeModelInfo>;
true satisfies Same<z.infer<typeof runtimeModelSetSchema>, RuntimeModelSet>;
true satisfies Same<z.infer<typeof skillInfoSchema>, SkillInfo>;
true satisfies Same<z.infer<typeof cachedSkillsSchema>, AgentSkillsList>;

const fetchedAtSchema = z.iso.datetime({ offset: true });

interface ProbeSlot<T> {
  /** null: never cached (read as no earlier answer, never written). */
  key: string | null;
  /** Validates a value for the cache; null when it must not be cached. */
  cacheable(value: T): T | null;
  parse(value: unknown): T | null;
}

function modelsSlot(machineId: string, runtime: string): ProbeSlot<RuntimeModelSourceOutcome> {
  const parse = (value: unknown): RuntimeModelSourceOutcome | null => {
    const parsed = cachedModelsOutcomeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
  return { key: `${CACHE_KEY_PREFIX}:models:${machineId}:${runtime}`, cacheable: parse, parse };
}

function skillsSlot({ machineId, runtime, agentId }: AgentSkillsProbeTarget): ProbeSlot<AgentSkillsList> {
  const parse = (value: unknown): AgentSkillsList | null => {
    const parsed = cachedSkillsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
  return {
    key: machineId === null ? null : `${CACHE_KEY_PREFIX}:skills:${machineId}:${runtime}:${agentId}`,
    cacheable: parse,
    parse,
  };
}

function isComputerWaitTimeout(error: unknown): boolean {
  return error instanceof RouteFailureError && error.subkind === "daemon_timeout";
}

export class ComputerProbeCacheService {
  private readonly waitMs: number;
  private readonly clock: ComputerProbeClock;

  constructor(
    private readonly backend: ComputerProbeCacheBackend = defaultBackend(),
    options: { waitMs?: number; clock?: ComputerProbeClock } = {},
  ) {
    this.waitMs = options.waitMs ?? COMPUTER_PROBE_WAIT_MS;
    this.clock = options.clock ?? systemClock;
  }

  /** Ask the Computer for a runtime's models, answering within the wait budget. */
  probeModels(
    machineId: string,
    runtime: string,
    request: () => Promise<RuntimeModelSourceOutcome>,
  ): Promise<ComputerProbeAnswer<RuntimeModelSourceOutcome>> {
    return this.probe(modelsSlot(machineId, runtime), request);
  }

  /** The last good model list without asking the Computer (a failed replay). */
  cachedModels(machineId: string, runtime: string): Promise<ComputerProbeAnswer<RuntimeModelSourceOutcome>> {
    return this.cached(modelsSlot(machineId, runtime));
  }

  probeSkills(
    target: AgentSkillsProbeTarget,
    request: () => Promise<AgentSkillsList>,
  ): Promise<ComputerProbeAnswer<AgentSkillsList>> {
    return this.probe(skillsSlot(target), request);
  }

  cachedSkills(target: AgentSkillsProbeTarget): Promise<ComputerProbeAnswer<AgentSkillsList>> {
    return this.cached(skillsSlot(target));
  }

  /**
   * The Computer's answer when it arrives within the wait budget; otherwise the
   * cache. A thrown failure other than a timeout is the caller's (offline,
   * server errors). The request keeps running past the budget, and whenever it
   * succeeds the cache is rewritten.
   */
  private async probe<T>(slot: ProbeSlot<T>, request: () => Promise<T>): Promise<ComputerProbeAnswer<T>> {
    const pending = request();
    const written = pending.then((value) => this.write(slot, value), () => undefined);
    const settled = await new Promise<{ kind: "answered"; value: T } | { kind: "waited" }>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => resolve({ kind: "waited" }), this.waitMs);
      pending.then(
        (value) => {
          this.clock.clearTimeout(timer);
          resolve({ kind: "answered", value });
        },
        (error: unknown) => {
          this.clock.clearTimeout(timer);
          if (isComputerWaitTimeout(error)) resolve({ kind: "waited" });
          else reject(error);
        },
      );
    });
    if (settled.kind === "waited") return this.cached(slot);
    // The answer is served either way; waiting for the write only keeps a
    // follow-up read on this replica from missing it.
    await written;
    return { state: "ok", value: settled.value };
  }

  private async cached<T>(slot: ProbeSlot<T>): Promise<ComputerProbeAnswer<T>> {
    if (slot.key === null) return { state: "unavailable" };
    let raw: string | null;
    try {
      raw = await this.backend.get(slot.key);
    } catch {
      // The cache is a fallback: an unreachable one means no earlier answer.
      return { state: "unavailable" };
    }
    if (!raw) return { state: "unavailable" };
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      return { state: "unavailable" };
    }
    const fetchedAt = record && typeof record === "object" && "fetchedAt" in record
      ? fetchedAtSchema.safeParse(record.fetchedAt)
      : null;
    const value = record && typeof record === "object" && "value" in record ? slot.parse(record.value) : null;
    if (!fetchedAt?.success || value === null) return { state: "unavailable" };
    return { state: "stale", value, fetchedAt: fetchedAt.data };
  }

  private async write<T>(slot: ProbeSlot<T>, answer: T): Promise<void> {
    const value = slot.cacheable(answer);
    if (value === null || slot.key === null) return;
    const record = { fetchedAt: new Date(this.clock.now()).toISOString(), value };
    try {
      await this.backend.set(slot.key, JSON.stringify(record), COMPUTER_PROBE_CACHE_TTL_SECONDS);
    } catch {
      // A failed write only costs the next slow open its stale fallback.
    }
  }
}

export const computerProbeCacheService = new ComputerProbeCacheService();

/**
 * The probe cache a route uses: the app's (`app.set("computerProbeCache", ...)`,
 * the test seam for the wait budget and clock), else the process-wide one.
 */
export function computerProbeCacheFor(app: { get(name: string): unknown }): ComputerProbeCacheService {
  const configured = app.get("computerProbeCache");
  return configured instanceof ComputerProbeCacheService ? configured : computerProbeCacheService;
}
