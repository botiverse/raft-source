import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { currentDate, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import { isProcessAlive, readPidfileAt } from "./internal/process-primitives.js";
import { rotateLogIfNeeded } from "./logRotation.js";
import { resolveRaftHome, serviceLogPath, servicePidPath, serviceVersionPath } from "./paths.js";
import { readProcessVersionEvidence, type ProcessVersionEvidence } from "./versionEvidence.js";
import { machineOperationStore, reduceDurableMachineOperation } from "./machineOperationRuntime.js";
import { connectService } from "./lib/ipc-client.js";
import type { MachineServiceAttestation } from "./lib/types.js";

const require = createRequire(import.meta.url);
const POLL_MS = 100;
const EXIT_TIMEOUT_MS = 60_000;
const DURABLE_OPERATION_TIMEOUT_MS = 15 * 60_000;
type TakeoverRole = "coordinator" | "standby";

function takeoverLeasePath(slockHome: string): string {
  return `${servicePidPath(slockHome)}.machine-takeover`;
}
function armedPath(slockHome: string): string {
  return `${takeoverLeasePath(slockHome)}.armed`;
}
function promotionPath(slockHome: string): string {
  return `${takeoverLeasePath(slockHome)}.promotion`;
}

function isSea(): boolean {
  try {
    return (require("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

function selfCommand(args: string[]): { command: string; args: string[] } {
  return isSea()
    ? { command: process.execPath, args: [...process.execArgv, ...args] }
    : { command: process.execPath, args: [...process.execArgv, process.argv[1] ?? "", ...args] };
}

function spawnLeg(
  role: TakeoverRole,
  slockHome: string,
  oldServicePid: number,
  targetVersion: string,
  logFd: number,
  operationId?: string,
): number {
  const command = selfCommand([
    "__legacy-supervisor-takeover",
    role,
    String(oldServicePid),
    targetVersion,
    ...(operationId ? [operationId] : []),
  ]);
  const child = spawn(command.command, command.args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: { ...process.env, RAFT_HOME: slockHome },
  });
  if (!child.pid) throw new Error(`UPGRADE_SUPERVISOR_TAKEOVER_${role.toUpperCase()}_SPAWN_FAILED`);
  child.unref();
  return child.pid;
}

export async function spawnLegacySupervisorTakeover(
  slockHome: string,
  oldServicePid: number,
  targetVersion: string,
  operationId?: string,
): Promise<void> {
  const leasePath = takeoverLeasePath(slockHome);
  try {
    const existing = JSON.parse(await readFile(leasePath, "utf8")) as {
      coordinatorPid?: unknown;
      standbyPid?: unknown;
    };
    if (typeof existing.coordinatorPid === "number"
      && typeof existing.standbyPid === "number"
      && isProcessAlive(existing.coordinatorPid)
      && isProcessAlive(existing.standbyPid)) return;
    await Promise.all([
      rm(leasePath, { force: true }),
      rm(armedPath(slockHome), { force: true }),
      rm(promotionPath(slockHome), { force: true }),
    ]);
  } catch {
    // No complete live handoff pair.
  }

  let lease: FileHandle;
  try {
    lease = await open(leasePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  let log: FileHandle | null = null;
  let spawned = false;
  try {
    await rotateLogIfNeeded(serviceLogPath(slockHome));
    log = await open(serviceLogPath(slockHome), "a");
    // Both independent target-binary legs exist before the source service is
    // allowed to receive SIGTERM. The coordinator verifies the standby's
    // durable armed receipt; the standby can take promotion if its peer dies.
    const coordinatorPid = spawnLeg("coordinator", slockHome, oldServicePid, targetVersion, log.fd, operationId);
    const standbyPid = spawnLeg("standby", slockHome, oldServicePid, targetVersion, log.fd, operationId);
    await lease.writeFile(`${JSON.stringify({
      oldServicePid,
      targetVersion,
      coordinatorPid,
      standbyPid,
      operationId,
    })}\n`, "utf8");
    await lease.sync();
    spawned = true;
  } finally {
    await log?.close().catch(() => {});
    await lease.close().catch(() => {});
    if (!spawned) await rm(leasePath, { force: true }).catch(() => {});
  }
}

export interface LegacySupervisorTakeoverDeps {
  processPid?: number;
  readServicePid?: (path: string) => Promise<number | null>;
  alive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  spawnService?: (slockHome: string) => Promise<number>;
  now?: () => number;
  readServiceEvidence?: (path: string) => Promise<ProcessVersionEvidence | null>;
  readServiceAttestation?: (slockHome: string) => Promise<MachineServiceAttestation | null>;
}

async function readPair(slockHome: string): Promise<{ coordinatorPid: number; standbyPid: number } | null> {
  try {
    const parsed = JSON.parse(await readFile(takeoverLeasePath(slockHome), "utf8")) as {
      coordinatorPid?: unknown;
      standbyPid?: unknown;
    };
    return typeof parsed.coordinatorPid === "number" && typeof parsed.standbyPid === "number"
      ? { coordinatorPid: parsed.coordinatorPid, standbyPid: parsed.standbyPid }
      : null;
  } catch {
    return null;
  }
}

async function claimPromotion(
  slockHome: string,
  alive: (pid: number) => boolean,
  claimantPid: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(promotionPath(slockHome), "wx", 0o600);
      try {
        await handle.writeFile(`${claimantPid}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const holder = Number((await readFile(promotionPath(slockHome), "utf8")).trim());
        if (Number.isSafeInteger(holder) && holder > 0 && alive(holder)) return holder === claimantPid;
      } catch {
        // Recover invalid/dead promotion evidence.
      }
      await rm(promotionPath(slockHome), { force: true });
    }
  }
  return false;
}

async function readServiceAttestation(slockHome: string): Promise<MachineServiceAttestation | null> {
  try {
    const client = await connectService(slockHome);
    try {
      return await client.request("machine-attestation", undefined);
    } finally {
      await client.close();
    }
  } catch {
    return null;
  }
}

export async function runLegacySupervisorTakeover(
  role: TakeoverRole,
  oldServicePid: number,
  targetVersion: string,
  operationId?: string,
  slockHome = resolveRaftHome(),
  deps: LegacySupervisorTakeoverDeps = {},
): Promise<void> {
  const readPid = deps.readServicePid ?? readPidfileAt;
  const actorPid = deps.processPid ?? process.pid;
  const alive = deps.alive ?? isProcessAlive;
  const kill = deps.kill ?? process.kill;
  const readEvidence = deps.readServiceEvidence ?? readProcessVersionEvidence;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setClockTimeout(resolve, ms); }));
  const now = deps.now ?? currentTimeMs;
  const deadline = now() + (operationId ? DURABLE_OPERATION_TIMEOUT_MS : EXIT_TIMEOUT_MS);
  const attest = deps.readServiceAttestation ?? readServiceAttestation;
  const spawnService = deps.spawnService ?? (async (home: string) => {
    const { spawnDetachedService } = await import("./service.js");
    return spawnDetachedService(home, {
      parentMutationLockHeld: false,
      sourceServicePid: oldServicePid,
    });
  });

  if (role === "standby") {
    await writeFile(armedPath(slockHome), `${JSON.stringify({
      pid: actorPid,
      oldServicePid,
      targetVersion,
      armedAt: currentDate().toISOString(),
    })}\n`, { mode: 0o600 });
  }
  if (operationId) {
    await reduceDurableMachineOperation(slockHome, operationId, {
      kind: "arm_leg",
      role,
      process: {
        pid: actorPid,
        startIdentity: `${currentTimeMs()}:${actorPid}`,
        role,
        version: targetVersion,
      },
    });
  }

  let spawnedPid: number | null = null;
  let completed = false;
  try {
    while (now() < deadline) {
      let record = operationId ? await machineOperationStore(slockHome, operationId).load() : null;
      if (record?.phase === "receipt_observed" || record?.phase === "finalized") {
        completed = true;
        return;
      }
      let pair = await readPair(slockHome);
      const sourceAlive = alive(oldServicePid);
      if (!pair && sourceAlive) {
        await sleep(POLL_MS);
        continue;
      }

      if (pair && role === "standby" && !alive(pair.coordinatorPid) && sourceAlive) {
        if (operationId) {
          const record = await machineOperationStore(slockHome, operationId).load();
          if (record?.coordinator?.pid === pair.coordinatorPid) {
            await reduceDurableMachineOperation(slockHome, operationId, {
              kind: "leg_crashed",
              role: "coordinator",
              process: record.coordinator,
            });
          }
        }
        const log = await open(serviceLogPath(slockHome), "a");
        try {
          const coordinatorPid = spawnLeg("coordinator", slockHome, oldServicePid, targetVersion, log.fd, operationId);
          pair = { ...pair, coordinatorPid };
          await writeFile(takeoverLeasePath(slockHome), `${JSON.stringify({
            oldServicePid,
            targetVersion,
            ...pair,
          })}\n`, { mode: 0o600 });
        } finally {
          await log.close();
        }
        await sleep(POLL_MS);
        continue;
      }

      if (pair && role === "coordinator" && sourceAlive) {
        if (!alive(pair.standbyPid)) {
          if (operationId) {
            const record = await machineOperationStore(slockHome, operationId).load();
            if (record?.standby?.pid === pair.standbyPid) {
              await reduceDurableMachineOperation(slockHome, operationId, {
                kind: "leg_crashed",
                role: "standby",
                process: record.standby,
              });
            }
          }
          const log = await open(serviceLogPath(slockHome), "a");
          try {
            const standbyPid = spawnLeg("standby", slockHome, oldServicePid, targetVersion, log.fd, operationId);
            pair = { ...pair, standbyPid };
            await writeFile(takeoverLeasePath(slockHome), `${JSON.stringify({
              oldServicePid,
              targetVersion,
              ...pair,
            })}\n`, { mode: 0o600 });
          } finally {
            await log.close();
          }
        }
        let standbyArmed = false;
        try {
          const armed = JSON.parse(await readFile(armedPath(slockHome), "utf8")) as { pid?: unknown };
          standbyArmed = armed.pid === pair.standbyPid && alive(pair.standbyPid);
        } catch {
          standbyArmed = false;
        }
        if (standbyArmed && operationId) {
          standbyArmed = record?.phase === "handoff_armed";
        }
        if (!standbyArmed) {
          // Never stop the source with only one surviving target leg.
          await sleep(POLL_MS);
          continue;
        }
      } else if (pair && role === "standby" && alive(pair.coordinatorPid) && sourceAlive) {
        await sleep(POLL_MS);
        continue;
      }

      // The durable promotion file is also the cross-leg spawn claim. A leg
      // that does not own it may watch/recover its peer, but must never create
      // a target service from its process-local spawnedPid state.
      if (!await claimPromotion(slockHome, alive, actorPid)) {
        await sleep(POLL_MS);
        continue;
      }

      if (sourceAlive) {
        // Recheck the other target leg immediately before the irreversible
        // signal. This closes the armed-then-died race.
        if (!pair) {
          await sleep(POLL_MS);
          continue;
        }
        const peerPid = role === "coordinator" ? pair.standbyPid : pair.coordinatorPid;
        if (role === "coordinator" && !alive(peerPid)) {
          await rm(promotionPath(slockHome), { force: true });
          await sleep(POLL_MS);
          continue;
        }
        if (operationId) {
          const source = record?.acceptance.capturedOldProcessIdentities.find((process) =>
            process.role === "service" && process.pid === oldServicePid
          );
          if (!source) throw new Error("SOURCE_SERVICE_IDENTITY_MISSING");
          if (record?.phase === "handoff_armed") {
            const reduced = await reduceDurableMachineOperation(slockHome, operationId, {
              kind: "request_old_service_stop",
              source,
            });
            if (reduced.kind === "rejected") throw new Error(reduced.code);
          }
        }
        kill(oldServicePid, "SIGTERM");
        await sleep(POLL_MS);
        continue;
      }

      if (operationId) {
        const source = record?.acceptance.capturedOldProcessIdentities.find((process) =>
          process.role === "service" && process.pid === oldServicePid
        );
        if (!source) throw new Error("SOURCE_SERVICE_IDENTITY_MISSING");
        if (record?.phase === "old_service_stop_claimed") {
          await reduceDurableMachineOperation(slockHome, operationId, { kind: "old_service_dead", source });
          record = await machineOperationStore(slockHome, operationId).load();
        }
      }

      const currentPid = await readPid(servicePidPath(slockHome));
      if (currentPid !== null && alive(currentPid)) {
        const evidence = await readEvidence(serviceVersionPath(slockHome));
        if (evidence?.pid === currentPid && evidence.version === targetVersion) {
          const liveAttestation = await attest(slockHome);
          if (!liveAttestation
            || liveAttestation.computerVersion !== targetVersion
            || liveAttestation.servicePid !== currentPid) {
            await sleep(POLL_MS);
            continue;
          }
          if (operationId) {
            record = await machineOperationStore(slockHome, operationId).load();
            if (record?.targetSupervisor && (
              record.targetSupervisor.pid !== currentPid
              || record.targetSupervisor.startIdentity !== evidence.writtenAt
              || record.observedTargetGeneration !== liveAttestation.serviceGeneration
            )) {
              await reduceDurableMachineOperation(slockHome, operationId, {
                kind: "leg_crashed",
                role: "target_supervisor",
                process: record.targetSupervisor,
              });
              record = await machineOperationStore(slockHome, operationId).load();
            }
            if (record?.phase === "old_service_dead" && !record.observedTargetGeneration) {
              await reduceDurableMachineOperation(slockHome, operationId, {
                kind: "target_generation_allocated",
                generation: liveAttestation.serviceGeneration,
              });
              record = await machineOperationStore(slockHome, operationId).load();
            }
            if (record?.phase === "old_service_dead"
              && record.observedTargetGeneration === liveAttestation.serviceGeneration) {
              await reduceDurableMachineOperation(slockHome, operationId, {
                kind: "target_supervisor_live",
                generation: liveAttestation.serviceGeneration,
                process: {
                  pid: currentPid,
                  startIdentity: evidence.writtenAt,
                  role: "service",
                  version: targetVersion,
                },
              });
            }
          } else {
            completed = true;
            return;
          }
          // A machine operation is not safe merely because the target service
          // became live once. Keep the takeover actor resident through
          // managed-set convergence and until the Server receipt is durable.
          await sleep(POLL_MS);
          continue;
        }
        // spawnDetachedService writes service.pid before the child finishes
        // startup and writes its version evidence. Missing evidence, or stale
        // evidence for another pid, says nothing about this live process. Only
        // an attested version mismatch for the current pid is safe to kill.
        if (!evidence || evidence.pid !== currentPid) {
          await sleep(POLL_MS);
          continue;
        }
        kill(currentPid, "SIGTERM");
        await sleep(POLL_MS);
        continue;
      }
      if (operationId && record?.targetSupervisor) {
        await reduceDurableMachineOperation(slockHome, operationId, {
          kind: "leg_crashed",
          role: "target_supervisor",
          process: record.targetSupervisor,
        });
      }
      if (spawnedPid === null || !alive(spawnedPid)) {
        spawnedPid = await spawnService(slockHome);
      }
      await sleep(POLL_MS);
    }
    throw new Error(`UPGRADE_SUPERVISOR_TAKEOVER_TIMEOUT:${oldServicePid}:${role}`);
  } finally {
    if (completed) {
      await Promise.all([
        rm(takeoverLeasePath(slockHome), { force: true }),
        rm(armedPath(slockHome), { force: true }),
        rm(promotionPath(slockHome), { force: true }),
      ]);
    }
  }
}
