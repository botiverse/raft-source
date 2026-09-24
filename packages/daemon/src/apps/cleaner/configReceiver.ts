import type { ServerToMachineMessage } from "@botiverse/raft-shared";
import {
  appConfigTraceAttrs,
  appSnapshotTraceAttrs,
  type AppRuntimeTraceAttrs,
} from "@botiverse/raft-shared/src/appRuntimeTrace.js";
import {
  normalizeAppConfigWireSnapshot,
  type AppConfigWireSnapshot,
} from "@botiverse/raft-shared/src/appConfigTransport.js";
import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_BOUNDS,
  CLEANER_CONFIG_KEYS,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol.js";

import {
  type CleanerConfigApplyResult,
  type CleanerConfigEnvelope,
  SystemCleanerRuntime,
} from "./runtime.js";

type AppConfigMessage = Extract<
  ServerToMachineMessage,
  { type: "app_config.upsert" | "app_config.snapshot" }
>;

export type CleanerConfigReceiveResult =
  | { kind: "ignored"; terminals: readonly CleanerConfigReceiveTerminal[] }
  | {
      kind: "invalid";
      reason: string;
      terminals: readonly CleanerConfigReceiveTerminal[];
    }
  | {
      kind: "upsert";
      result: CleanerConfigApplyResult;
      terminals: readonly CleanerConfigReceiveTerminal[];
    }
  | {
      kind: "snapshot";
      result: CleanerConfigApplyResult | { kind: "removed"; activeSchedules: 0 };
      terminals: readonly CleanerConfigReceiveTerminal[];
    };

export interface CleanerConfigReceiveTerminal {
  attrs: AppRuntimeTraceAttrs;
  outcome: string;
  status: "ok" | "error";
  reason?: string;
}

const CLEANER_EFFECTIVE_KEYS = new Set<string>(Object.values(CLEANER_CONFIG_KEYS));

/**
 * App-owned receiver for generic config transport. It is deliberately the
 * only layer that knows how the generic effective map becomes Cleaner config.
 */
export function receiveCleanerConfigMessage(
  runtime: SystemCleanerRuntime,
  message: AppConfigMessage,
): CleanerConfigReceiveResult {
  if (message.type === "app_config.upsert") {
    if (message.config.appId !== CLEANER_APP_ID) {
      return {
        kind: "ignored",
        terminals: [configTerminal(message.config, "ignored", "error", "unsupported_app")],
      };
    }
    if (message.agentId !== message.config.ownerAgentId) {
      return invalidResult(
        "owner_agent_id_mismatch",
        [configTerminal(message.config, "invalid", "error", "owner_agent_id_mismatch")],
      );
    }
    const config = normalizeCleanerWireSnapshot(message.config);
    if (!config) {
      return invalidResult(
        "config_invalid",
        [configTerminal(message.config, "invalid", "error", "config_invalid")],
      );
    }
    const result = runtime.applyConfig(config);
    return {
      kind: "upsert",
      result,
      terminals: [applyTerminal(message.config, result)],
    };
  }

  const cleanerRows = message.configs.filter((row) => row.appId === CLEANER_APP_ID);
  const unrelatedTerminals = message.configs
    .filter((row) => row.appId !== CLEANER_APP_ID)
    .map((row) => configTerminal(row, "ignored", "error", "unsupported_app"));
  if (cleanerRows.some((row) => row.ownerAgentId !== message.agentId)) {
    return invalidResult(
      "owner_agent_id_mismatch",
      [
        ...unrelatedTerminals,
        ...cleanerRows.map((row) =>
          configTerminal(
            row,
            "invalid",
            "error",
            row.ownerAgentId === message.agentId
              ? "snapshot_rejected"
              : "owner_agent_id_mismatch",
          )),
      ],
    );
  }
  if (cleanerRows.length > 1) {
    return invalidResult(
      "duplicate_owner",
      [
        ...unrelatedTerminals,
        ...cleanerRows.map((row) =>
          configTerminal(row, "invalid", "error", "duplicate_owner")),
      ],
    );
  }
  if (cleanerRows.length === 0) {
    const result = runtime.replaceOwnerSnapshot(message.agentId, null);
    return {
      kind: "snapshot",
      result,
      terminals: [
        ...unrelatedTerminals,
        {
          attrs: appSnapshotTraceAttrs({
            appId: CLEANER_APP_ID,
            ownerAgentId: message.agentId,
            snapshotKind: "app_config",
          }),
          outcome: result.kind,
          status: result.kind === "removed" ? "ok" : "error",
          ...(result.kind === "invalid" ? { reason: result.reason } : {}),
        },
      ],
    };
  }
  const config = normalizeCleanerWireSnapshot(cleanerRows[0]);
  if (!config) {
    return invalidResult(
      "config_invalid",
      [
        ...unrelatedTerminals,
        configTerminal(cleanerRows[0], "invalid", "error", "config_invalid"),
      ],
    );
  }
  const result = runtime.replaceOwnerSnapshot(message.agentId, config);
  return {
    kind: "snapshot",
    result,
    terminals: [...unrelatedTerminals, applyTerminal(cleanerRows[0], result)],
  };
}

function invalidResult(
  reason: string,
  terminals: readonly CleanerConfigReceiveTerminal[],
): CleanerConfigReceiveResult {
  return { kind: "invalid", reason, terminals };
}

function configTerminal(
  config: Pick<AppConfigWireSnapshot, "appId" | "ownerAgentId" | "revision">,
  outcome: string,
  status: "ok" | "error",
  reason?: string,
): CleanerConfigReceiveTerminal {
  return {
    attrs: appConfigTraceAttrs(config),
    outcome,
    status,
    ...(reason === undefined ? {} : { reason }),
  };
}

function applyTerminal(
  config: Pick<AppConfigWireSnapshot, "appId" | "ownerAgentId" | "revision">,
  result: CleanerConfigApplyResult | { kind: "removed"; activeSchedules: 0 },
): CleanerConfigReceiveTerminal {
  return configTerminal(
    config,
    result.kind,
    result.kind === "applied" || result.kind === "removed" ? "ok" : "error",
    result.kind === "invalid" ? result.reason : undefined,
  );
}

function normalizeCleanerWireSnapshot(raw: AppConfigWireSnapshot): CleanerConfigEnvelope | null {
  const normalized = normalizeAppConfigWireSnapshot(raw, CLEANER_CONFIG_BOUNDS);
  if (!normalized || normalized.appId !== CLEANER_APP_ID) return null;
  const keys = Object.keys(normalized.effective);
  if (
    keys.length !== CLEANER_EFFECTIVE_KEYS.size
    || keys.some((key) => !CLEANER_EFFECTIVE_KEYS.has(key))
  ) {
    return null;
  }
  const enabled = normalized.effective[CLEANER_CONFIG_KEYS.enabled];
  const thresholdBytes = normalized.effective[CLEANER_CONFIG_KEYS.thresholdBytes];
  const intervalMs = normalized.effective[CLEANER_CONFIG_KEYS.intervalMs];
  if (
    typeof enabled !== "boolean"
    || typeof thresholdBytes !== "number"
    || typeof intervalMs !== "number"
  ) {
    return null;
  }
  return {
    appId: CLEANER_APP_ID,
    ownerAgentId: normalized.ownerAgentId,
    enabled,
    thresholdBytes,
    intervalMs,
    revision: normalized.revision,
  };
}
