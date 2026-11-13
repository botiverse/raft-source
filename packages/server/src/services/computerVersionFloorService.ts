import {
  COMPUTER_VERSION_ENFORCEMENT_FEATURE_FLAG_KEY,
  evaluateComputerVersionGate,
  isComputerSemver,
  type ComputerVersionFloorPolicy,
  type ComputerVersionGate,
} from "@botiverse/raft-shared";
import { evaluateFeatureFlag } from "./featureFlagService";

/**
 * Minimum supported Computer version (shared `evaluateComputerVersionGate`).
 * The floor and its deadline are production config, set per deploy:
 *   COMPUTER_MIN_SUPPORTED_VERSION   e.g. "1.0.47"; unset → no gate at all
 *   COMPUTER_MIN_VERSION_ENFORCE_AT  ISO time; unset → hint only, never enforced
 * The `computer_version_enforcement` flag is the emergency stop: enforcement
 * also needs it on for the Computer's own server, so switching it off lifts
 * every quarantine within a minute without a deploy, and allow rules can roll
 * enforcement out server by server. A missing flag counts as off (fail-safe).
 * The flag is server-scoped: evaluated without a server it is always off.
 */
export function readComputerVersionFloorEnv(env: NodeJS.ProcessEnv = process.env): { minVersion: string; enforceAt: string | null } | null {
  const minVersion = env.COMPUTER_MIN_SUPPORTED_VERSION?.trim();
  if (!minVersion || !isComputerSemver(minVersion)) return null;
  const enforceAtMs = Date.parse(env.COMPUTER_MIN_VERSION_ENFORCE_AT?.trim() ?? "");
  return { minVersion, enforceAt: Number.isFinite(enforceAtMs) ? new Date(enforceAtMs).toISOString() : null };
}

const ENFORCEMENT_FLAG_CACHE_MS = 60_000;

export class ComputerVersionFloor {
  private readonly flags = new Map<string, { enabled: boolean; readAtMs: number }>();

  constructor(
    private readonly readEnv: () => { minVersion: string; enforceAt: string | null } | null = () => readComputerVersionFloorEnv(),
    private readonly readEnforcementFlag: (serverId: string) => Promise<boolean> = async (serverId) =>
      (await evaluateFeatureFlag({ key: COMPUTER_VERSION_ENFORCEMENT_FEATURE_FLAG_KEY, serverId })).enabled,
  ) {}

  /**
   * The policy for Computers of one server now, or null when no floor is
   * configured. Reads the flag only once the deadline has passed.
   */
  async policy(nowMs: number, serverId: string): Promise<ComputerVersionFloorPolicy | null> {
    const env = this.readEnv();
    if (!env) return null;
    const due = env.enforceAt !== null && nowMs >= Date.parse(env.enforceAt);
    return { ...env, enforcementEnabled: due ? await this.enforcementEnabled(nowMs, serverId) : false };
  }

  /** Cheap pre-check: a floor is configured and its deadline has passed (the flag is not read). */
  enforcementDue(nowMs: number): boolean {
    const env = this.readEnv();
    return env !== null && env.enforceAt !== null && nowMs >= Date.parse(env.enforceAt);
  }

  async gate(version: string | null | undefined, nowMs: number, serverId: string): Promise<ComputerVersionGate | null> {
    return evaluateComputerVersionGate(version, await this.policy(nowMs, serverId), nowMs);
  }

  private async enforcementEnabled(nowMs: number, serverId: string): Promise<boolean> {
    const cached = this.flags.get(serverId);
    if (cached && nowMs - cached.readAtMs < ENFORCEMENT_FLAG_CACHE_MS) return cached.enabled;
    let enabled: boolean;
    try {
      enabled = await this.readEnforcementFlag(serverId);
    } catch {
      // Unreadable flag: keep the last answer, and never start enforcing on a guess.
      enabled = cached?.enabled ?? false;
    }
    this.flags.set(serverId, { enabled, readAtMs: nowMs });
    return enabled;
  }
}

/** The process-wide floor: the orchestrator's gates and the list projections read the same flag cache. */
export const computerVersionFloor = new ComputerVersionFloor();
