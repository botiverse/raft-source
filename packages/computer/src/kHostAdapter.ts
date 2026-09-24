// kHostAdapter — Computer's implementation of the K (@botiverse/k-carrier)
// HostAdapter boundary (#wg-k task #2, fork-A).
//
// K orchestrates the upgrade transaction (two-slot promote/rollback, journal,
// convergence read-back) and calls ONLY this surface; Computer implements it
// with its existing lifecycle primitives. The adapter must never reach into
// K internals, and K never sees Computer internals.
//
// Fork-A semantics (xxchan 2026-08-12): quiesce/resume prove equivalence at
// the PROCESS/SERVICE layer — the managed-server set and machine identities
// a service parks are exactly what the successor serves — NOT byte-level
// agent-session preservation. Runners are re-spawned by the successor;
// making agent sessions survive ANY restart is a separate Computer
// durability track, deliberately not smuggled in here.
//
// Contract notes carried over from the K side (hostAdapter.ts):
//  - healthProbe() evidence must be ANSWERED BY the live process (IPC), never
//    assembled from files or caches: version/pid/startId all come from one
//    `machine-attestation` response over the service socket, and
//    `serviceGeneration` (a per-start UUID) is the incarnation startId.
//  - start() waits only for socket reachability. It never proves target
//    version/incarnation correctness; healthProbe() remains that sole judge.
//    World-state failures return quietly so K can enter its rollback path.
//  - resume() must also hold after ROLLBACK: the parked-set comparison is
//    version-agnostic on purpose — whichever binary answers, it must serve
//    the set that was parked.
import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import type {
  HostAdapter,
  ProcessEvidence,
  Slot,
} from "@botiverse/k-carrier";
import { currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import { connectService } from "./lib/ipc-client.js";
import { stop as stopService } from "./services/stop.js";
import { ComputerServiceError } from "./services/errors.js";
import { listManagedServerIds } from "./serverState.js";
import { readManagedMachineIdentities } from "./machineServiceAttestation.js";
import { isProcessAlive } from "./internal/process-primitives.js";
import { writeDurableTextFile } from "./durableFile.js";
import { PARENT_LOCK_HELD_ENV_VAR } from "./runnerChildEnv.js";
import { refreshHostLifecycleWithinDeadline } from "./kHostLifecycleRefresh.js";
import {
  kParkedSnapshotPath,
  kRunnerHoldPath,
  kSlotBinaryPath,
  kStateDir,
} from "./kPaths.js";
export { kParkedSnapshotPath, kRunnerHoldPath, kSlotBinaryPath, kStateDir } from "./kPaths.js";
export type KSlot = Slot;
export type KProcessEvidence = ProcessEvidence;
export type KHostAdapter = HostAdapter;

// --- deps seam --------------------------------------------------------------

export interface KHostAdapterDeps {
  connectServiceFn?: typeof connectService;
  stopServiceFn?: typeof stopService;
  listManagedServerIdsFn?: typeof listManagedServerIds;
  readManagedMachineIdentitiesFn?: typeof readManagedMachineIdentities;
  /** Spawn the resident service detached from the given binary. Returns the
   *  child pid or null if unknown. Default: `spawn(binary, ["__service"])`
   *  detached — the SEA-binary invocation shape. */
  spawnSlotServiceFn?: (slockHome: string, binaryPath: string) => Promise<number | null>;
  resolveSlotBinaryFn?: typeof kSlotBinaryPath;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** resume() readiness deadline. Service cold start is seconds, not minutes. */
  resumeTimeoutMs?: number;
  /** resume() poll interval while the successor comes up. */
  resumePollIntervalMs?: number;
  /** start() reachability deadline (see start()'s contract note). */
  startReadyTimeoutMs?: number;
  /** start() poll interval while the spawned service boots. */
  startReadyPollIntervalMs?: number;
  isProcessAliveFn?: (pid: number) => boolean;
  readTextFileFn?: (path: string) => Promise<string>;
  writeDurableTextFileFn?: (path: string, value: string) => Promise<void>;
  removeFileFn?: (path: string) => Promise<void>;
  refreshHostLifecycleFn?: typeof refreshHostLifecycleWithinDeadline;
}
interface ParkedSnapshot {
  managedServerIds: string[]; // sorted
  managedMachineIdentities: Record<string, string>;
}

function identitiesComplete(serverIds: string[], identities: Record<string, string>): boolean {
  if (new Set(serverIds).size !== serverIds.length) return false;
  const identityIds = Object.keys(identities);
  if (identityIds.length !== serverIds.length) return false;
  return (
    serverIds.every((serverId) => typeof identities[serverId] === "string" && identities[serverId].length > 0)
    && identityIds.every((serverId) => serverIds.includes(serverId))
  );
}

function sameManagedSet(a: ParkedSnapshot, b: ParkedSnapshot): boolean {
  return (
    a.managedServerIds.length === b.managedServerIds.length
    && a.managedServerIds.every((serverId, i) => serverId === b.managedServerIds[i])
    && a.managedServerIds.every(
      (serverId) => a.managedMachineIdentities[serverId] === b.managedMachineIdentities[serverId],
    )
  );
}

function serializeParkedSnapshot(snapshot: ParkedSnapshot): string {
  const managedServerIds = [...snapshot.managedServerIds].sort();
  const managedMachineIdentities = Object.fromEntries(
    managedServerIds.map((serverId) => [serverId, snapshot.managedMachineIdentities[serverId]]),
  );
  return `${JSON.stringify({ formatVersion: 1, managedServerIds, managedMachineIdentities })}\n`;
}

function parseParkedSnapshot(raw: string): ParkedSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as {
      formatVersion?: unknown;
      managedServerIds?: unknown;
      managedMachineIdentities?: unknown;
    };
    if (
      parsed.formatVersion !== 1
      || !Array.isArray(parsed.managedServerIds)
      || parsed.managedServerIds.some((value) => typeof value !== "string" || value.length === 0)
      || typeof parsed.managedMachineIdentities !== "object"
      || parsed.managedMachineIdentities === null
      || Array.isArray(parsed.managedMachineIdentities)
    ) {
      return null;
    }
    const managedServerIds = parsed.managedServerIds as string[];
    const managedMachineIdentities = parsed.managedMachineIdentities as Record<string, string>;
    const sorted = [...managedServerIds].sort();
    if (managedServerIds.some((serverId, index) => serverId !== sorted[index])) return null;
    if (!identitiesComplete(managedServerIds, managedMachineIdentities)) return null;
    return { managedServerIds, managedMachineIdentities };
  } catch {
    return null;
  }
}

async function defaultSpawnSlotService(slockHome: string, binaryPath: string): Promise<number | null> {
  const child = spawn(binaryPath, ["__service"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      SLOCK_HOME: slockHome,
      // The detached K coordinator owns Computer's mutation lock until the
      // transaction settles; startup cleanup must not reclaim that live lock.
      [PARENT_LOCK_HELD_ENV_VAR]: "1",
    },
  });
  // Spawn success is not target correctness. A post-detach error surfaces as
  // an unreachable socket; start() waits boundedly and healthProbe judges it.
  child.on("error", () => {});
  const pid = child.pid ?? null;
  child.unref();
  return pid;
}

// --- adapter ----------------------------------------------------------------

export function createKHostAdapter(slockHome: string, deps: KHostAdapterDeps = {}): KHostAdapter {
  const connect = deps.connectServiceFn ?? connectService;
  const stopFn = deps.stopServiceFn ?? stopService;
  const listManaged = deps.listManagedServerIdsFn ?? listManagedServerIds;
  const readIdentities = deps.readManagedMachineIdentitiesFn ?? readManagedMachineIdentities;
  const spawnSlot = deps.spawnSlotServiceFn ?? defaultSpawnSlotService;
  const resolveSlotBinary = deps.resolveSlotBinaryFn ?? kSlotBinaryPath;
  const now = deps.now ?? currentTimeMs;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    setClockTimeout(resolve, ms);
  }));
  const resumeTimeoutMs = deps.resumeTimeoutMs ?? 30_000;
  const resumePollIntervalMs = deps.resumePollIntervalMs ?? 250;
  const startReadyTimeoutMs = deps.startReadyTimeoutMs ?? 30_000;
  const startReadyPollIntervalMs = deps.startReadyPollIntervalMs ?? 100;
  const isAlive = deps.isProcessAliveFn ?? isProcessAlive;
  const readText = deps.readTextFileFn ?? ((filePath: string) => readFile(filePath, "utf8"));
  const writeDurable = deps.writeDurableTextFileFn ?? writeDurableTextFile;
  const removeFile = deps.removeFileFn ?? ((filePath: string) => rm(filePath, { force: true }));

  // In-memory cache of the durable park record. quiesce() commits the exact
  // managed set before K may stop the service; a successor driver reloads it
  // after a crash. The file is intentionally retained after resume: K has no
  // host-adapter commit hook, and deleting it before K journals its next phase
  // would recreate the same crash window this record closes. The next
  // transaction's quiesce() atomically replaces it.
  let parked: ParkedSnapshot | null = null;
  // Whether the most recent start() actually reached a live service.
  // "silent" = empty slot / crashed child / never answered — resume() then
  // has no successor to verify against and must not wait for one.
  let lastStart: "reached" | "silent" | null = null;

  async function readManagedSnapshot(): Promise<ParkedSnapshot> {
    const managedServerIds = (await listManaged(slockHome)).sort();
    const managedMachineIdentities = await readIdentities(slockHome, managedServerIds);
    return { managedServerIds, managedMachineIdentities };
  }

  async function loadDurableParkedSnapshot(): Promise<ParkedSnapshot> {
    let raw: string;
    try {
      raw = await readText(kParkedSnapshotPath(slockHome));
    } catch (error) {
      throw new ComputerServiceError(
        "K_HOST_PARK_SNAPSHOT_UNAVAILABLE",
        "K_HOST_PARK_SNAPSHOT_UNAVAILABLE: the exact quiesced managed set is not readable; refusing to resume against an unbound complete set",
        error,
      );
    }
    const snapshot = parseParkedSnapshot(raw);
    if (snapshot === null) {
      throw new ComputerServiceError(
        "K_HOST_PARK_SNAPSHOT_UNAVAILABLE",
        "K_HOST_PARK_SNAPSHOT_UNAVAILABLE: the exact quiesced managed set is malformed; refusing to resume against an unbound complete set",
      );
    }
    return snapshot;
  }

  async function probeOnce(): Promise<KProcessEvidence> {
    const client = await connect(slockHome);
    try {
      const attestation = await client.request("machine-attestation", undefined);
      return {
        version: attestation.computerVersion,
        pid: attestation.servicePid,
        startId: attestation.serviceGeneration,
      };
    } finally {
      await client.close();
    }
  }

  async function attestedManagedSnapshot(): Promise<ParkedSnapshot | null> {
    let client: Awaited<ReturnType<typeof connectService>>;
    try {
      client = await connect(slockHome);
    } catch {
      return null; // not up yet — resume() keeps polling
    }
    try {
      const attestation = await client.request("machine-attestation", undefined);
      return {
        managedServerIds: [...attestation.managedServerIds].sort(),
        managedMachineIdentities: attestation.managedMachineIdentities ?? {},
      };
    } catch {
      return null;
    } finally {
      await client.close();
    }
  }

  return {
    async quiesce() {
      // Park = durably pin the exact managed set the successor must serve.
      // Persistence happens before the in-memory cache is published and
      // before K may proceed to stop: a failed write cannot become a handoff.
      // Idempotent: re-reading and atomically replacing the same set is safe.
      const snapshot = await readManagedSnapshot();
      if (!identitiesComplete(snapshot.managedServerIds, snapshot.managedMachineIdentities)) {
        throw new ComputerServiceError(
          "K_HOST_QUIESCE_INCOMPLETE",
          "K_HOST_QUIESCE_INCOMPLETE: managed machine-identity snapshot is incomplete; refusing to hand off an upgrade that could strand a managed server",
        );
      }
      try {
        await writeDurable(kParkedSnapshotPath(slockHome), serializeParkedSnapshot(snapshot));
        await writeDurable(
          kRunnerHoldPath(slockHome),
          `${JSON.stringify({ formatVersion: 1, held: true })}\n`,
        );
      } catch (error) {
        throw new ComputerServiceError(
          "K_HOST_PARK_PERSIST_FAILED",
          "K_HOST_PARK_PERSIST_FAILED: the exact quiesced managed set was not durably committed; refusing to stop the service",
          error,
        );
      }
      parked = snapshot;
    },

    async stop(_slot: KSlot) {
      // Computer has ONE resident service; the slot names which bytes K
      // believes are running, but the stop mechanism is slot-agnostic:
      // graceful SIGTERM + wait-for-exit. The service's own shutdown path is
      // what winds down runners (fork-A: they re-spawn under the successor).
      // stopService is idempotent (not_running / stale pidfile are success).
      await stopFn({ slockHome });
    },

    async start(slot: KSlot) {
      // start() NEVER throws for world-state failures — it asks, waits
      // best-effort, and returns; the PROBE is the sole judge. This is K's
      // reference-adapter shape, and both halves are load-bearing:
      //  - the engine probes ONCE right after start() returns, and a probe
      //    FAILURE is what triggers the tidy rollback ("experiment probe
      //    failed" → rolled-back). A start() that throws instead crashes
      //    the transaction out of that path (found live: the crash-on-start
      //    acceptance teeth red-ed on exactly this).
      //  - rollback's own start("stable") on a fresh world (empty stable
      //    slot) must return quietly — there is nothing to restore, and
      //    rolled-back-with-nothing-running is that world's honest end state.
      const binaryPath = resolveSlotBinary(slockHome, slot);
      lastStart = "silent";
      try {
        await access(binaryPath);
      } catch {
        return; // empty slot: nothing to ask for; the probe will refuse
      }
      const pid = await spawnSlot(slockHome, binaryPath);
      // Wait for REACHABILITY, not health: any answer on the socket ends the
      // wait; WHAT was answered (version/incarnation/predicates) stays
      // healthProbe/readback's judgment. A dead child or a passed deadline
      // ends the wait too — quietly, so the probe delivers that verdict.
      const deadline = now() + startReadyTimeoutMs;
      for (;;) {
        try {
          await probeOnce();
          lastStart = "reached";
          return;
        } catch {
          // not answering yet
        }
        if (pid !== null && !isAlive(pid)) return; // crashed before answering
        if (now() >= deadline) return; // alive but never answered
        await sleep(startReadyPollIntervalMs);
      }
    },

    async healthProbe() {
      try {
        return await probeOnce();
      } catch (error) {
        throw new ComputerServiceError(
          "K_HOST_PROBE_UNAVAILABLE",
          "K_HOST_PROBE_UNAVAILABLE: no live service answered the attestation probe; evidence cannot be assembled from files",
          error,
        );
      }
    },

    async resume() {
      // Nothing was started (empty slot on a fresh-world rollback, or the
      // successor died before answering): there is no service to resume
      // workloads onto, and the parked set stays durably parked on disk.
      // Waiting here would turn K's tidy rolled-back end state into a
      // timeout (found live by the release-knob acceptance tooth).
      if (lastStart === "silent") return;
      // Crash-recovery path: reload the exact pre-stop intent. Merely proving
      // that a successor serves some complete set is insufficient — it could
      // be complete and still differ from the set quiesce() committed.
      parked ??= await loadDurableParkedSnapshot();
      // Releasing this HostAdapter-owned barrier is what lets the successor
      // service spawn the parked runners. K still owns the transaction and
      // will not promote until the exact managed set appears in attestation.
      try {
        await removeFile(kRunnerHoldPath(slockHome));
      } catch (error) {
        throw new ComputerServiceError(
          "K_HOST_RESUME_RELEASE_FAILED",
          "K_HOST_RESUME_RELEASE_FAILED: runner hold could not be released; refusing to report resumed workloads",
          error,
        );
      }
      // Ready = a live service answers over IPC AND serves the parked
      // managed set. Version-agnostic on purpose: after a rollback the
      // OLD binary must pass this gate with the SAME parked set.
      const deadline = now() + resumeTimeoutMs;
      let lastDiverged = false;
      do {
        const attested = await attestedManagedSnapshot();
        if (attested) {
          if (sameManagedSet(parked, attested)) {
            return (deps.refreshHostLifecycleFn ?? refreshHostLifecycleWithinDeadline)(slockHome, deadline, { now });
          } else {
            lastDiverged = true;
          }
        }
        await sleep(resumePollIntervalMs);
      } while (now() < deadline);
      throw new ComputerServiceError(
        lastDiverged ? "K_HOST_RESUME_DIVERGED" : "K_HOST_RESUME_TIMEOUT",
        lastDiverged
          ? "K_HOST_RESUME_DIVERGED: a service answered but did not serve the parked managed set before the deadline"
          : "K_HOST_RESUME_TIMEOUT: no live service answered the attestation probe before the deadline",
      );
    },
  };
}
