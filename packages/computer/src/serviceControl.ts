import { isProcessAlive } from "./internal/process-primitives.js";
import { currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import { connectService } from "./lib/ipc-client.js";
import {
  ServiceClientError,
  type RestartServiceParams,
  type RestartServiceResult,
  type UpgradeCompletedEvent,
  type UpgradeProgressEvent,
} from "./lib/types.js";
import {
  readMachineServiceAttestation,
  readManagedMachineIdentities,
} from "./machineServiceAttestation.js";
import { listManagedServerIds } from "./serverState.js";

interface ReplacementSpawnOptions {
  parentMutationLockHeld?: boolean;
  sourceServicePid?: number;
}

export interface ServiceSelfRestartControlDeps {
  spawnDetachedServiceFn: (slockHome: string, opts: ReplacementSpawnOptions) => Promise<number>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  releaseServiceOwnership?: () => Promise<void>;
  restoreServiceOwnership?: () => Promise<void>;
  readReplacementAttestationFn?: typeof readMachineServiceAttestation;
  readManagedMachineIdentitiesFn?: typeof readManagedMachineIdentities;
  listManagedServerIdsFn?: typeof listManagedServerIds;
  isProcessAliveFn?: typeof isProcessAlive;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  takeoverTimeoutMs?: number;
  candidateShutdownTimeoutMs?: number;
  restoreOwnershipTimeoutMs?: number;
  scheduleCurrentServiceExit?: () => void;
  /** Upgrade-only exact target. Generic restarts may omit it. */
  expectedComputerVersion?: string;
  /** Durable commit barrier run after candidate proof and before incumbent exit. */
  beforeCommitExit?: () => Promise<void>;
}

export type InFlightServiceControl = {
  action: "restart" | "upgrade";
  requestId: string;
};

function hasCompleteManagedIdentities(
  serverIds: string[],
  identities: Record<string, string> | undefined,
): boolean {
  if (!identities) return false;
  const keys = Object.keys(identities).sort();
  return (
    keys.length === serverIds.length &&
    keys.every((key, index) => key === serverIds[index]) &&
    serverIds.every(
      (serverId) =>
        typeof identities[serverId] === "string" &&
        identities[serverId].trim().length > 0,
    )
  );
}

function sameManagedIdentities(
  serverIds: string[],
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  return (
    hasCompleteManagedIdentities(serverIds, left) &&
    hasCompleteManagedIdentities(serverIds, right) &&
    serverIds.every((serverId) => left![serverId] === right![serverId])
  );
}

/** Exact replay is idempotent; every other machine-control overlap is closed. */
export function checkServiceControlAvailability(
  current: InFlightServiceControl | null,
  action: InFlightServiceControl["action"],
  requestId: string | undefined,
): "available" | "replay" {
  if (!current) return "available";
  if (requestId !== undefined && current.action === action && current.requestId === requestId) {
    return "replay";
  }
  throw new ServiceClientError(
    "CONTROL_BUSY",
    `CONTROL_BUSY: ${current.action} ${current.requestId} is already in flight`,
  );
}

export async function performServiceSelfRestart(
  slockHome: string,
  deps: ServiceSelfRestartControlDeps,
): Promise<void> {
  const releaseOwnership = deps.releaseServiceOwnership;
  const restoreOwnership = deps.restoreServiceOwnership;
  if (!releaseOwnership || !restoreOwnership) {
    throw new ServiceClientError(
      "SELF_RELAUNCH_UNAVAILABLE",
      "SELF_RELAUNCH_UNAVAILABLE: service ownership handoff is unavailable",
    );
  }
  const readAttestation = deps.readReplacementAttestationFn ?? readMachineServiceAttestation;
  const readManagedIdentities = deps.readManagedMachineIdentitiesFn ?? readManagedMachineIdentities;
  const listManaged = deps.listManagedServerIdsFn ?? listManagedServerIds;
  const isAlive = deps.isProcessAliveFn ?? isProcessAlive;
  const now = deps.now ?? currentTimeMs;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    setClockTimeout(resolve, ms);
  }));
  const timeoutMs = deps.takeoverTimeoutMs ?? 10_000;
  const candidateShutdownTimeoutMs = deps.candidateShutdownTimeoutMs ?? 1_000;
  const restoreOwnershipTimeoutMs = deps.restoreOwnershipTimeoutMs ?? 2_000;
  let expectedManaged: string[];
  let expectedMachineIdentities: Record<string, string>;
  try {
    expectedManaged = (await listManaged(slockHome)).sort();
    expectedMachineIdentities = await readManagedIdentities(
      slockHome,
      expectedManaged,
    );
  } catch (error) {
    throw new ServiceClientError(
      "SELF_RELAUNCH_UNAVAILABLE",
      `SELF_RELAUNCH_UNAVAILABLE: failed to read managed identity snapshot: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  if (
    !hasCompleteManagedIdentities(expectedManaged, expectedMachineIdentities)
  ) {
    throw new ServiceClientError(
      "SELF_RELAUNCH_UNAVAILABLE",
      "SELF_RELAUNCH_UNAVAILABLE: managed identity snapshot is incomplete or empty",
    );
  }
  let replacementPid: number | null = null;
  let ownershipMayNeedRestore = false;

  try {
    // releaseListener may close the listener before a later unlink fails, so
    // restoration is required for every rejection after this point.
    ownershipMayNeedRestore = true;
    await releaseOwnership();
    replacementPid = await deps.spawnDetachedServiceFn(slockHome, {
      // A CLI-originated control may still own `.lock` while this request
      // drains. Skipping one startup cleanup pass is harmless for Web control.
      parentMutationLockHeld: true,
      sourceServicePid: process.pid,
    });
    const deadline = now() + timeoutMs;
    do {
      const attestation = await readAttestation(
        slockHome,
        Math.min(250, Math.max(1, timeoutMs)),
      );
      if (
        attestation &&
        attestation.servicePid === replacementPid &&
        attestation.sourceServicePid === process.pid
      ) {
        const managedSetMatches =
          attestation.managedServerIds.length === expectedManaged.length &&
          attestation.managedServerIds.every(
            (serverId, index) => serverId === expectedManaged[index],
          );
        if (
          !managedSetMatches ||
          !sameManagedIdentities(
            expectedManaged,
            attestation.managedMachineIdentities,
            expectedMachineIdentities,
          )
        ) {
          throw new Error(
            "replacement managed identity attestation is incomplete or changed",
          );
        }
        if (deps.expectedComputerVersion !== undefined) {
          if (attestation.computerVersion !== deps.expectedComputerVersion) {
            throw new Error(
              `replacement service version mismatch: expected ${deps.expectedComputerVersion}, got ${attestation.computerVersion}`,
            );
          }
        }
        await deps.beforeCommitExit?.();
        (
          deps.scheduleCurrentServiceExit ??
          (() => {
            const immediate = setImmediate(() =>
              process.kill(process.pid, "SIGTERM"),
            );
            immediate.unref();
          })
        )();
        return;
      }
      if (now() >= deadline) break;
      await sleep(Math.min(100, Math.max(0, deadline - now())));
    } while (true);
    throw new Error("replacement did not prove exclusive IPC ownership and managed-set identity");
  } catch (error) {
    if (replacementPid !== null) {
      try { (deps.killProcess ?? process.kill)(replacementPid, "SIGTERM"); } catch { /* best effort */ }
      const shutdownDeadline = now() + candidateShutdownTimeoutMs;
      while (isAlive(replacementPid) && now() < shutdownDeadline) {
        await sleep(Math.min(50, Math.max(1, shutdownDeadline - now())));
      }
      if (isAlive(replacementPid)) {
        try { (deps.killProcess ?? process.kill)(replacementPid, "SIGKILL"); } catch { /* best effort */ }
        const forceDeadline = now() + candidateShutdownTimeoutMs;
        while (isAlive(replacementPid) && now() < forceDeadline) {
          await sleep(Math.min(50, Math.max(1, forceDeadline - now())));
        }
      }
    }
    let restoreError: unknown = null;
    let restored = !ownershipMayNeedRestore;
    const restoreDeadline = now() + restoreOwnershipTimeoutMs;
    while (!restored) {
      try {
        await restoreOwnership();
        restored = true;
      } catch (candidateRestoreError) {
        restoreError = candidateRestoreError;
        if (now() >= restoreDeadline) break;
        await sleep(Math.min(50, Math.max(1, restoreDeadline - now())));
      }
    }
    const restoreDetail = restored
      ? ""
      : `; incumbent ownership restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`;
    throw new ServiceClientError(
      "SELF_RELAUNCH_UNAVAILABLE",
      `SELF_RELAUNCH_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}${restoreDetail}`,
      error,
    );
  }
}

export async function requestServiceRestartViaIpc(
  slockHome: string,
  params?: RestartServiceParams,
): Promise<RestartServiceResult> {
  const client = await connectService(slockHome);
  try {
    return await client.request("restart-service", params);
  } finally {
    await client.close();
  }
}

export interface ManagedUpgradeRelayContext {
  emitUpgradeProgress(event: Omit<UpgradeProgressEvent, "requestId">): void;
  emitUpgradeDone(event: Omit<UpgradeCompletedEvent, "requestId">): void;
}

export interface ManagedUpgradeRelayDeps {
  connectServiceFn?: typeof connectService;
}

export async function requestServiceUpgradeViaIpc(
  slockHome: string,
  originServerId: string,
  requestId: string,
  ctx: ManagedUpgradeRelayContext,
  deps: ManagedUpgradeRelayDeps = {},
): Promise<void> {
  let client: Awaited<ReturnType<typeof connectService>> | null = null;
  try {
    client = await (deps.connectServiceFn ?? connectService)(slockHome);
    const result = await client.request("upgrade-start", {
      scope: "remote",
      requestId,
      originServerId,
      trigger: "web",
    });
    if (result.status === "already-running" && result.upgradeId !== requestId) {
      ctx.emitUpgradeDone({
        ok: false,
        error: `UPGRADE_ALREADY_RUNNING: upgrade ${result.upgradeId} to ${result.targetVersion} is already running`,
      });
      return;
    }
    for await (const event of client.events) {
      if (event.kind === "upgrade-progressed" && event.payload.requestId === requestId) {
        const { requestId: _requestId, ...progress } = event.payload;
        ctx.emitUpgradeProgress(progress);
      }
      if (event.kind === "upgrade-completed" && event.payload.requestId === requestId) {
        const { requestId: _requestId, ...completed } = event.payload;
        ctx.emitUpgradeDone(completed);
        return;
      }
    }
  } catch (err) {
    ctx.emitUpgradeDone({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    await client?.close();
  }
}
