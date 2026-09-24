import { randomUUID } from "node:crypto";
import { currentDate, setClockTimeout } from "@botiverse/raft-shared";
import { COMPUTER_VERSION } from "./version.js";
import { connectService } from "./lib/ipc-client.js";
import type { MachineServiceAttestation } from "./lib/types.js";
import { isProcessAlive, readPidfileAt } from "./internal/process-primitives.js";
import {
  serverRunnerPidPath,
  serverRunnerVersionPath,
  servicePidPath,
  serviceVersionPath,
} from "./paths.js";
import { listManagedServerIds, readServerAttachment } from "./serverState.js";
import { readProcessVersionEvidence } from "./versionEvidence.js";
import { readPendingRestartMarker, type PendingRestartMarker } from "./restartMarker.js";

export const MACHINE_ATTESTATION_TIMEOUT_MS = 1_000;

export interface MachineConvergenceAttestation {
  serviceGeneration: string;
  managedSetRevision: string;
  deadProcessIdentities: string[];
}

export interface LiveServiceSnapshot {
  evidence: Awaited<ReturnType<typeof readProcessVersionEvidence>>;
  servicePid: number | null;
  alive: boolean;
}

export async function readLiveServiceSnapshot(
  slockHome: string,
): Promise<LiveServiceSnapshot> {
  const evidence = await readProcessVersionEvidence(serviceVersionPath(slockHome));
  const servicePid = await readPidfileAt(servicePidPath(slockHome));
  return {
    evidence,
    servicePid,
    alive: servicePid !== null && isProcessAlive(servicePid),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setClockTimeout(resolve, ms); });
}

export async function readMachineServiceAttestation(
  slockHome: string,
  timeoutMs = MACHINE_ATTESTATION_TIMEOUT_MS,
): Promise<MachineServiceAttestation | null> {
  try {
    const client = await connectService(slockHome, { timeoutMs });
    try {
      const attestation = await client.request("machine-attestation", undefined, { timeoutMs });
      const currentServicePid = await readPidfileAt(servicePidPath(slockHome));
      return currentServicePid === attestation.servicePid && isProcessAlive(attestation.servicePid)
        ? attestation
        : null;
    } finally {
      await client.close();
    }
  } catch {
    return null;
  }
}

async function currentManagedProcesses(slockHome: string): Promise<{
  serverIds: string[];
  runners: Array<{ pid: number | null; version: string | null | undefined; evidencePid: number | undefined }>;
}> {
  const serverIds = (await listManagedServerIds(slockHome)).sort();
  const runners = await Promise.all(serverIds.map(async (serverId) => {
    const pid = await readPidfileAt(serverRunnerPidPath(slockHome, serverId));
    const evidence = await readProcessVersionEvidence(serverRunnerVersionPath(slockHome, serverId));
    return { pid, version: evidence?.version, evidencePid: evidence?.pid };
  }));
  return { serverIds, runners };
}

function sameManagedSet(attestation: MachineServiceAttestation, serverIds: string[]): boolean {
  return attestation.managedServerIds.length === serverIds.length
    && attestation.managedServerIds.every((serverId, index) => serverId === serverIds[index]);
}

export async function readManagedMachineIdentities(
  slockHome: string,
  serverIds: string[],
): Promise<Record<string, string>> {
  const entries = await Promise.all(serverIds.map(async (serverId) => {
    const attachment = await readServerAttachment(slockHome, serverId);
    return [serverId, attachment?.serverMachineId] as const;
  }));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] =>
    typeof entry[1] === "string" && entry[1].length > 0));
}

export async function waitForCurrentMachineGeneration(
  slockHome: string,
  revisionSeed: string,
): Promise<MachineConvergenceAttestation | null> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const service = await readMachineServiceAttestation(slockHome);
    const managed = await currentManagedProcesses(slockHome);
    if (service
      && service.computerVersion === COMPUTER_VERSION
      && service.sourceServicePid !== undefined
      && service.servicePid !== service.sourceServicePid
      && !isProcessAlive(service.sourceServicePid)
      && sameManagedSet(service, managed.serverIds)
      && managed.runners.every(({ pid, version, evidencePid }) => pid !== null
        && isProcessAlive(pid)
        && evidencePid === pid
        && version === COMPUTER_VERSION)) {
      return {
        serviceGeneration: service.serviceGeneration,
        managedSetRevision: `${revisionSeed}:${service.managedSetRevision}`,
        deadProcessIdentities: [`service:${service.sourceServicePid}`],
      };
    }
    await sleep(250);
  }
  return null;
}

export async function waitForRestartConvergence(
  slockHome: string,
  marker: PendingRestartMarker | null,
): Promise<MachineConvergenceAttestation | null> {
  if (!marker?.oldServicePid || !marker.oldRunnerPids || !marker.acceptedManagedServerIds) return null;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const service = await readMachineServiceAttestation(slockHome);
    const managed = await currentManagedProcesses(slockHome);
    const servicePid = await readPidfileAt(servicePidPath(slockHome));
    const serviceEvidence = await readProcessVersionEvidence(serviceVersionPath(slockHome));
    if (service
      && service.computerVersion === COMPUTER_VERSION
      && service.sourceServicePid === marker.oldServicePid
      && !isProcessAlive(marker.oldServicePid)
      && Object.values(marker.oldRunnerPids).every((pid) => !isProcessAlive(pid))
      && sameManagedSet(service, managed.serverIds)
      && marker.acceptedManagedServerIds.every((serverId) => managed.serverIds.includes(serverId))
      && servicePid === service.servicePid
      && serviceEvidence?.pid === service.servicePid
      && managed.runners.every(({ pid, version, evidencePid }) => pid !== null
        && isProcessAlive(pid)
        && evidencePid === pid
        && version === COMPUTER_VERSION)) {
      return {
        serviceGeneration: service.serviceGeneration,
        managedSetRevision: `${marker.startedAt}:${service.managedSetRevision}`,
        deadProcessIdentities: [
          `service:${marker.oldServicePid}`,
          ...Object.entries(marker.oldRunnerPids).map(([serverId, pid]) => `runner:${serverId}:${pid}`),
        ],
      };
    }
    await sleep(250);
  }
  return null;
}

export function createMachineAttestationHandler(
  slockHome: string,
  sourceServicePid?: number,
): () => Promise<MachineServiceAttestation> {
  const serviceGeneration = randomUUID();
  const serviceStartedAt = currentDate().toISOString();
  return async () => {
    const managedServerIds = (await listManagedServerIds(slockHome)).sort();
    const managedMachineIdentities = await readManagedMachineIdentities(slockHome, managedServerIds);
    return {
      computerVersion: COMPUTER_VERSION,
      serviceGeneration,
      servicePid: process.pid,
      serviceExecutablePath: process.execPath,
      ...(sourceServicePid !== undefined ? { sourceServicePid } : {}),
      managedServerIds,
      managedMachineIdentities,
      managedSetRevision: `${serviceStartedAt}:${managedServerIds.join(",")}`,
    };
  };
}

export async function resolveSourceServicePid(
  slockHome: string,
  explicitSourcePidRaw: string | undefined,
): Promise<number | undefined> {
  const pendingRestart = await readPendingRestartMarker(slockHome);
  const explicitSourcePid = Number.parseInt(explicitSourcePidRaw ?? "", 10);
  return pendingRestart?.oldServicePid
    ?? (Number.isSafeInteger(explicitSourcePid) && explicitSourcePid > 0 ? explicitSourcePid : undefined);
}
