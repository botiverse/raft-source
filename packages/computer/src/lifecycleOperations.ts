import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type {
  ComputerLifecycleAction,
  ComputerLifecycleExecutionAck,
} from "@botiverse/raft-shared";
import { currentDate } from "@botiverse/raft-shared";
import { CURRENT_SCHEMA_VERSION, serverLifecycleOperationsPath, upgradeLogPath } from "./paths.js";

export type ComputerLifecycleAckPhase = "shutdown" | "ready";
export type ComputerLifecycleTrigger = "cli" | "web" | "tray";

export interface LocalComputerLifecycleOperation {
  operationId: string;
  parentOperationId?: string;
  action: ComputerLifecycleAction;
  /** Exact requested Computer version; present for newly-created upgrade intents. */
  targetVersion?: string;
  /** Surface that created an upgrade intent; stable across every retry. */
  trigger?: ComputerLifecycleTrigger;
  pendingPhases: ComputerLifecycleAckPhase[];
  createdAt: string;
}

interface LocalComputerLifecycleOperationFile {
  schemaVersion: number;
  operations: LocalComputerLifecycleOperation[];
}

function isAction(value: unknown): value is ComputerLifecycleAction {
  return value === "start" || value === "stop" || value === "restart" || value === "upgrade";
}

function parseOperations(raw: string): LocalComputerLifecycleOperation[] {
  try {
    const parsed = JSON.parse(raw) as Partial<LocalComputerLifecycleOperationFile>;
    if (!Array.isArray(parsed.operations)) return [];
    return parsed.operations.filter((operation): operation is LocalComputerLifecycleOperation =>
      Boolean(operation)
      && typeof operation.operationId === "string"
      && (operation.parentOperationId === undefined || typeof operation.parentOperationId === "string")
      && isAction(operation.action)
      && (operation.targetVersion === undefined || typeof operation.targetVersion === "string")
      && (
        operation.trigger === undefined
        || operation.trigger === "cli"
        || operation.trigger === "web"
        || operation.trigger === "tray"
      )
      && Array.isArray(operation.pendingPhases)
      && operation.pendingPhases.length > 0
      && operation.pendingPhases.every((phase) => phase === "shutdown" || phase === "ready")
      && typeof operation.createdAt === "string"
    );
  } catch {
    return [];
  }
}

async function readOperations(slockHome: string, serverId: string): Promise<LocalComputerLifecycleOperation[]> {
  try {
    return parseOperations(await readFile(serverLifecycleOperationsPath(slockHome, serverId), "utf8"));
  } catch {
    return [];
  }
}

function readOperationsSync(slockHome: string, serverId: string): LocalComputerLifecycleOperation[] {
  try {
    return parseOperations(readFileSync(serverLifecycleOperationsPath(slockHome, serverId), "utf8"));
  } catch {
    return [];
  }
}

async function writeOperations(
  slockHome: string,
  serverId: string,
  operations: LocalComputerLifecycleOperation[],
): Promise<void> {
  const file = serverLifecycleOperationsPath(slockHome, serverId);
  if (operations.length === 0) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, operations }, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function mutateOperations<T>(
  slockHome: string,
  serverId: string,
  mutation: (operations: LocalComputerLifecycleOperation[]) => Promise<T>,
): Promise<T> {
  const file = serverLifecycleOperationsPath(slockHome, serverId);
  const lockTarget = dirname(file);
  await mkdir(lockTarget, { recursive: true });
  const release = await lockfile.lock(lockTarget, {
    lockfilePath: `${file}.mutation.lock`,
    stale: 60_000,
    retries: {
      retries: 10,
      minTimeout: 20,
      maxTimeout: 200,
      factor: 1.5,
    },
    realpath: false,
  });
  try {
    return await mutation(await readOperations(slockHome, serverId));
  } finally {
    await release().catch(() => undefined);
  }
}

export async function enqueueLifecycleOperation(
  slockHome: string,
  serverId: string,
  operation: Omit<LocalComputerLifecycleOperation, "createdAt">,
): Promise<void> {
  await mutateOperations(slockHome, serverId, async (existing) => {
    const duplicate = existing.find((candidate) => candidate.operationId === operation.operationId);
    if (duplicate) {
      if (
        duplicate.action !== operation.action
        || duplicate.targetVersion !== operation.targetVersion
        || duplicate.trigger !== operation.trigger
      ) throw new Error("OPERATION_IDENTITY_CONFLICT");
      const merged = [...new Set([...duplicate.pendingPhases, ...operation.pendingPhases])];
      await writeOperations(slockHome, serverId, existing.map((candidate) =>
        candidate.operationId === operation.operationId ? { ...candidate, pendingPhases: merged } : candidate
      ));
      return;
    }
    await writeOperations(slockHome, serverId, [
      ...existing,
      { ...operation, pendingPhases: [...new Set(operation.pendingPhases)], createdAt: currentDate().toISOString() },
    ]);
  });
}

/**
 * Durably insert one exact lifecycle identity unless another operation already
 * owns the same action. Exact replay is idempotent; a different identity is a
 * conflict and must not be appended alongside the existing action.
 */
export async function enqueueExactLifecycleOperationIfNoActionConflict(
  slockHome: string,
  serverId: string,
  operation: Omit<LocalComputerLifecycleOperation, "createdAt">,
): Promise<boolean> {
  return mutateOperations(slockHome, serverId, async (existing) => {
    const duplicate = existing.find((candidate) => candidate.operationId === operation.operationId);
    if (duplicate) {
      if (
        duplicate.action !== operation.action
        || duplicate.targetVersion !== operation.targetVersion
        || duplicate.trigger !== operation.trigger
      ) throw new Error("OPERATION_IDENTITY_CONFLICT");
      const merged = [...new Set([...duplicate.pendingPhases, ...operation.pendingPhases])];
      await writeOperations(slockHome, serverId, existing.map((candidate) =>
        candidate.operationId === operation.operationId ? { ...candidate, pendingPhases: merged } : candidate
      ));
      return true;
    }
    if (existing.some((candidate) => candidate.action === operation.action)) return false;
    await writeOperations(slockHome, serverId, [
      ...existing,
      { ...operation, pendingPhases: [...new Set(operation.pendingPhases)], createdAt: currentDate().toISOString() },
    ]);
    return true;
  });
}

/**
 * Synchronous by design: DaemonCore emits ready/shutdown frames from sync
 * connection callbacks. The durable file is tiny and scoped to one server.
 */
export function readPendingLifecycleAcknowledgements(
  slockHome: string,
  serverId: string,
  phase?: ComputerLifecycleAckPhase,
  loadedComputerVersion?: string,
): ComputerLifecycleExecutionAck[] {
  const acknowledgements: ComputerLifecycleExecutionAck[] = [];
  for (const operation of readOperationsSync(slockHome, serverId)) {
    for (const pendingPhase of operation.pendingPhases) {
      if (phase && pendingPhase !== phase) continue;
      acknowledgements.push({
        operationId: operation.operationId,
        action: operation.action,
        phase: pendingPhase,
        ...(pendingPhase === "ready" && loadedComputerVersion ? { loadedComputerVersion } : {}),
      });
    }
  }
  return acknowledgements;
}

export function hasPendingLifecycleAction(
  slockHome: string,
  serverId: string,
  action: ComputerLifecycleAction,
): boolean {
  return readOperationsSync(slockHome, serverId).some((operation) => operation.action === action);
}

export function findPendingLifecycleOperation(
  slockHome: string,
  serverId: string,
  action: ComputerLifecycleAction,
): LocalComputerLifecycleOperation | null {
  return readOperationsSync(slockHome, serverId).find((operation) => operation.action === action) ?? null;
}

export async function acknowledgeLifecycleReceipt(
  slockHome: string,
  serverId: string,
  operationId: string,
  phase: ComputerLifecycleAckPhase,
): Promise<void> {
  await mutateOperations(slockHome, serverId, async (existing) => {
    const next = existing.flatMap((operation) => {
      if (operation.operationId !== operationId) return [operation];
      const pendingPhases = operation.pendingPhases.filter((candidate) => candidate !== phase);
      return pendingPhases.length > 0 ? [{ ...operation, pendingPhases }] : [];
    });
    await writeOperations(slockHome, serverId, next);
  });
}

/** Remove a locally-prepared intent after a definitive pre-action refusal. */
export async function discardLifecycleOperation(
  slockHome: string,
  serverId: string,
  operationId: string,
): Promise<void> {
  await mutateOperations(slockHome, serverId, async (existing) => {
    await writeOperations(
      slockHome,
      serverId,
      existing.filter((operation) => operation.operationId !== operationId),
    );
  });
}

function parseCompletedUpgradeRequestIds(raw: string): Set<string> {
  const ids = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { requestId?: unknown; outcome?: unknown };
      if (typeof parsed.requestId === "string" && parsed.outcome === "ok") ids.add(parsed.requestId);
    } catch {
      // A malformed historical line must not block cleanup of valid receipts.
    }
  }
  return ids;
}

export async function retireCompletedUpgradeShutdownsFromLog(
  slockHome: string,
  serverId: string,
): Promise<number> {
  const completed = await readFile(upgradeLogPath(slockHome), "utf8")
    .then(parseCompletedUpgradeRequestIds, () => new Set<string>());
  if (completed.size === 0) return 0;
  let removed = 0;
  await mutateOperations(slockHome, serverId, async (existing) => {
    const next = existing.flatMap((operation) => {
      if (operation.action !== "upgrade" || !completed.has(operation.operationId)) return [operation];
      const pendingPhases = operation.pendingPhases.filter((phase) => phase !== "shutdown");
      if (pendingPhases.length !== operation.pendingPhases.length) removed += 1;
      return pendingPhases.length > 0 ? [{ ...operation, pendingPhases }] : [];
    });
    if (removed > 0) await writeOperations(slockHome, serverId, next);
  });
  return removed;
}
