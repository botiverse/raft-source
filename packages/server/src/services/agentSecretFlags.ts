/**
 * Global FFA feature-flag gates for `#proj-runtime:#79` staged rollout:
 *   1. `agent_secret_encryption_write_v1`: default OFF; flipped on after the
 *      decrypt-capable release passes its rollback window, before running the
 *      backfill script.
 *   2. `replica_seal_agent_config_v1`: default OFF; flipped on (`seal`, then
 *      `strict` via `defaultVariant` after waiting >30s cache TTL) once all
 *      replicas can open sealed `agent:start` / `agent:config` frames across Redis.
 *
 * Kept separate from `agentSecretCrypto.ts` and `runtimeAuthReplicaSeal.ts` so
 * those pure crypto modules stay DB-free for fast unit tests and CLI scripts.
 */
import { isDatabaseInitialized } from "../db";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import {
  FLAG_READ_CACHE_TTL_MS,
  onCachedFlagForgotten,
} from "./featureFlagReadCache";
import {
  AGENT_SECRET_ENCRYPTION_WRITE_FEATURE_FLAG_KEY,
  REPLICA_SEAL_AGENT_CONFIG_FEATURE_FLAG_KEY,
  evaluateFeatureFlag,
} from "./featureFlagService";
import type { AgentConfigHopSealMode } from "./runtimeAuthReplicaSeal";

type FlagExecutor = Parameters<typeof evaluateFeatureFlag>[1];
type ReplicaSealModeFetcher = () => Promise<{ enabled: boolean; variant: string | null }>;

/** Valid sentinel UUID so global `randomizationUnit: "server"` flags satisfy unit checks. */
export const GLOBAL_FEATURE_FLAG_SERVER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Whether DB writes to `agents.runtime_config` and `agents.env_vars` should
 * seal secrets at rest. Evaluated directly against `executor` (usually the
 * write's own transaction) so flipping the flag takes effect immediately.
 */
export async function isAgentSecretWriteEncryptionEnabled(
  serverId?: string | null,
  executor?: FlagExecutor,
): Promise<boolean> {
  if (!executor && !isDatabaseInitialized()) return false;
  const evaluation = await evaluateFeatureFlag(
    {
      key: AGENT_SECRET_ENCRYPTION_WRITE_FEATURE_FLAG_KEY,
      serverId: serverId ?? GLOBAL_FEATURE_FLAG_SERVER_ID,
    },
    executor,
  );
  return evaluation.enabled === true;
}

function modeFromGlobalFlagAnswer(answer: { enabled: boolean; variant: string | null }): AgentConfigHopSealMode {
  if (!answer.enabled) return "receive_only";
  return answer.variant?.trim().toLowerCase() === "strict" ? "strict" : "seal";
}

let replicaSealModeOverrideForTests: AgentConfigHopSealMode | null = null;
let replicaSealModeFetcherForTests: ReplicaSealModeFetcher | null = null;
let currentReplicaSealMode: AgentConfigHopSealMode = "receive_only";
let replicaSealModeExpiresAtMs = 0;
let replicaSealModeRefreshInFlight: Promise<AgentConfigHopSealMode> | null = null;
let replicaSealModeGeneration = 0;
let replicaSealModeTimer: ReturnType<typeof setInterval> | null = null;
let stopFlagInvalidationSubscription: (() => void) | null = null;

/** Test-only override for DB-less unit suites (e.g. `agentOrchestrator.deterministic.test.ts`). */
export function __setReplicaAgentConfigSealModeForTests(mode: AgentConfigHopSealMode | null): void {
  replicaSealModeOverrideForTests = mode;
}

/** Test-only fetcher injection & state reset for ordering / cache-expiry tests. */
export function __resetReplicaAgentConfigSealModeCacheForTests(options: {
  fetcher?: ReplicaSealModeFetcher | null;
  initialMode?: AgentConfigHopSealMode;
  expiresAtMs?: number;
} = {}): void {
  replicaSealModeGeneration++;
  replicaSealModeFetcherForTests = options.fetcher ?? null;
  currentReplicaSealMode = options.initialMode ?? "receive_only";
  replicaSealModeExpiresAtMs = options.expiresAtMs ?? 0;
  replicaSealModeRefreshInFlight = null;
}

async function fetchReplicaSealModeFromSource(): Promise<{ enabled: boolean; variant: string | null }> {
  if (replicaSealModeFetcherForTests) return replicaSealModeFetcherForTests();
  const evaluation = await evaluateFeatureFlag({
    key: REPLICA_SEAL_AGENT_CONFIG_FEATURE_FLAG_KEY,
    serverId: GLOBAL_FEATURE_FLAG_SERVER_ID,
  });
  return { enabled: evaluation.enabled === true, variant: evaluation.variant ?? null };
}

/**
 * Refreshes the cached `replica_seal_agent_config_v1` mode in the background
 * (deduplicated). Never called with `await` on cross-replica frame send/receive
 * paths so frame ordering is never perturbed by a DB read.
 */
export function refreshReplicaAgentConfigSealMode(): Promise<AgentConfigHopSealMode> {
  if (replicaSealModeOverrideForTests !== null) {
    return Promise.resolve(replicaSealModeOverrideForTests);
  }
  if (!replicaSealModeFetcherForTests && !isDatabaseInitialized()) {
    return Promise.resolve("receive_only");
  }
  if (replicaSealModeRefreshInFlight) return replicaSealModeRefreshInFlight;
  const startedGeneration = replicaSealModeGeneration;
  const run = fetchReplicaSealModeFromSource()
    .then((answer) => {
      const next = modeFromGlobalFlagAnswer(answer);
      if (replicaSealModeGeneration === startedGeneration) {
        currentReplicaSealMode = next;
        replicaSealModeExpiresAtMs = Date.now() + FLAG_READ_CACHE_TTL_MS;
      }
      return next;
    })
    .catch((err) => {
      console.warn(
        "[replicaAuthSeal] Failed to refresh replica_seal_agent_config_v1 flag; keeping last known mode:",
        serializeErrorForLog(err),
      );
      if (replicaSealModeGeneration === startedGeneration) {
        // Retry on the next refresh window rather than hot-looping DB queries on outage.
        replicaSealModeExpiresAtMs = Date.now() + FLAG_READ_CACHE_TTL_MS;
      }
      return currentReplicaSealMode;
    })
    .finally(() => {
      if (replicaSealModeRefreshInFlight === run) {
        replicaSealModeRefreshInFlight = null;
      }
    });
  replicaSealModeRefreshInFlight = run;
  return run;
}

/**
 * Synchronous, non-yielding read of the cross-replica sealing mode for
 * `agent:start` and `agent:config` frames.
 *
 * Never yields the event loop: before the first background refresh completes,
 * returns `"receive_only"`. When the TTL has elapsed (or after an FFA change
 * invalidation), returns the last known mode immediately and triggers a
 * deduplicated background refresh so in-flight frames for the same machine or
 * agent never reorder behind a DB query.
 */
export function getReplicaAgentConfigSealModeSync(): AgentConfigHopSealMode {
  if (replicaSealModeOverrideForTests !== null) return replicaSealModeOverrideForTests;
  if (!replicaSealModeFetcherForTests && !isDatabaseInitialized()) return "receive_only";
  if (Date.now() >= replicaSealModeExpiresAtMs) {
    void refreshReplicaAgentConfigSealMode();
  }
  return currentReplicaSealMode;
}

/**
 * Starts background periodic refresh + FFA change-notifier invalidation for
 * `replica_seal_agent_config_v1`. Returns a cleanup function for graceful shutdown.
 */
export function startReplicaAgentConfigSealModeSync(intervalMs: number = FLAG_READ_CACHE_TTL_MS): () => void {
  stopReplicaAgentConfigSealModeSync();
  if (Date.now() >= replicaSealModeExpiresAtMs) {
    void refreshReplicaAgentConfigSealMode();
  }
  stopFlagInvalidationSubscription = onCachedFlagForgotten(
    REPLICA_SEAL_AGENT_CONFIG_FEATURE_FLAG_KEY,
    () => {
      replicaSealModeExpiresAtMs = 0;
      void refreshReplicaAgentConfigSealMode();
    },
  );
  if (intervalMs > 0) {
    replicaSealModeTimer = setInterval(() => {
      void refreshReplicaAgentConfigSealMode();
    }, intervalMs);
    replicaSealModeTimer.unref?.();
  }
  return stopReplicaAgentConfigSealModeSync;
}

export function stopReplicaAgentConfigSealModeSync(): void {
  if (replicaSealModeTimer) {
    clearInterval(replicaSealModeTimer);
    replicaSealModeTimer = null;
  }
  if (stopFlagInvalidationSubscription) {
    stopFlagInvalidationSubscription();
    stopFlagInvalidationSubscription = null;
  }
}
