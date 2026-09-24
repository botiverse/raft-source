import { isProcessAlive, readPidfileAt } from "./internal/process-primitives.js";
import {
  serverConnectedMarkerPath,
  serverRunnerPidReadFallback,
  serverRunnerVersionPath,
} from "./paths.js";
import { listManagedServerIds } from "./serverState.js";
import {
  readProcessVersionEvidence,
  type ProcessVersionEvidence,
} from "./versionEvidence.js";
import {
  readResidentConnectedMarker,
  type ResidentConnectionEvidence,
} from "./residentConnectionMarker.js";

/** Raw process evidence for one managed runner. No health label is derived here. */
export interface RunnerMachineFacts {
  readonly serverId: string;
  readonly pid: number | null;
  readonly alive: boolean;
  readonly versionEvidence: ProcessVersionEvidence | null;
  readonly connectionEvidence: ResidentConnectionEvidence | null;
}

/**
 * Read-only machine evidence consumed by the shared readiness evaluator.
 * Phase 1 deliberately contains only the fields used by start completion;
 * later consumers extend this shape when they land, instead of adding dead
 * speculative facts now.
 */
export interface MachineFacts {
  readonly managedServerIds: readonly string[];
  readonly runners: readonly RunnerMachineFacts[];
}

export interface CollectMachineFactsOptions {
  /** Limit runner I/O to the consumer's targets. Defaults to the managed set. */
  runnerServerIds?: readonly string[];
  listManaged?: typeof listManagedServerIds;
  readPidfile?: typeof readPidfileAt;
  isAlive?: typeof isProcessAlive;
  readVersionEvidence?: typeof readProcessVersionEvidence;
  readConnectionEvidence?: typeof readResidentConnectedMarker;
}

async function readRunnerProcess(
  slockHome: string,
  serverId: string,
  readPidfile: typeof readPidfileAt,
  isAlive: typeof isProcessAlive,
): Promise<{ pid: number | null; alive: boolean }> {
  let firstRecordedPid: number | null = null;
  for (const path of serverRunnerPidReadFallback(slockHome, serverId)) {
    const pid = await readPidfile(path);
    if (pid === null) continue;
    firstRecordedPid ??= pid;
    if (isAlive(pid)) return { pid, alive: true };
  }
  return { pid: firstRecordedPid, alive: false };
}

export async function collectMachineFacts(
  slockHome: string,
  options: CollectMachineFactsOptions = {},
): Promise<MachineFacts> {
  const managedServerIds = [...await (options.listManaged ?? listManagedServerIds)(slockHome)].sort();
  const runnerServerIds = [...new Set(options.runnerServerIds ?? managedServerIds)].sort();
  const readPidfile = options.readPidfile ?? readPidfileAt;
  const isAlive = options.isAlive ?? isProcessAlive;
  const readVersionEvidence = options.readVersionEvidence ?? readProcessVersionEvidence;
  const readConnectionEvidence = options.readConnectionEvidence ?? readResidentConnectedMarker;

  const runners = await Promise.all(runnerServerIds.map(async (serverId): Promise<RunnerMachineFacts> => {
    const [processFacts, versionEvidence] = await Promise.all([
      readRunnerProcess(slockHome, serverId, readPidfile, isAlive),
      readVersionEvidence(serverRunnerVersionPath(slockHome, serverId)),
    ]);
    return {
      serverId,
      ...processFacts,
      versionEvidence,
      connectionEvidence: readConnectionEvidence(serverConnectedMarkerPath(slockHome, serverId)),
    };
  }));

  return { managedServerIds, runners };
}
