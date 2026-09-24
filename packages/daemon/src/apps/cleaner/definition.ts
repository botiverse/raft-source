/**
 * daemon app-owned <system.cleaner> definition (task #203).
 *
 * Registers the Cleaner's memory_size_hint notification class on the generic
 * #201 typed-Inbox seam via the injected registry. No app name enters OS core —
 * this file IS the app-owned package the substrate registry imports. The closed
 * source-ref schema + bounded preview/action come from here (never freeform
 * shell from a payload). retention=transient: the item may drop across daemon
 * restart; the next periodic measure re-mints (zero durable measurement).
 */

import {
  type AgentInboxSourceRef,
} from "@botiverse/raft-shared";
import {
  CLEANER_APP_ID,
  CLEANER_NOTIFICATION_CLASS,
} from "@botiverse/raft-shared/src/apps/cleaner/configProtocol.js";
import {
  createAgentAppInboxStore,
  type AgentAppInboxStore,
  type AgentAppNotificationClassDefinition,
} from "../../agentAppInbox.js";

/**
 * Closed source-ref schema for a Cleaner measurement item. id = owning agent.
 * There is no durable measurement source/revision, so config changes keep this
 * identity stable; config apply removes obsolete current copy/action first.
 */
export interface CleanerMemoryHintSourceRef {
  kind: "memory_hint";
  agentId: string;
}

const CLEANER_SOURCE_REF_KEYS = new Set([
  "kind",
  "agentId",
]);

function isSafeOwnerId(value: string): boolean {
  return value.length > 0
    && value.length <= 128
    && value !== "."
    && value !== ".."
    && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

/** Normalize untrusted raw into the closed source-ref shape (fail closed). */
function normalizeMemoryHintSourceRef(raw: unknown): { ok: true; ref: AgentInboxSourceRef } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "cleaner sourceRef must be an object" };
  }
  const cand = raw as Record<string, unknown>;
  for (const key of Object.keys(cand)) {
    if (!CLEANER_SOURCE_REF_KEYS.has(key)) {
      return { ok: false, message: `cleaner sourceRef rejects field: ${key}` };
    }
  }
  if (cand.kind !== "memory_hint") {
    return { ok: false, message: `cleaner sourceRef kind must be memory_hint: ${String(cand.kind)}` };
  }
  if (typeof cand.agentId !== "string" || !isSafeOwnerId(cand.agentId)) {
    return { ok: false, message: "cleaner sourceRef.agentId must be a safe owner id" };
  }
  // Stable owner identity: config apply removes an obsolete current item before
  // the next measurement. Config revision/threshold must NOT create parallel
  // identities for the same owner.
  return { ok: true, ref: { kind: "memory_hint", id: cand.agentId } };
}

export interface CleanerAppliedActionConfig {
  thresholdBytes: number;
  maximumThresholdBytes: number;
}

export function deriveCleanerNextThreshold(input: CleanerAppliedActionConfig): {
  nextThresholdBytes: number;
  copyKind: "doubles" | "raises_to_maximum" | "already_at_maximum";
} | null {
  if (
    !Number.isSafeInteger(input.thresholdBytes)
    || input.thresholdBytes <= 0
    || !Number.isSafeInteger(input.maximumThresholdBytes)
    || input.maximumThresholdBytes < input.thresholdBytes
  ) {
    return null;
  }
  if (input.thresholdBytes === input.maximumThresholdBytes) {
    return {
      nextThresholdBytes: input.thresholdBytes,
      copyKind: "already_at_maximum",
    };
  }
  const doubled = Math.min(Number.MAX_SAFE_INTEGER, input.thresholdBytes * 2);
  const nextThresholdBytes = Math.min(doubled, input.maximumThresholdBytes);
  return {
    nextThresholdBytes,
    copyKind: nextThresholdBytes === doubled ? "doubles" : "raises_to_maximum",
  };
}

/**
 * Closed action-builder. The command is derived only from the normalized
 * config revision/threshold; an app payload cannot provide shell or argv.
 * The suggested threshold is double the measured config value, matching the
 * agent-facing Cleaner copy. Server-owned config validation remains the final
 * authority when the command executes.
 */
function materializeCleanerActionCli(
  sourceRef: AgentInboxSourceRef,
  resolveAppliedConfig: (ownerAgentId: string) => CleanerAppliedActionConfig | null,
): string | null {
  const config = resolveAppliedConfig(sourceRef.id);
  if (!config) return null;
  const next = deriveCleanerNextThreshold(config);
  if (!next) return null;
  if (next.copyKind === "already_at_maximum") {
    return `raft app config --app ${CLEANER_APP_ID}`;
  }
  return `raft app config --app ${CLEANER_APP_ID} --set threshold_bytes=${next.nextThresholdBytes}`;
}

export function createSystemCleanerNotificationClassDefinition(
  resolveAppliedConfig: (ownerAgentId: string) => CleanerAppliedActionConfig | null,
): AgentAppNotificationClassDefinition {
  return {
    retention: "transient",
    primaryAction: { kind: "run_command", commandId: "cleaner.configure" },
    normalizeSourceRef: normalizeMemoryHintSourceRef,
    materializeActionCli: ({ sourceRef }) => materializeCleanerActionCli(sourceRef, resolveAppliedConfig),
  };
}

/**
 * #203 injected registry fragment ({ system.cleaner : { memory_size_hint : def } }).
 * OS core stays app-name free; this is imported only when wiring the Cleaner app.
 */
export function createSystemCleanerAppRegistry(
  resolveAppliedConfig: (ownerAgentId: string) => CleanerAppliedActionConfig | null,
) {
  return {
    [CLEANER_APP_ID]: {
      [CLEANER_NOTIFICATION_CLASS]: createSystemCleanerNotificationClassDefinition(resolveAppliedConfig),
    },
  } as const;
}

/** One seeded process-local store shared by Cleaner runtime and Agent API. */
export function createSystemCleanerInboxStore(options?: {
  nowMs?: () => number;
  idFactory?: () => string;
  resolveAppliedConfig?: (ownerAgentId: string) => CleanerAppliedActionConfig | null;
}): AgentAppInboxStore {
  const resolveAppliedConfig = options?.resolveAppliedConfig ?? (() => null);
  return createAgentAppInboxStore({
    registry: createSystemCleanerAppRegistry(resolveAppliedConfig),
    nowMs: options?.nowMs,
    idFactory: options?.idFactory,
  });
}
