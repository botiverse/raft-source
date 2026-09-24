import { spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  loadOperation,
  type OperationRead,
  type Upgrader,
} from "@botiverse/k-carrier";
import { currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";

import { createComputerUpgrader } from "./kUpgrader.js";
import { resolveKResidentBinary } from "./kResidentBinary.js";
import { rotateLogIfNeeded } from "./logRotation.js";
import { serviceLogPath } from "./paths.js";
import type { KUpgradeCoordinatorRequest } from "./kUpgradeCoordinator.js";
import { kStateDir } from "./kPaths.js";

const seaRequire = createRequire(import.meta.url);
function isSeaProcess(): boolean {
  try {
    return (seaRequire("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

function encodeRequest(request: KUpgradeCoordinatorRequest): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

export interface SpawnKUpgradeCoordinatorDeps {
  isSeaBinaryFn?: () => boolean;
  resolveKResidentBinaryFn?: typeof resolveKResidentBinary;
  spawnFn?: typeof spawn;
}

export interface WaitForKUpgradeStartDeps {
  loadOperationFn?: (stateDir: string) => Promise<OperationRead>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

function exactKUpgradeReceipt(
  observed: OperationRead,
  request: KUpgradeCoordinatorRequest,
): boolean {
  if (observed.kind !== "observed" || observed.operation.id !== request.requestId) return false;
  const operation = observed.operation;
  const expectedPriorIdentities = request.priorProcessIdentities?.length
    ? JSON.stringify(request.priorProcessIdentities)
    : undefined;
  const coordinatorPid = Number(operation.metadata.coordinatorPid);
  if (
    operation.fromVersion !== request.fromVersion
    || operation.targetVersion !== request.targetVersion
    || operation.metadata.upgradeScopeVersion !== "1"
    || operation.metadata.upgradeScope !== request.scope
    || operation.metadata.trigger !== request.trigger
    || operation.metadata.originServerId !== request.originServerId
    || operation.metadata.priorProcessIdentities !== expectedPriorIdentities
    || !Number.isSafeInteger(coordinatorPid)
    || coordinatorPid <= 0
    || operation.provenance === null
    || operation.provenance.carrier !== request.trigger
    || operation.provenance.who !== (request.scope === "remote" ? request.originServerId : "local")
  ) {
    throw new Error("K_UPGRADE_RECEIPT_IDENTITY_MISMATCH");
  }
  return true;
}

/**
 * Classify K's durable receipt before spawning a detached coordinator.
 * Exact replay is consumable; another live/unacknowledged operation owns the
 * slot; only genesis or an acknowledged terminal receipt admits a new id.
 */
export async function inspectKUpgradeStart(
  slockHome: string,
  request: KUpgradeCoordinatorRequest,
  loadOperationFn: (stateDir: string) => Promise<OperationRead> = loadOperation,
): Promise<"fresh" | "exact"> {
  const observed = await loadOperationFn(kStateDir(slockHome));
  if (observed.kind === "unreadable") throw new Error("K_UPGRADE_RECEIPT_UNREADABLE");
  if (exactKUpgradeReceipt(observed, request)) return "exact";
  if (
    observed.kind === "observed"
    && (observed.operation.outcome === null || observed.operation.acknowledgedAtMs === null)
  ) {
    throw new Error("K_UPGRADE_OPERATION_BLOCKED");
  }
  return "fresh";
}

/**
 * A successful OS spawn is not an accepted K transaction. Wait until K has
 * durably published the exact id/target/origin receipt. If the child exits
 * first, the receipt is unreadable/mismatched, or the bounded deadline passes,
 * the caller must reject the IPC request instead of reporting `started`.
 */
export async function waitForKUpgradeStart(
  slockHome: string,
  request: KUpgradeCoordinatorRequest,
  coordinatorExited: () => boolean,
  deps: WaitForKUpgradeStartDeps = {},
): Promise<void> {
  const read = deps.loadOperationFn ?? loadOperation;
  const now = deps.now ?? currentTimeMs;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    setClockTimeout(resolve, ms);
  }));
  const deadline = now() + (deps.timeoutMs ?? 10_000);
  const pollIntervalMs = deps.pollIntervalMs ?? 25;

  for (;;) {
    if (coordinatorExited()) throw new Error("K_UPGRADE_COORDINATOR_REJECTED");
    const observed = await read(kStateDir(slockHome));
    if (observed.kind === "unreadable") throw new Error("K_UPGRADE_RECEIPT_UNREADABLE");
    if (exactKUpgradeReceipt(observed, request)) return;
    if (now() >= deadline) throw new Error("K_UPGRADE_START_TIMEOUT");
    await sleep(pollIntervalMs);
  }
}

export async function spawnKUpgradeCoordinator(
  slockHome: string,
  request: KUpgradeCoordinatorRequest,
  deps: SpawnKUpgradeCoordinatorDeps = {},
): Promise<ChildProcess> {
  if (!(deps.isSeaBinaryFn ?? isSeaProcess)()) throw new Error("K_COORDINATOR_SEA_ONLY");
  const resident = await (deps.resolveKResidentBinaryFn ?? resolveKResidentBinary)(
    slockHome,
    process.execPath,
    true,
  );
  await rotateLogIfNeeded(serviceLogPath(slockHome));
  const log = await open(serviceLogPath(slockHome), "a");
  const child = (deps.spawnFn ?? spawn)(resident, ["__k-upgrade", encodeRequest(request)], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    windowsHide: true,
    env: process.env,
  });
  child.on("error", () => {});
  child.unref();
  await log.close();
  if (!child.pid) throw new Error("K_COORDINATOR_SPAWN_FAILED");
  return child;
}

export function readKUpgradeCoordinatorRequest(encoded: string): KUpgradeCoordinatorRequest {
  if (!/^[A-Za-z0-9_-]{1,8192}$/u.test(encoded)) throw new Error("K_COORDINATOR_REQUEST_INVALID");
  let parsed: Partial<KUpgradeCoordinatorRequest>;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<KUpgradeCoordinatorRequest>;
  } catch {
    throw new Error("K_COORDINATOR_REQUEST_INVALID");
  }
  if (
    (parsed.mode !== "upgrade" && parsed.mode !== "recover")
    || parsed.carrier !== "k"
    || typeof parsed.requestId !== "string"
    || !/^[A-Za-z0-9._-]{1,160}$/u.test(parsed.requestId)
    || typeof parsed.fromVersion !== "string"
    || typeof parsed.targetVersion !== "string"
    || typeof parsed.startedAt !== "string"
    || !Number.isFinite(Date.parse(parsed.startedAt))
    || typeof parsed.currentBinaryPath !== "string"
    || (parsed.scope !== "local" && parsed.scope !== "remote")
    || (parsed.scope === "local" && (
      (parsed.trigger !== "cli" && parsed.trigger !== "tray")
      || parsed.originServerId !== undefined
    ))
    || (parsed.scope === "remote" && (
      parsed.trigger !== "web"
      || typeof parsed.originServerId !== "string"
      || parsed.originServerId.length === 0
    ))
    || !(parsed.priorProcessIdentities === undefined || (
      Array.isArray(parsed.priorProcessIdentities)
      && parsed.priorProcessIdentities.length > 0
      && parsed.priorProcessIdentities.length <= 512
      && parsed.priorProcessIdentities.every((identity) =>
        typeof identity === "string"
        && /^(?:service:\d+|runner:[^\s:]{1,240}:\d+)$/u.test(identity)
      )
    ))
  ) throw new Error("K_COORDINATOR_REQUEST_INVALID");
  return parsed as KUpgradeCoordinatorRequest;
}

export interface SpawnPendingKUpgradeRecoveryDeps {
  createUpgraderFn?: (slockHome: string) => Upgrader;
  spawnCoordinatorFn?: typeof spawnKUpgradeCoordinator;
}

function parsePriorProcessIdentities(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length === 0
      || parsed.length > 512
      || parsed.some((identity) =>
        typeof identity !== "string"
        || !/^(?:service:\d+|runner:[^\s:]{1,240}:\d+)$/u.test(identity)
      )
    ) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Spawn recovery from K's active receipt; there is no Computer pending mirror. */
export async function spawnPendingKUpgradeRecovery(
  slockHome: string,
  currentBinaryPath = process.execPath,
  deps: SpawnPendingKUpgradeRecoveryDeps = {},
): Promise<ChildProcess | null> {
  const upgrader = (deps.createUpgraderFn ?? ((home) => createComputerUpgrader(home, {
    onProgress: () => {},
    notificationSink: async () => {},
  })))(slockHome);
  const observed = await upgrader.operation();
  if (observed.kind !== "observed" || observed.operation.outcome !== null) return null;
  const trigger = observed.operation.metadata.trigger;
  const scope = observed.operation.metadata.upgradeScope;
  if (observed.operation.metadata.upgradeScopeVersion !== "1") return null;
  if (scope !== "local" && scope !== "remote") return null;
  if (scope === "local" && trigger !== "cli" && trigger !== "tray") return null;
  if (scope === "remote" && trigger !== "web") return null;
  const originServerId = observed.operation.metadata.originServerId;
  if (scope === "local" && originServerId !== undefined) return null;
  if (scope === "remote" && !originServerId) return null;
  const priorProcessIdentities = parsePriorProcessIdentities(
    observed.operation.metadata.priorProcessIdentities,
  );
  if (observed.operation.metadata.priorProcessIdentities && !priorProcessIdentities) return null;
  const commonRequest = {
    carrier: "k",
    mode: "recover",
    requestId: observed.operation.id,
    fromVersion: observed.operation.fromVersion,
    targetVersion: observed.operation.targetVersion,
    startedAt: new Date(observed.operation.startedAtMs).toISOString(),
    currentBinaryPath,
    ...(priorProcessIdentities ? { priorProcessIdentities } : {}),
  } as const;
  const request: KUpgradeCoordinatorRequest = scope === "remote"
    ? {
        ...commonRequest,
        scope,
        trigger: "web",
        originServerId: originServerId!,
      }
    : {
        ...commonRequest,
        scope,
        trigger: trigger as "cli" | "tray",
      };
  return (deps.spawnCoordinatorFn ?? spawnKUpgradeCoordinator)(slockHome, request);
}
