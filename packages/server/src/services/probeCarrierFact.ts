// Pure helpers for the cross-replica probe carrier fact (task #32).
// Extracted from AgentOrchestrator so the owning seam has regression guards
// without constructing the orchestrator: freshness, capability presence and
// runtime-version projection are exactly the axes previous review rounds
// found unguarded.

export interface ProbeCarrierMetaInput {
  probeCapabilities?: string | null;
  probeConnectionEpochId?: string | null;
  probeReplicaGeneration?: string | null;
  probeObservedAt?: string | null;
  probeRuntimeVersions?: string | null;
  runtimeVersions?: string | null;
  daemonVersion?: string | null;
  computerVersion?: string | null;
}

export interface ProbeCarrierMetaSnapshot {
  capabilities: string[];
  connectionEpochId: string;
  replicaGeneration: string;
  daemonVersion: string | null;
  computerVersion: string | null;
  runtimeVersions: Record<string, string>;
  observedAtMs: number;
}

export const PROBE_CARRIER_FACT_MAX_AGE_MS = 90_000;

export function parseProbeCarrierMeta(meta: ProbeCarrierMetaInput): ProbeCarrierMetaSnapshot | null {
  if (!meta.probeConnectionEpochId || !meta.probeReplicaGeneration) return null;
  const observedAtMs = meta.probeObservedAt ? Date.parse(meta.probeObservedAt) : Number.NaN;
  if (!Number.isFinite(observedAtMs)) return null;
  let capabilities: string[] = [];
  try {
    const parsed = JSON.parse(meta.probeCapabilities ?? "[]");
    if (Array.isArray(parsed)) {
      capabilities = parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    capabilities = [];
  }
  let runtimeVersions: Record<string, string> = {};
  try {
    const parsed = JSON.parse(meta.probeRuntimeVersions ?? meta.runtimeVersions ?? "{}");
    if (parsed && typeof parsed === "object") {
      for (const [runtime, version] of Object.entries(parsed)) {
        if (typeof version === "string") runtimeVersions[runtime] = version;
      }
    }
  } catch {
    runtimeVersions = {};
  }
  return {
    capabilities,
    connectionEpochId: meta.probeConnectionEpochId,
    replicaGeneration: meta.probeReplicaGeneration,
    daemonVersion: meta.daemonVersion ?? null,
    computerVersion: meta.computerVersion ?? null,
    runtimeVersions,
    observedAtMs,
  };
}

/**
 * A fact is live only inside [0, maxAge]: a negative age means the owner's
 * clock is ahead (or the meta was forged) and must not authorize a dispatch.
 */
export function isProbeCarrierFactLive(
  snapshot: ProbeCarrierMetaSnapshot,
  nowMs: number,
  maxAgeMs: number = PROBE_CARRIER_FACT_MAX_AGE_MS,
): boolean {
  const age = nowMs - snapshot.observedAtMs;
  return age >= 0 && age <= maxAgeMs;
}
