/**
 * Pure Cleaner config projector (task #204).
 *
 * App-owned path, so the product app name is legal here.
 *
 * DAG position: imports ONLY the shared spec. No DB service, no manifest
 * catalog, no orchestrator. It receives an already-read `{ownerAgentId,
 * revision, effective}` and returns the wire envelope — nothing else. That is
 * what lets the manifest catalog re-export it without dragging the config
 * service into every importer of the catalog.
 *
 * This is also the ONE place the unit boundary is crossed: the manifest and the
 * durable store speak the product's units (`threshold_bytes`,
 * `interval_seconds`), the Computer wire speaks camelCase milliseconds.
 */

import {
  validateAppConfigWithinBounds,
  type AppConfigWireSnapshot,
} from "@botiverse/raft-shared/src/appConfigTransport.js";
import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_BOUNDS,
  CLEANER_STORE_KEYS,
  SECONDS_TO_MS,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol.js";

export type StoredConfigValue = boolean | number;

export class CleanerConfigRangeError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Cleaner config out of declared bounds: ${errors.join("; ")}`);
    this.name = "CleanerConfigRangeError";
  }
}

function requireBoolean(value: StoredConfigValue | undefined, key: string): boolean {
  if (typeof value !== "boolean") {
    throw new CleanerConfigRangeError([`${key}: expected boolean, got ${typeof value}`]);
  }
  return value;
}

function requireInteger(value: StoredConfigValue | undefined, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CleanerConfigRangeError([`${key}: expected integer, got ${typeof value}`]);
  }
  return value;
}

/**
 * Project a durable config snapshot onto the Computer wire envelope.
 *
 * Out-of-range values are REJECTED, not clamped: a stored or operator-supplied
 * value silently snapping to a limit would hide a real misconfiguration.
 */
export function projectCleanerConfigToWire(input: {
  ownerAgentId: string;
  revision: number;
  effective: Record<string, StoredConfigValue>;
}): AppConfigWireSnapshot {
  const { effective } = input;
  const wire = {
    enabled: requireBoolean(effective[CLEANER_STORE_KEYS.enabled], CLEANER_STORE_KEYS.enabled),
    thresholdBytes: requireInteger(
      effective[CLEANER_STORE_KEYS.thresholdBytes],
      CLEANER_STORE_KEYS.thresholdBytes,
    ),
    intervalMs:
      requireInteger(effective[CLEANER_STORE_KEYS.intervalMs], CLEANER_STORE_KEYS.intervalMs) *
      SECONDS_TO_MS,
  };

  const check = validateAppConfigWithinBounds(wire, CLEANER_CONFIG_BOUNDS);
  if (!check.ok) throw new CleanerConfigRangeError(check.errors);

  return {
    appId: CLEANER_APP_ID,
    ownerAgentId: input.ownerAgentId,
    revision: input.revision,
    effective: wire,
  };
}
