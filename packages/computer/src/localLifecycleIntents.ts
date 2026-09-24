import { randomUUID } from "node:crypto";
import type { ComputerLifecycleAction } from "@botiverse/raft-shared";
import {
  enqueueExactLifecycleOperationIfNoActionConflict,
  enqueueLifecycleOperation,
  hasPendingLifecycleAction,
  type ComputerLifecycleTrigger,
} from "./lifecycleOperations.js";
import { readServerAttachment, type ServerAttachment } from "./serverState.js";
import {
  ensureUsableUserSession,
  type UsableUserSession,
} from "./lib/userSession.js";
import { computerFetch } from "./proxy.js";

export type ComputerLifecycleIntentResult =
  | { status: "accepted"; operationId: string }
  | {
      status: "rejected";
      code: string;
      /** Safe, actionable policy reasons only; raw policy fields stay private. */
      reason?: "policy_row_missing";
    };

type ComputerLifecycleIntentIdentity = {
  serverId: string;
  machineId: string;
  operationId: string;
  parentOperationId: string;
};

type ComputerLifecycleIntentInput = ComputerLifecycleIntentIdentity & (
  | {
      action: "upgrade";
      targetVersion: string;
      completionMode?: "legacy_k_promoted";
    }
  | {
      action: Exclude<ComputerLifecycleAction, "upgrade">;
      targetVersion?: never;
      completionMode?: never;
    }
);

/** User-authenticated intent writer used before local lifecycle mutation. */
export class ComputerLifecycleClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
  ) {}

  async create(input: ComputerLifecycleIntentInput): Promise<ComputerLifecycleIntentResult> {
    try {
      const path = `/api/servers/${encodeURIComponent(input.serverId)}/machines/${encodeURIComponent(input.machineId)}/computer-lifecycle-operations`;
      const res = await computerFetch(new URL(path, this.baseUrl).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
          "X-Server-Id": input.serverId,
        },
        body: JSON.stringify({
          operationId: input.operationId,
          parentOperationId: input.parentOperationId,
          action: input.action,
          ...(input.action === "upgrade"
            ? {
                targetVersion: input.targetVersion,
                ...(input.completionMode ? { completionMode: input.completionMode } : {}),
              }
            : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.status === 201 && body && typeof body.operationId === "string") {
        return { status: "accepted", operationId: body.operationId };
      }
      const policy = body?.policy;
      const policyReason = body?.code === "computer_broadcast_not_eligible"
        && policy !== null
        && typeof policy === "object"
        && (policy as { reasonCode?: unknown }).reasonCode === "policy_row_missing"
          ? "policy_row_missing" as const
          : undefined;
      return {
        status: "rejected",
        code: body && typeof body.code === "string" ? body.code : `http_${res.status}`,
        ...(policyReason ? { reason: policyReason } : {}),
      };
    } catch {
      return { status: "rejected", code: "request_failed" };
    }
  }
}

export interface PreparedLocalLifecycleOperation {
  serverId: string;
  operationId: string;
  trigger?: ComputerLifecycleTrigger;
}

export type PreparedLocalUpgradeLifecycleOperation = PreparedLocalLifecycleOperation & {
  trigger: ComputerLifecycleTrigger;
};

export type PrepareExactLocalUpgradeLifecycleResult =
  | { status: "prepared"; operation: PreparedLocalLifecycleOperation }
  | {
      status: "retryable_ready_pending";
      code: "computer_offline" | "computer_lifecycle_completion_ready_pending";
    }
  | { status: "rejected"; code: string };

export type PrepareLocalUpgradeLifecycleResult =
  | { status: "prepared"; operation: PreparedLocalUpgradeLifecycleOperation }
  | {
      status: "rejected";
      code: string;
      reason?: "policy_row_missing";
    };

type LifecycleAttachment = ServerAttachment & { machineId: string };
type LifecycleIntentInput = Parameters<ComputerLifecycleClient["create"]>[0];

export interface LocalLifecycleIntentDependencies {
  readAttachment: (slockHome: string, serverId: string) => Promise<ServerAttachment | null>;
  ensureSession: (slockHome: string, serverUrl: string) => Promise<UsableUserSession>;
  createIntent: (
    serverUrl: string,
    accessToken: string,
    input: LifecycleIntentInput,
  ) => Promise<ComputerLifecycleIntentResult>;
  enqueue: typeof enqueueLifecycleOperation;
  enqueueExact: typeof enqueueExactLifecycleOperationIfNoActionConflict;
  hasPending: typeof hasPendingLifecycleAction;
  createId: () => string;
}

const defaultDependencies: LocalLifecycleIntentDependencies = {
  readAttachment: readServerAttachment,
  ensureSession: (slockHome, serverUrl) =>
    ensureUsableUserSession(slockHome, serverUrl, { requireServerOrigin: true }),
  createIntent: (serverUrl, accessToken, input) =>
    new ComputerLifecycleClient(serverUrl, accessToken).create(input),
  enqueue: enqueueLifecycleOperation,
  enqueueExact: enqueueExactLifecycleOperationIfNoActionConflict,
  hasPending: hasPendingLifecycleAction,
  createId: randomUUID,
};

/**
 * Prepare exactly one authenticated Server-recorded upgrade origin for the
 * live service. Hands is the release authority; this route records the local
 * user's durable intent without adding a second rollout-policy veto.
 * Unlike generic multi-server process control, this path is fail-closed and
 * preserves the typed reason at each boundary so callers never infer failure
 * from an empty array. K/IPC may start only after `prepared` is returned.
 */
export async function prepareLocalUpgradeLifecycleOperation(
  slockHome: string,
  serverId: string,
  targetVersion: string,
  trigger: ComputerLifecycleTrigger,
  dependencyOverrides: Partial<LocalLifecycleIntentDependencies> = {},
): Promise<PrepareLocalUpgradeLifecycleResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const attachment = await dependencies.readAttachment(slockHome, serverId);
  if (!attachment || typeof attachment.machineId !== "string") {
    return { status: "rejected", code: "attachment_missing" };
  }
  const session = await dependencies.ensureSession(slockHome, attachment.serverUrl).catch(() => null);
  if (!session || session.status !== "usable") {
    return { status: "rejected", code: "user_session_unusable" };
  }
  if (dependencies.hasPending(slockHome, serverId, "upgrade")) {
    return { status: "rejected", code: "local_lifecycle_conflict" };
  }

  const parentOperationId = dependencies.createId();
  const operationId = dependencies.createId();
  const result = await dependencies.createIntent(attachment.serverUrl, session.accessToken, {
    serverId,
    machineId: attachment.machineId,
    operationId,
    parentOperationId,
    action: "upgrade",
    targetVersion,
  });
  if (result.status === "rejected") {
    return {
      status: "rejected",
      code: result.code,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }
  if (result.operationId !== operationId) {
    return { status: "rejected", code: "operation_identity_mismatch" };
  }
  try {
    await dependencies.enqueue(slockHome, serverId, {
      operationId: result.operationId,
      parentOperationId,
      action: "upgrade",
      targetVersion,
      trigger,
      pendingPhases: ["shutdown", "ready"],
    });
  } catch {
    return { status: "rejected", code: "local_lifecycle_persist_failed" };
  }
  return {
    status: "prepared",
    operation: { serverId, operationId: result.operationId, trigger },
  };
}

/**
 * Adopt one already-completed local K upgrade into the Server lifecycle log.
 * The caller supplies K's exact operation id; Server acceptance and the local
 * durable acknowledgement must both succeed before the caller may bind K's
 * receipt to this origin.
 */
export async function prepareExactLocalUpgradeLifecycleOperation(
  slockHome: string,
  serverId: string,
  operationId: string,
  targetVersion: string,
  trigger: ComputerLifecycleTrigger,
  dependencyOverrides: Partial<LocalLifecycleIntentDependencies> = {},
): Promise<PreparedLocalLifecycleOperation | null> {
  const result = await prepareExactLocalUpgradeLifecycleOperationResult(
    slockHome,
    serverId,
    operationId,
    targetVersion,
    trigger,
    dependencyOverrides,
  );
  return result.status === "prepared" ? result.operation : null;
}

/**
 * Detailed form used by connect-time legacy adoption. Only a Server response
 * that says the live ready precondition is not visible yet is retryable; all
 * identity, target, session, and local durability failures remain terminal.
 */
export async function prepareExactLocalUpgradeLifecycleOperationResult(
  slockHome: string,
  serverId: string,
  operationId: string,
  targetVersion: string,
  trigger: ComputerLifecycleTrigger,
  dependencyOverrides: Partial<LocalLifecycleIntentDependencies> = {},
): Promise<PrepareExactLocalUpgradeLifecycleResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const attachment = await dependencies.readAttachment(slockHome, serverId);
  if (!attachment || typeof attachment.machineId !== "string") {
    return { status: "rejected", code: "attachment_missing" };
  }
  const session = await dependencies.ensureSession(slockHome, attachment.serverUrl).catch(() => null);
  if (!session || session.status !== "usable") {
    return { status: "rejected", code: "user_session_unusable" };
  }
  const result = await dependencies.createIntent(attachment.serverUrl, session.accessToken, {
    serverId,
    machineId: attachment.machineId,
    operationId,
    // This is a single-operation legacy completion, so its exact K id is also
    // its stable parent identity. A ready-race retry must be byte-identical and
    // must never mint a second parent or durable intent.
    parentOperationId: operationId,
    action: "upgrade",
    targetVersion,
    completionMode: "legacy_k_promoted",
  });
  if (result.status === "rejected") {
    if (result.code === "computer_offline"
      || result.code === "computer_lifecycle_completion_ready_pending") {
      return { status: "retryable_ready_pending", code: result.code };
    }
    return { status: "rejected", code: result.code };
  }
  if (result.operationId !== operationId) {
    return { status: "rejected", code: "operation_identity_mismatch" };
  }
  try {
    const enqueued = await dependencies.enqueueExact(slockHome, serverId, {
      operationId,
      action: "upgrade",
      targetVersion,
      trigger,
      pendingPhases: ["shutdown", "ready"],
    });
    if (!enqueued) return { status: "rejected", code: "local_lifecycle_conflict" };
  } catch {
    return { status: "rejected", code: "local_lifecycle_persist_failed" };
  }
  return {
    status: "prepared",
    operation: { serverId, operationId, trigger },
  };
}

/**
 * Fail-open for local process control, fail-closed for action attribution.
 * Only server-accepted intents are persisted as acknowledgements.
 */
export async function prepareLocalLifecycleOperations(
  slockHome: string,
  action: Exclude<ComputerLifecycleAction, "upgrade">,
  serverIds: string[],
  dependencyOverrides: Partial<LocalLifecycleIntentDependencies> = {},
): Promise<PreparedLocalLifecycleOperation[]> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const attachments = (await Promise.all(serverIds.map((serverId) =>
    dependencies.readAttachment(slockHome, serverId)
  ))).filter((attachment): attachment is LifecycleAttachment =>
    attachment !== null && typeof attachment.machineId === "string"
  );
  if (attachments.length === 0) return [];

  const sessions = new Map<string, Promise<UsableUserSession | null>>();
  const getSession = (serverUrl: string) => {
    let session = sessions.get(serverUrl);
    if (!session) {
      session = dependencies.ensureSession(slockHome, serverUrl).catch(() => null);
      sessions.set(serverUrl, session);
    }
    return session;
  };
  const parentOperationId = dependencies.createId();
  const prepared: PreparedLocalLifecycleOperation[] = [];
  for (const attachment of attachments) {
    if (dependencies.hasPending(slockHome, attachment.serverId, action)) continue;
    const session = await getSession(attachment.serverUrl);
    if (!session || session.status !== "usable") continue;
    const operationId = dependencies.createId();
    const result = await dependencies.createIntent(attachment.serverUrl, session.accessToken, {
      serverId: attachment.serverId,
      machineId: attachment.machineId,
      operationId,
      parentOperationId,
      action,
    });
    if (result.status !== "accepted") continue;
    try {
      await dependencies.enqueue(slockHome, attachment.serverId, {
        operationId: result.operationId,
        parentOperationId,
        action,
        pendingPhases: action === "start"
          ? ["ready"]
          : action === "stop"
            ? ["shutdown"]
            : ["shutdown", "ready"],
      });
      prepared.push({
        serverId: attachment.serverId,
        operationId: result.operationId,
      });
    } catch {
      // The durable server intent will expire unconfirmed. Never claim action
      // provenance when the local acknowledgement could not be persisted.
    }
  }
  return prepared;
}
