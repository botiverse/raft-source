import type { ProviderQuotaObservation, ProviderQuotaRateLimitType } from "./drivers/types";

/**
 * Each agent's latest provider quota readings, so the daemon knows when a quota
 * is running low and not only when it has been hit (#wg-agent-migration:7746de27).
 *
 * The model:
 * - Quota belongs to the provider account, not the agent. It is keyed per
 *   agent because that is what the daemon can attribute a reading to.
 * - The top-level `status` of a reading is authoritative for refusal: a newer
 *   reading that is not `rejected` means requests go through, so it clears
 *   `exhausted` for every window.
 * - Warnings are kept per window (`rateLimitType`) until that window resets,
 *   because utilization only falls at a window's reset. An `allowed` reading
 *   for one window says nothing about another window's warning.
 * - An agent's quota is its most severe unexpired reading. A reading expires at
 *   its reported reset, or after 6h without one.
 */
export type ProviderQuotaLevel = "ok" | "warning" | "near_exhausted" | "exhausted";

/** A warning reading at or above this utilization is near exhausted. */
export const NEAR_EXHAUSTED_UTILIZATION = 0.9;
/** How long a reading without a reported reset counts. */
export const PROVIDER_QUOTA_READING_TTL_MS = 6 * 60 * 60 * 1000;
/** A reset further ahead than this is not believed (Claude Code's own bound); the TTL applies instead. */
export const PROVIDER_QUOTA_MAX_RESET_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

export interface ProviderQuotaReading {
  state: ProviderQuotaLevel;
  utilization?: number;
  rateLimitType?: ProviderQuotaRateLimitType;
  /** When the window resets, ISO 8601. */
  resetsAt?: string;
  observedAtMs: number;
}

type Entry = ProviderQuotaReading & { expiresAtMs: number };

const SEVERITY: Record<ProviderQuotaLevel, number> = { ok: 0, warning: 1, near_exhausted: 2, exhausted: 3 };
const UNSPECIFIED_TYPE = "unspecified";

export function providerQuotaLevel(observation: ProviderQuotaObservation): ProviderQuotaLevel {
  switch (observation.status) {
    case "allowed":
      return "ok";
    case "rejected":
      return "exhausted";
    case "allowed_warning": {
      // A passed threshold is a lower bound on utilization.
      const used = Math.max(observation.utilization ?? 0, observation.surpassedThreshold ?? 0);
      return used >= NEAR_EXHAUSTED_UTILIZATION ? "near_exhausted" : "warning";
    }
  }
}

/** ISO 8601 for a timestamp, or undefined when it is not one; never throws. */
function isoOrUndefined(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function moreSevere(a: Entry, b: Entry): boolean {
  if (SEVERITY[a.state] !== SEVERITY[b.state]) return SEVERITY[a.state] > SEVERITY[b.state];
  if ((a.utilization ?? -1) !== (b.utilization ?? -1)) return (a.utilization ?? -1) > (b.utilization ?? -1);
  return a.observedAtMs > b.observedAtMs;
}

export class ProviderQuotaState {
  private readonly readings = new Map<string, Map<string, Entry>>();
  private readonly now: () => number;
  private readonly recordEvent: (name: string, attrs: Record<string, string | number>) => void;

  constructor(opts: {
    now?: () => number;
    recordEvent?: (name: string, attrs: Record<string, string | number>) => void;
  } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.recordEvent = opts.recordEvent ?? (() => {});
  }

  observe(agentId: string, runtime: string, observation: ProviderQuotaObservation): void {
    const previous = this.reading(agentId);
    const observedAtMs = this.now();
    const state = providerQuotaLevel(observation);
    const typeKey = observation.rateLimitType ?? UNSPECIFIED_TYPE;
    let byType = this.readings.get(agentId);
    if (!byType) {
      byType = new Map();
      this.readings.set(agentId, byType);
    }
    if (state !== "exhausted") {
      for (const [key, entry] of byType) if (entry.state === "exhausted") byType.delete(key);
    }
    const resetsAtMs = observation.resetsAtMs;
    const resetsAt = resetsAtMs !== undefined
      && resetsAtMs > observedAtMs
      && resetsAtMs < observedAtMs + PROVIDER_QUOTA_MAX_RESET_AHEAD_MS
      ? isoOrUndefined(resetsAtMs)
      : undefined;
    byType.set(typeKey, {
      state,
      ...(observation.utilization !== undefined ? { utilization: observation.utilization } : {}),
      ...(observation.rateLimitType ? { rateLimitType: observation.rateLimitType } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      observedAtMs,
      // A reset already past: that window has reset, so the reading is expired at once.
      expiresAtMs: resetsAtMs !== undefined && resetsAtMs > 0 && resetsAtMs <= observedAtMs
        ? observedAtMs
        : resetsAt !== undefined && resetsAtMs !== undefined ? resetsAtMs : observedAtMs + PROVIDER_QUOTA_READING_TTL_MS,
    });
    const current = this.reading(agentId);
    const currentState = current?.state ?? "none";
    const previousState = previous?.state ?? "none";
    if (currentState === previousState) return;
    this.recordEvent("daemon.provider_quota.changed", {
      agent_id: agentId,
      runtime,
      state: currentState,
      previous_state: previousState,
      ...(current?.utilization !== undefined ? { utilization: Math.round(current.utilization * 100) / 100 } : {}),
      ...(current?.rateLimitType ? { rate_limit_type: current.rateLimitType } : {}),
    });
  }

  /** The agent's most severe unexpired reading. */
  reading(agentId: string): ProviderQuotaReading | undefined {
    const byType = this.readings.get(agentId);
    if (!byType) return undefined;
    const nowMs = this.now();
    let worst: Entry | undefined;
    for (const [key, entry] of byType) {
      if (entry.expiresAtMs <= nowMs) {
        byType.delete(key);
        continue;
      }
      if (!worst || moreSevere(entry, worst)) worst = entry;
    }
    if (byType.size === 0) this.readings.delete(agentId);
    if (!worst) return undefined;
    const { expiresAtMs: _expiresAtMs, ...reading } = worst;
    return reading;
  }

  /** Drop an agent's readings (its workspace was deleted). */
  forget(agentId: string): void {
    this.readings.delete(agentId);
  }

  /** The shape the stale-agent cleaner reads as `providerQuota(ownerAgentId)` (PR #14004). */
  quotaFor(agentId: string): { state: ProviderQuotaLevel; utilization?: number } | undefined {
    const reading = this.reading(agentId);
    if (!reading) return undefined;
    return reading.utilization !== undefined ? { state: reading.state, utilization: reading.utilization } : { state: reading.state };
  }
}
