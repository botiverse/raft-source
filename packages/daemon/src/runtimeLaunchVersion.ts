import type { AgentConfig } from "@botiverse/raft-shared";
import type { RuntimeDriver, RuntimeLaunchVersionPolicy } from "./drivers/types.js";

type ComparableVersion = readonly [major: number, minor: number, patch: number];

export type RuntimeLaunchVersionDecision =
  | { outcome: "not_configured" }
  | { outcome: "compatible"; actualVersion: string; testedGoodVersion: string }
  | { outcome: "warn"; warning: string; reason: "below_tested_good" | "version_unavailable" | "version_unparseable" }
  | { outcome: "block"; error: RuntimeVersionTooOldError };

const VERSION_TRIPLE = /(?:^|[^0-9A-Za-z+.-])(\d+)\.(\d+)\.(\d+)(?=$|[^0-9A-Za-z+.-])/;

function parseComparableVersion(value: string): { normalized: string; parts: ComparableVersion } | null {
  const match = value.match(VERSION_TRIPLE);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return { normalized: parts.join("."), parts };
}

function compareVersions(left: ComparableVersion, right: ComparableVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export class RuntimeVersionTooOldError extends Error {
  readonly code = "runtime_version_too_old" as const;
  readonly runtimeId: string;
  readonly actualVersion: string;
  readonly testedGoodVersion: string;

  constructor(input: {
    runtimeId: string;
    displayName: string;
    actualVersion: string;
    testedGoodVersion: string;
  }) {
    super(
      `${input.displayName} CLI ${input.actualVersion} is known incompatible with this Raft runtime. `
      + `Update ${input.displayName} to the latest version before starting the agent; ${input.displayName} ${input.testedGoodVersion} is known to work.`,
    );
    this.name = "RuntimeVersionTooOldError";
    this.runtimeId = input.runtimeId;
    this.actualVersion = input.actualVersion;
    this.testedGoodVersion = input.testedGoodVersion;
  }
}

function evaluateConfiguredPolicy(
  runtimeId: string,
  policy: RuntimeLaunchVersionPolicy,
  config: AgentConfig,
  context: { workingDirectory: string },
): RuntimeLaunchVersionDecision {
  const testedGood = parseComparableVersion(policy.testedGoodVersion);
  if (!testedGood) {
    throw new Error(`Invalid tested-good runtime version policy for ${runtimeId}`);
  }

  const probe = policy.probe(config, context);
  if (!probe.available || !probe.version) {
    return {
      outcome: "warn",
      reason: "version_unavailable",
      warning: `Raft could not verify the ${policy.displayName} CLI version. `
        + `Update ${policy.displayName} to the latest version if startup fails; ${policy.displayName} ${testedGood.normalized} is known to work. Starting anyway.`,
    };
  }

  const actual = parseComparableVersion(probe.version);
  if (!actual) {
    return {
      outcome: "warn",
      reason: "version_unparseable",
      warning: `Raft could not compare the ${policy.displayName} CLI version. `
        + `Update ${policy.displayName} to the latest version if startup fails; ${policy.displayName} ${testedGood.normalized} is known to work. Starting anyway.`,
    };
  }

  const knownBad = new Set(policy.knownBadVersions.map((version) => {
    const parsed = parseComparableVersion(version);
    if (!parsed) throw new Error(`Invalid known-bad runtime version policy for ${runtimeId}`);
    return parsed.normalized;
  }));
  if (knownBad.has(actual.normalized)) {
    return {
      outcome: "block",
      error: new RuntimeVersionTooOldError({
        runtimeId,
        displayName: policy.displayName,
        actualVersion: actual.normalized,
        testedGoodVersion: testedGood.normalized,
      }),
    };
  }

  if (compareVersions(actual.parts, testedGood.parts) < 0) {
    return {
      outcome: "warn",
      reason: "below_tested_good",
      warning: `${policy.displayName} CLI ${actual.normalized} is older than a field-tested working version, ${testedGood.normalized}. `
        + `Update ${policy.displayName} to the latest version if messages fail; starting anyway because this version is not known incompatible.`,
    };
  }

  return {
    outcome: "compatible",
    actualVersion: actual.normalized,
    testedGoodVersion: testedGood.normalized,
  };
}

export function evaluateRuntimeLaunchVersion(
  driver: RuntimeDriver,
  config: AgentConfig,
  context: { workingDirectory: string },
): RuntimeLaunchVersionDecision {
  if (!driver.launchVersionPolicy) return { outcome: "not_configured" };
  return evaluateConfiguredPolicy(driver.id, driver.launchVersionPolicy, config, context);
}

export function enforceRuntimeLaunchVersion(
  driver: RuntimeDriver,
  config: AgentConfig,
  context: { workingDirectory: string },
  onWarning: (warning: string) => void,
): RuntimeLaunchVersionDecision {
  const decision = evaluateRuntimeLaunchVersion(driver, config, context);
  if (decision.outcome === "block") throw decision.error;
  if (decision.outcome === "warn") onWarning(decision.warning);
  return decision;
}
