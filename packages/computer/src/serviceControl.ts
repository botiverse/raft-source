import { isProcessAlive, writePidfileAt } from "./internal/process-primitives";
import { servicePidPath } from "./paths";
import { currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import { connectService } from "./lib/ipc-client";
import {
  ServiceClientError,
  type RestartServiceParams,
  type RestartServiceResult,
} from "./lib/types";
import {
  readMachineServiceAttestation,
  readManagedMachineIdentities,
} from "./machineServiceAttestation";
import { listManagedServerIds } from "./serverState";
import { pendingRestartRequestIdForServer, readPendingRestartMarker } from "./restartMarker";

interface ReplacementSpawnOptions {
  parentMutationLockHeld?: boolean;
  sourceServicePid?: number;
}

export interface ServiceSelfRestartControlDeps {
  spawnDetachedServiceFn: (slockHome: string, opts: ReplacementSpawnOptions) => Promise<number>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  releaseServiceOwnership?: () => Promise<void>;
  restoreServiceOwnership?: () => Promise<void>;
  /**
   * Rollback seam (task #912): `spawnDetachedServiceFn` registers the
   * replacement pid in `run/service.pid`. When the takeover fails, the
   * incumbent is still the live service, so the pidfile must name it again
   * before anything else can run (`stop` reads the pidfile first). Written
   * before ownership restoration, which can fail (EADDRINUSE on Windows
   * named pipes) and must not leave the dead replacement pid behind.
   * Defaults to writing `process.pid` to `servicePidPath(slockHome)`.
   */
  writeIncumbentPidfile?: () => Promise<void>;
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
    // The incumbent (this process) is still the live service. Put its pid
    // back before trying to re-own the endpoint: if restoration fails, the
    // pidfile must not keep pointing at the replacement we just killed, or
    // `raft-computer stop` reports stale_pidfile_cleared and leaves this
    // service and its runners running (task #912, Windows field report).
    let pidfileError: unknown = null;
    try {
      await (deps.writeIncumbentPidfile ?? (() => writePidfileAt(servicePidPath(slockHome), process.pid)))();
    } catch (candidatePidfileError) {
      pidfileError = candidatePidfileError;
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
    const pidfileDetail = pidfileError === null
      ? ""
      : `; incumbent pidfile restore failed: ${pidfileError instanceof Error ? pidfileError.message : String(pidfileError)}`;
    throw new ServiceClientError(
      "SELF_RELAUNCH_UNAVAILABLE",
      `SELF_RELAUNCH_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}${restoreDetail}${pidfileDetail}`,
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

/**
 * The restart request lost its connection without a response. On Windows this
 * is the normal handoff: the incumbent must close every IPC connection before
 * its replacement can bind the named pipe (task #924). Elsewhere it means the
 * service went away mid-request. Either way the request has not failed yet.
 */
export function isServiceConnectionLoss(error: unknown): boolean {
  if (!(error instanceof ServiceClientError)) return false;
  if (error.code === "IPC_CLIENT_CLOSED") return true;
  const cause = error.cause as NodeJS.ErrnoException | undefined;
  return error.code === "IPC_MALFORMED_FRAME" &&
    (cause?.code === "ECONNRESET" || cause?.code === "EPIPE");
}

export interface RestartOutcomeWaitDeps {
  readPendingRestartMarkerFn?: typeof readPendingRestartMarker;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Settle a restart whose request connection was closed. A successful takeover
 * terminates the incumbent and this runner with it, and the replacement's
 * runner reports success from the pending-restart marker. A failed takeover
 * keeps the incumbent running and clears the marker, so a marker that no
 * longer carries this request while we are still alive is the failure. So is
 * a service that died before writing it. The runner skips its own reconcile
 * while waiting, so it cannot retire the marker itself.
 */
export async function awaitRestartOutcomeAfterConnectionLoss(
  slockHome: string,
  serverId: string,
  requestId: string,
  deps: RestartOutcomeWaitDeps = {},
): Promise<void> {
  const readMarker = deps.readPendingRestartMarkerFn ?? readPendingRestartMarker;
  const now = deps.now ?? currentTimeMs;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    setClockTimeout(resolve, ms);
  }));
  const deadline = now() + (deps.timeoutMs ?? 60_000);
  do {
    const marker = await readMarker(slockHome);
    if (!marker || pendingRestartRequestIdForServer(marker, serverId) !== requestId) {
      throw new ServiceClientError(
        "SELF_RELAUNCH_UNAVAILABLE",
        "SELF_RELAUNCH_UNAVAILABLE: the restart did not complete; check `raft-computer status` and `raft-computer logs --service`",
      );
    }
    if (now() >= deadline) break;
    await sleep(Math.min(250, Math.max(1, deadline - now())));
  } while (true);
  throw new ServiceClientError(
    "SELF_RELAUNCH_UNAVAILABLE",
    "SELF_RELAUNCH_UNAVAILABLE: restart handoff did not finish",
  );
}

export interface ManagedUpgradeRelayDeps {
  connectServiceFn?: typeof connectService;
}

/** Remote upgrade v2 (task #873): ask the supervisor to launch the installer and return. */
export async function requestServiceUpgradeStartViaIpc(
  slockHome: string,
  params: { requestId: string; originServerId: string; targetVersion?: string; drain?: { deadlineMs: number } },
  deps: ManagedUpgradeRelayDeps = {},
): Promise<void> {
  const client = await (deps.connectServiceFn ?? connectService)(slockHome);
  try {
    const result = await client.request("upgrade-start", {
      scope: "remote",
      requestId: params.requestId,
      originServerId: params.originServerId,
      trigger: "web",
      ...(params.targetVersion ? { targetVersion: params.targetVersion } : {}),
      ...(params.drain ? { drain: params.drain } : {}),
    });
    if (result.status === "already-running" && result.upgradeId !== params.requestId) {
      throw new Error(`UPGRADE_ALREADY_RUNNING: upgrade ${result.upgradeId} is already running`);
    }
  } finally {
    await client.close();
  }
}

