/**
 * App-owned Cleaner catalog definition retained by the generic Registry and
 * App-config surfaces.
 *
 * DAG position: this file sits directly above the shared spec and imports
 * NOTHING else at runtime — no DB service, no transport, no dynamic import.
 * Composition (reading durable config, projecting, pushing) belongs to the
 * generic transport service above the manifest catalog. Keeping this file pure
 * is what makes the catalog importable without pulling in the config service.
 *
 * Capability shape (#204, 01:00Z freeze):
 *   - `notifications` declares CLASS IDENTITY only — `memory_size_hint` stays.
 *   - `syscalls` declares Server DELIVERY AUTHORITY, and Cleaner has none:
 *     `notify`, `readOwnState`, and `writeOwnState` are all deleted. Cleaner
 *     notifications are minted Computer-local and transient by #203.
 *   - `hooks` stays empty: no onDue, no timer, no delivery.
 *
 * The config schema is not written here; it is consumed from the canonical
 * shared spec so the manifest and the wire cannot disagree.
 */

import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_CANONICAL,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol.js";

import type { AppId } from "../../services/rapRegistry.js";
import type { BuiltInRapAppDefinition } from "../../services/rapBuiltinAppManifests.js";

import { projectCleanerConfigToWire } from "./configProjector.js";

export const BUILT_IN_MEMORY_HINT_EVENT_KIND = "memory_size_hint" as const;

export const BUILT_IN_MEMORY_CLEANER_APP = {
  appId: CLEANER_APP_ID as AppId,
  composerReference: { displayName: "Memory Cleaner" },
  manifest: {
    app_id: CLEANER_APP_ID as AppId,
    hooks: [],
    syscalls: [],
    notifications: [BUILT_IN_MEMORY_HINT_EVENT_KIND],
    config: {
      enabled: {
        type: "boolean",
        default: CLEANER_CONFIG_CANONICAL.enabled.default,
      },
      threshold_bytes: {
        type: "integer",
        default: CLEANER_CONFIG_CANONICAL.thresholdBytes.default,
        minimum: CLEANER_CONFIG_CANONICAL.thresholdBytes.min,
        maximum: CLEANER_CONFIG_CANONICAL.thresholdBytes.max,
      },
      interval_seconds: {
        type: "integer",
        default: CLEANER_CONFIG_CANONICAL.intervalSeconds.default,
        minimum: CLEANER_CONFIG_CANONICAL.intervalSeconds.min,
        maximum: CLEANER_CONFIG_CANONICAL.intervalSeconds.max,
      },
    },
  },
  grant: "all_server_agents",
} as const satisfies BuiltInRapAppDefinition;

/**
 * This app's config-projector registry entry, assembled here so the OS-layer
 * catalog can list it without naming the product app at all — it imports this
 * one binding and spreads it, adding no declared-name occurrence.
 */
export const BUILT_IN_SIZE_MONITOR_CONFIG_PROJECTOR = {
  appId: CLEANER_APP_ID as AppId,
  project: projectCleanerConfigToWire,
} as const;
