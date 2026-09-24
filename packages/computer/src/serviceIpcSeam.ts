import {
  createIpcServer,
  type IpcServer,
  type RequestHandlerMap,
} from "./internal/ipc-server.js";
import { createMachineAttestationHandler } from "./machineServiceAttestation.js";
import { resetRunner, resetService } from "./reset.js";
import { listRunners, readRunnerStatus, readServiceStatus } from "./lib/readers.js";
import {
  ServiceClientError,
  StateReaderError,
  type ResetRunnerResult,
  type ResetServiceResult,
  type RestartServiceParams,
  type RestartServiceResult,
  type UpgradeStartParams,
  type UpgradeStartResult,
} from "./lib/types.js";

/**
 * Mutation surface the running service injects into its IPC seam so the
 * `reset-service` / `reset-runner` handlers can run inside the supervisor
 * process and update its in-memory runner state (not just disk). This is
 * the single-writer model: when a service is up, mutations route CLI→IPC→
 * here, so the service's in-memory `RunnerState` cache stays consistent
 * with the on-disk health it just cleared. When omitted (e.g. seam unit
 * tests with no live supervisor), handlers fall back to the lib-pure
 * disk-only path.
 */
export interface ServiceIpcMutations {
  restartService(params?: RestartServiceParams): Promise<RestartServiceResult>;
  resetService(): Promise<ResetServiceResult>;
  resetRunner(serverId: string): Promise<ResetRunnerResult>;
  upgradeStart(params: UpgradeStartParams): Promise<UpgradeStartResult>;
}

export function createServiceIpcSeam(
  slockHome: string,
  mutations?: ServiceIpcMutations,
  sourceServicePid?: number,
): IpcServer {
  const machineAttestation = createMachineAttestationHandler(slockHome, sourceServicePid);
  const handlers: RequestHandlerMap = {
    "service-status": async () => readServiceStatus(slockHome),
    "machine-attestation": machineAttestation,
    "runner-status": async ({ serverId }) => {
      try {
        return await readRunnerStatus(slockHome, serverId);
      } catch (err) {
        if (err instanceof StateReaderError) {
          throw new ServiceClientError("IPC_MALFORMED_FRAME", `${err.code}: ${err.message}`);
        }
        throw err;
      }
    },
    "list-runners": async () => listRunners(slockHome),
    "restart-service": async (params) => {
      if (!mutations) {
        throw new ServiceClientError(
          "IPC_MALFORMED_FRAME",
          "restart-service requires a live supervisor mutation surface",
        );
      }
      return mutations.restartService(params || undefined);
    },
    "reset-service": async () =>
      mutations ? mutations.resetService() : resetService(slockHome),
    "reset-runner": async ({ serverId }) =>
      mutations ? mutations.resetRunner(serverId) : resetRunner(slockHome, serverId),
    "upgrade-start": async (params) => {
      if (!mutations) {
        throw new ServiceClientError(
          "IPC_MALFORMED_FRAME",
          "upgrade-start requires a live supervisor mutation surface",
        );
      }
      return mutations.upgradeStart(params);
    },
  };
  return createIpcServer({ installRoot: slockHome, handlers });
}

export async function listenServiceIpcSeam(ipc: IpcServer): Promise<IpcServer> {
  try {
    const transportPath = await ipc.listen();
    process.stderr.write(`Service: IPC seam listening at ${transportPath}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Service: IPC seam failed to bind (${msg}); ownership not acquired.\n`);
    throw err;
  }
  return ipc;
}

export async function startServiceIpcSeam(
  slockHome: string,
  mutations?: ServiceIpcMutations,
  sourceServicePid?: number,
): Promise<IpcServer> {
  return listenServiceIpcSeam(
    createServiceIpcSeam(slockHome, mutations, sourceServicePid),
  );
}
