import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, writeFile, rm, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { runNamedCase } from "./test/runNamedCase.js";

import { clearPidfileAt, isProcessAlive, readPidfileAt } from "./internal/process-primitives.js";
import {
  buildDetachedServiceEnv,
  buildRunnerChildEnv,
  buildResidentSpawn,
  checkServiceControlAvailability,
  requestServiceUpgradeViaIpc,
  requestServiceSelfRestartAfterUpgrade,
  runResident,
  runService,
  runServiceStartupRecovery,
  OS_SUPERVISOR_KIND_ENV_VAR,
  PARENT_LOCK_HELD_ENV_VAR,
  RESIDENT_CLI_PATH_ENV_VAR,
  startServiceIpcSeam,
  resolveResidentSlockCliPath,
  type ServiceIpcMutations,
  handleRunnerExitForSupervisor,
} from "./service.js";
import { evaluateShutdownBarrier, shutdownService } from "./lib/serviceShutdown.js";
import { startServiceReconcileLoop } from "./serviceReconcileLoop.js";
import {
  clearResidentConnectedMarker,
  readResidentConnectedMarker,
  writeResidentConnectedMarker,
} from "./residentConnectionMarker.js";
import { runStart, runStop } from "./startStop.js";
import { stop as stopService } from "./services/stop.js";
import {
  adoptExternalRunnerPid,
  canSpawn,
  clearExternalRunnerPidIfDead,
  RUNNER_TRIGGER,
  type RunnerRecord,
} from "./lib/runnerStateMachine.js";
import { connectService } from "./lib/ipc-client.js";
import {
  computerDir,
  servicePidPath,
  serverAttachmentPath,
  serverConnectedMarkerPath,
  serverRunnerLogPath,
  serverRunnerPidPath,
  serverRunnerVersionPath,
  serverManagedFlagPath,
  serviceLogPath,
  serviceVersionPath,
} from "./paths.js";
import { stat } from "node:fs/promises";
import {
  isServerManaged,
  listManagedServerIds,
  setServerManaged,
} from "./serverState.js";
import { CliExit, formatHumanError } from "./output.js";
import { describeUpgradeStartRejection } from "./serviceUpgradeStart.js";
import { COMPUTER_VERSION } from "./version.js";
import { buildStatusReport } from "./status.js";
import { isDegraded, readCrashHistory } from "./health.js";
import { buildSystemdDiscoveryPath } from "./systemdDiscoveryPath.js";
import { withComputerMutationLock } from "./concurrency.js";
import { createMachineAttestationHandler } from "./machineServiceAttestation.js";
import { migrateLegacyOsSupervisorInstall } from "./legacyOsSupervisorMigration.js";
import type { KUpgradeCoordinatorRequest } from "./kUpgradeCoordinator.js";

// task #30 PR-G regression guard — service + per-server daemon
// primitives. Pins: pure pieces (argv, pidfile, liveness),
// per-server fail-closed paths (NO_ATTACHMENT / NOT_ATTACHED), and lifecycle
// isolation.

const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_B = "22222222-2222-4222-8222-222222222222";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-sup-"));
  const old = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (old === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = old;
    await rm(home, { recursive: true, force: true });
  }
}

function captureOut(): { restore: () => void; text: () => string } {
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  let buf = "";
  const sink = ((c: unknown) => { buf += String(c); return true; });
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  return { restore: () => { process.stdout.write = oo; process.stderr.write = oe; }, text: () => buf };
}

async function writeAttach(home: string, serverId: string): Promise<void> {
  const p = serverAttachmentPath(home, serverId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify({
    kind: "computer-attachment",
    serverId,
    serverMachineId: `cm-${serverId}`,
    apiKey: `sk_computer_${serverId}`,
    serverUrl: "https://api.example.test",
  }));
}

async function writeRunnerPid(home: string, serverId: string, pid = process.pid): Promise<void> {
  const p = serverRunnerPidPath(home, serverId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, String(pid), { mode: 0o600 });
}

async function writeReadyRunner(home: string, serverId: string, pid = process.pid): Promise<void> {
  await writeRunnerPid(home, serverId, pid);
  await writeFile(
    serverRunnerVersionPath(home, serverId),
    JSON.stringify({
      version: COMPUTER_VERSION,
      installRoot: "/current/raft-computer",
      pid,
      writtenAt: "2026-07-22T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  writeResidentConnectedMarker(serverConnectedMarkerPath(home, serverId), pid);
}

async function writeServiceVersion(home: string, pid = process.pid): Promise<void> {
  const p = serviceVersionPath(home);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(
    p,
    JSON.stringify({
      version: COMPUTER_VERSION,
      installRoot: "/current/raft-computer",
      pid,
      writtenAt: "2026-07-06T06:30:50.714Z",
    }),
    { mode: 0o600 },
  );
}

test("isProcessAlive: own pid alive, absurd/junk dead", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(999999999), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(Number.NaN), false);
});

test("readPidfileAt: missing → null, junk → null, valid → number", async () => {
  await withHome(async (home) => {
    assert.equal(await readPidfileAt(servicePidPath(home)), null);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), "nope");
    assert.equal(await readPidfileAt(servicePidPath(home)), null);
    await writeFile(servicePidPath(home), " 4242\n");
    assert.equal(await readPidfileAt(servicePidPath(home)), 4242);
  });
});

test("buildResidentSpawn: carries execArgv (tsx loader); __service vs __run <serverId>", () => {
  const sup = buildResidentSpawn("__service", null, "/abs/index.ts", ["--import", "tsx"]);
  assert.equal(sup.command, process.execPath);
  assert.deepEqual(sup.args, ["--import", "tsx", "/abs/index.ts", "__service"]);

  const run = buildResidentSpawn("__run", SERVER_A, "/abs/dist/index.js", []);
  assert.deepEqual(run.args, ["/abs/dist/index.js", "__run", SERVER_A]);
});

test("buildResidentSpawn: in a SEA binary, re-execs self with the mode flag and NO script entry", () => {
  // process.execPath IS the bundled app; argv[1] is a user arg, not a script —
  // passing it would corrupt the child argv. The mode flag is dispatched by the
  // commander __service/__run commands.
  const sup = buildResidentSpawn("__service", null, "/should/be/ignored", ["--import", "tsx"], true);
  assert.equal(sup.command, process.execPath);
  assert.deepEqual(sup.args, ["--import", "tsx", "__service"]);

  const run = buildResidentSpawn("__run", SERVER_A, process.argv[1] ?? "", [], true);
  assert.deepEqual(run.args, ["__run", SERVER_A]);
});

test("buildResidentSpawn: SEA uses the K-selected resident binary for service and runner children", () => {
  const stable = "/slock/computer/k/slots/stable/artifact.bin";
  const sup = buildResidentSpawn("__service", null, "/ignored", [], true, stable);
  const run = buildResidentSpawn("__run", SERVER_A, "/ignored", [], true, stable);

  assert.equal(sup.command, stable);
  assert.equal(run.command, stable);
  assert.deepEqual(sup.args, ["__service"]);
  assert.deepEqual(run.args, ["__run", SERVER_A]);
});

test("resident connection marker is PID-bound and only its owner can clear it", async () => {
  await withHome(async (home) => {
    const markerPath = serverConnectedMarkerPath(home, SERVER_A);
    await mkdir(dirname(markerPath), { recursive: true });

    writeResidentConnectedMarker(markerPath, process.pid + 1, 5678);
    assert.deepEqual(readResidentConnectedMarker(markerPath), { pid: process.pid + 1, connectedAt: 5678 });

    clearResidentConnectedMarker(markerPath);
    assert.equal(existsSync(markerPath), true, "a different process cannot clear the owner's marker");

    writeResidentConnectedMarker(markerPath, process.pid, 5678);
    clearResidentConnectedMarker(markerPath);
    assert.equal(existsSync(markerPath), false);
    assert.doesNotThrow(() => clearResidentConnectedMarker(markerPath));

    await writeFile(markerPath, String(Date.now()), { mode: 0o600 });
    assert.equal(readResidentConnectedMarker(markerPath), null, "legacy timestamp is not PID proof");
  });
});

test("supervisor exit cleanup cannot delete a successor connection marker", async () => {
  await withHome(async (home) => {
    const markerPath = serverConnectedMarkerPath(home, SERVER_A);
    const pidfilePath = serverRunnerPidPath(home, SERVER_A);
    await writeRunnerPid(home, SERVER_A, 1234);
    writeResidentConnectedMarker(markerPath, 1234, 5678);
    assert.deepEqual(readResidentConnectedMarker(markerPath), { pid: 1234, connectedAt: 5678 });

    const predecessorExitCleanup = clearPidfileAt(pidfilePath);
    writeResidentConnectedMarker(markerPath, 5678, 6789);
    await predecessorExitCleanup;
    assert.deepEqual(
      readResidentConnectedMarker(markerPath),
      { pid: 5678, connectedAt: 6789 },
      "predecessor exit cleanup must preserve the successor's evidence",
    );

  });
});

test("service installs periodic supervision after its deadline-bounded initial reconcile", async () => {
  let initialCompleted = false;
  let periodicInstalled = false;
  await startServiceReconcileLoop(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      initialCompleted = true;
    },
    () => {
      assert.equal(initialCompleted, true);
      periodicInstalled = true;
      return { unref: () => {} };
    },
  );
  assert.equal(periodicInstalled, true);
});

test("__run / runResident: loads THAT server's attachment, constructs core with its creds, starts it", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    let seenServerId = "";
    let seenApiKey = "";
    let started = false;
    await runResident(SERVER_A, {
      coreFactory: (creds) => {
        seenServerId = creds.serverId;
        seenApiKey = creds.apiKey;
        return { start: () => { started = true; }, stop: () => {} };
      },
    });
    assert.equal(seenServerId, SERVER_A);
    assert.equal(seenApiKey, `sk_computer_${SERVER_A}`);
    assert.equal(started, true);
    const versionEvidence = JSON.parse(await readFile(serverRunnerVersionPath(home, SERVER_A), "utf8"));
    assert.equal(versionEvidence.version, COMPUTER_VERSION);
    assert.equal(versionEvidence.pid, process.pid);
  });
});

test("__run / runResident: no attachment for that server → fail-closed NO_ATTACHMENT", async () => {
  await withHome(async () => {
    const cap = captureOut();
    try {
      await assert.rejects(
        () => runResident(SERVER_A, { coreFactory: () => ({ start: () => {}, stop: () => {} }) }),
        (e) => e instanceof CliExit,
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /NO_ATTACHMENT/);
  });
});

test("__run / runResident: lock-losing core leaves incumbent version evidence unchanged", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const evidencePath = serverRunnerVersionPath(home, SERVER_A);
    await mkdir(dirname(evidencePath), { recursive: true });
    const incumbent = {
      version: "1.0.2",
      installRoot: "/incumbent",
      pid: 4242,
      writtenAt: "2026-07-17T00:00:00.000Z",
    };
    const before = `${JSON.stringify(incumbent)}\n`;
    await writeFile(evidencePath, before, "utf8");

    await assert.rejects(
      () => runResident(SERVER_A, {
        coreFactory: () => ({
          start: async () => {
            throw new Error("LOCK_CONFLICT: another daemon owns the machine lock");
          },
          stop: () => {},
        }),
      }),
      /LOCK_CONFLICT/,
    );

    assert.equal(await readFile(evidencePath, "utf8"), before);
  });
});

test("evaluateShutdownBarrier blocks while an owned managed child is registered", () => {
  const runners = new Map<string, RunnerRecord>([
    [SERVER_A, {
      serverId: SERVER_A,
      lifecycle: "running",
      stopping: false,
      child: { kill() {} } as never,
    }],
  ]);
  assert.deepEqual(evaluateShutdownBarrier(runners), {
    ok: false,
    reason: "managed child still alive",
  });
});

test("evaluateShutdownBarrier does not treat an unproven external pid as owned", () => {
  const runners = new Map<string, RunnerRecord>([
    [SERVER_A, {
      serverId: SERVER_A,
      lifecycle: "running",
      stopping: false,
      externalPid: 4242,
    }],
  ]);
  assert.deepEqual(evaluateShutdownBarrier(runners), { ok: true });
});

test("evaluateShutdownBarrier opens after every managed child exits", () => {
  const runners = new Map<string, RunnerRecord>([
    [SERVER_A, {
      serverId: SERVER_A,
      lifecycle: "stopped",
      stopping: true,
    }],
    [SERVER_B, {
      serverId: SERVER_B,
      lifecycle: "running",
      stopping: false,
      externalPid: 9999,
    }],
  ]);
  assert.deepEqual(evaluateShutdownBarrier(runners), { ok: true });
});

test("shutdownService drains owned children without deleting the proven replacement pidfile", async () => {
  const events: string[] = [];
  const child = {
    kill(signal: string) {
      events.push(`child:${signal}`);
    },
  } as never;
  const runners = new Map<string, RunnerRecord>([
    [SERVER_A, {
      serverId: SERVER_A,
      lifecycle: "running",
      stopping: false,
      child,
    }],
    [SERVER_B, {
      serverId: SERVER_B,
      lifecycle: "running",
      stopping: false,
      externalPid: 4242,
    }],
  ]);

  await shutdownService({
    runners,
    closeIpc: () => {
      events.push("ipc:close");
    },
    isProcessAlive: (pid) => pid === 4242,
    clearServicePidfile: async () => {
      events.push("pidfile:clear");
    },
    restartRequested: true,
    now: () => 0,
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
      runners.get(SERVER_A)!.child = undefined;
    },
    writeWarning: (message) => events.push(`warning:${message.includes("pid 4242")}`),
    exit: (code) => events.push(`exit:${code}`),
  });

  assert.equal(runners.get(SERVER_A)?.stopping, true);
  assert.deepEqual(events, [
    "child:SIGTERM",
    "ipc:close",
    "sleep:100",
    "warning:true",
    "exit:0",
  ]);
});

test("successful handoff preserves candidate pidfile for status and the next operator stop", async () => {
  await withHome(async (home) => {
    await mkdir(dirname(servicePidPath(home)), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, process.pid);
    await shutdownService({
      runners: new Map(),
      closeIpc: () => {},
      isProcessAlive: () => true,
      clearServicePidfile: async () => {
        await rm(servicePidPath(home), { force: true });
      },
      restartRequested: true,
      exit: () => {},
    });

    assert.equal(await readPidfileAt(servicePidPath(home)), process.pid);
    const status = await buildStatusReport(home);
    assert.equal(status.service.running, true);

    let candidateAlive = true;
    const stopped = await stopService(
      { slockHome: home },
      {
        isProcessAlive: (pid) => pid === process.pid && candidateAlive,
        killService: (pid) => {
          assert.equal(pid, process.pid);
          candidateAlive = false;
        },
        sleep: async () => {},
      },
    );
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.pid, process.pid);
    assert.equal(await readPidfileAt(servicePidPath(home)), null);
  });
});

test("upgradeStart hands the exact live request to a detached K coordinator", async () => {
  await withHome(async () => {
    let mutations!: ServiceIpcMutations;
    let coordinatorRequest: KUpgradeCoordinatorRequest | null = null;
    await runService({
      isSeaBinaryFn: () => true,
      readChannelFn: async () => "latest",
      spawnKUpgradeCoordinatorFn: async (_home, request) => {
        coordinatorRequest = request;
        return { pid: 34567, once: () => ({}) } as never;
      },
      waitForKUpgradeStartFn: async () => {},
      onMutationsReady: (ready) => {
        mutations = ready;
      },
      stopAfterMutationsReady: true,
    });

    assert.deepEqual(
      await mutations.upgradeStart({
        scope: "remote",
        requestId: "upgrade-k-coordinator",
        targetVersion: "1.0.8",
        originServerId: SERVER_A,
        trigger: "web",
      }),
      {
        status: "started",
        upgradeId: "upgrade-k-coordinator",
        targetVersion: "1.0.8",
      },
    );
    assert.ok(coordinatorRequest);
    const seen = coordinatorRequest as unknown as KUpgradeCoordinatorRequest;
    assert.match(seen.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual({ ...seen, startedAt: "<timestamp>" }, {
      carrier: "k",
      mode: "upgrade",
      scope: "remote",
      requestId: "upgrade-k-coordinator",
      originServerId: SERVER_A,
      fromVersion: COMPUTER_VERSION,
      targetVersion: "1.0.8",
      startedAt: "<timestamp>",
      currentBinaryPath: process.execPath,
      trigger: "web",
      priorProcessIdentities: [`service:${process.pid}`],
    });
  });
});

test("upgradeStart rejects when the detached coordinator exits before exact K acceptance", async () => {
  await withHome(async () => {
    let mutations!: ServiceIpcMutations;
    let spawned = 0;
    await runService({
      isSeaBinaryFn: () => true,
      readChannelFn: async () => "latest",
      inspectKUpgradeStartFn: async () => "fresh",
      spawnKUpgradeCoordinatorFn: async () => {
        spawned += 1;
        return { pid: 34567, once: () => ({}) } as never;
      },
      waitForKUpgradeStartFn: async () => {
        throw new Error("K_UPGRADE_COORDINATOR_REJECTED");
      },
      onMutationsReady: (ready) => {
        mutations = ready;
      },
      stopAfterMutationsReady: true,
    });

    await assert.rejects(
      mutations.upgradeStart({
        scope: "local",
        requestId: "upgrade-rejected",
        targetVersion: "1.0.8",
        trigger: "cli",
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "UPGRADE_START_REJECTED");
        assert.match((error as Error).message, /^K_UPGRADE_COORDINATOR_REJECTED: /u);
        return true;
      },
    );
    await assert.rejects(
      mutations.upgradeStart({
        scope: "local",
        requestId: "upgrade-after-rejection",
        targetVersion: "1.0.9",
        trigger: "cli",
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "UPGRADE_START_REJECTED");
        assert.match(
          (error as Error).message,
          /^K_UPGRADE_COORDINATOR_REJECTED: /u,
        );
        return true;
      },
    );
    assert.equal(spawned, 2);
  });
});

test("upgradeStart cannot report started when the coordinator exits after publishing its receipt", async () => {
  await withHome(async () => {
    let mutations!: ServiceIpcMutations;
    let exitListener: (() => void) | null = null;
    const child = {
      pid: 34567,
      exitCode: null,
      signalCode: null,
      once(event: string, listener: () => void) {
        if (event === "exit") exitListener = listener;
        return this;
      },
    };
    await runService({
      isSeaBinaryFn: () => true,
      readChannelFn: async () => "latest",
      inspectKUpgradeStartFn: async () => "fresh",
      spawnKUpgradeCoordinatorFn: async () => child as never,
      waitForKUpgradeStartFn: async () => {
        assert.ok(exitListener);
        exitListener();
      },
      onMutationsReady: (ready) => {
        mutations = ready;
      },
      stopAfterMutationsReady: true,
    });

    await assert.rejects(
      mutations.upgradeStart({
        scope: "local",
        requestId: "upgrade-exited-after-receipt",
        targetVersion: "1.0.8",
        trigger: "cli",
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "UPGRADE_START_REJECTED");
        assert.match((error as Error).message, /^K_UPGRADE_COORDINATOR_REJECTED: /u);
        return true;
      },
    );
  });
});

test("upgradeStart rejects a coordinator without a process identity", async () => {
  await withHome(async () => {
    let mutations!: ServiceIpcMutations;
    await runService({
      isSeaBinaryFn: () => true,
      readChannelFn: async () => "latest",
      inspectKUpgradeStartFn: async () => "fresh",
      spawnKUpgradeCoordinatorFn: async () => ({ once: () => ({}) }) as never,
      waitForKUpgradeStartFn: async () => {
        throw new Error("wait must not run for a missing coordinator");
      },
      onMutationsReady: (ready) => {
        mutations = ready;
      },
      stopAfterMutationsReady: true,
    });

    await assert.rejects(
      mutations.upgradeStart({
        scope: "local",
        requestId: "upgrade-missing-child",
        targetVersion: "1.0.8",
        trigger: "cli",
      }),
      /ServiceClientError: K_UPGRADE_COORDINATOR_MISSING: The upgrade coordinator process could not be spawned/u,
    );
  });
});

test("upgradeStart blocked by an undelivered K receipt is a typed UPGRADE_START_REJECTED that points at status, not doctor (task #779)", async () => {
  await withHome(async () => {
    let mutations!: ServiceIpcMutations;
    let spawned = 0;
    await runService({
      isSeaBinaryFn: () => true,
      readChannelFn: async () => "latest",
      inspectKUpgradeStartFn: async () => {
        throw new Error("K_UPGRADE_OPERATION_BLOCKED");
      },
      spawnKUpgradeCoordinatorFn: async () => {
        spawned += 1;
        return { pid: 34567, once: () => ({}) } as never;
      },
      waitForKUpgradeStartFn: async () => {
        throw new Error("wait must not run when the receipt slot is blocked");
      },
      onMutationsReady: (ready) => {
        mutations = ready;
      },
      stopAfterMutationsReady: true,
    });

    await assert.rejects(
      mutations.upgradeStart({
        scope: "local",
        requestId: "upgrade-blocked-by-receipt",
        targetVersion: "1.0.28",
        trigger: "cli",
      }),
      (error: unknown) => {
        const typed = error as { code?: string; message: string };
        // The wire code names the condition; it is not a frame-format error.
        assert.equal(typed.code, "UPGRADE_START_REJECTED");
        assert.notEqual(typed.code, "IPC_MALFORMED_FRAME");
        // The K reason token leads so logs stay greppable; the sentence is for humans.
        assert.match(typed.message, /^K_UPGRADE_OPERATION_BLOCKED: /u);
        assert.match(typed.message, /receipt/u);
        // No repair command for a condition the service settles itself, and never doctor.
        assert.doesNotMatch(typed.message, /doctor/u);
        assert.doesNotMatch(typed.message, /acknowledge/u);
        // The CLI presenter lifts the fenced command into its Next line.
        const rendered = formatHumanError(typed.code!, typed.message);
        assert.match(rendered, /^Next: raft-computer status$/mu);
        assert.doesNotMatch(rendered, /raft-computer doctor/u);
        return true;
      },
    );
    assert.equal(spawned, 0);
  });
});

test("upgradeStart on a non-SEA service is a typed UPGRADE_START_REJECTED (K_COORDINATOR_SEA_ONLY) and never spawns (task #779)", async () => {
  await withHome(async () => {
    let mutations!: ServiceIpcMutations;
    let spawned = 0;
    await runService({
      isSeaBinaryFn: () => false,
      readChannelFn: async () => "latest",
      inspectKUpgradeStartFn: async () => {
        throw new Error("inspect must not run for a non-SEA service");
      },
      spawnKUpgradeCoordinatorFn: async () => {
        spawned += 1;
        return { pid: 34567, once: () => ({}) } as never;
      },
      onMutationsReady: (ready) => {
        mutations = ready;
      },
      stopAfterMutationsReady: true,
    });
    await assert.rejects(
      mutations.upgradeStart({ scope: "local", requestId: "upgrade-non-sea", targetVersion: "1.0.28", trigger: "cli" }),
      (error: unknown) => {
        const typed = error as { code?: string; message: string };
        assert.equal(typed.code, "UPGRADE_START_REJECTED");
        assert.match(typed.message, /^K_COORDINATOR_SEA_ONLY: /u);
        // No fenced command in this reason: the presenter falls back to the UPGRADE_ family default.
        assert.match(formatHumanError(typed.code!, typed.message), /^Next: raft-computer upgrade$/mu);
        return true;
      },
    );
    assert.equal(spawned, 0);
  });
});

test("upgradeStart with an invalid request identity is a typed UPGRADE_START_REJECTED (K_UPGRADE_REQUEST_IDENTITY_INVALID) (task #779)", async () => {
  await withHome(async () => {
    let mutations!: ServiceIpcMutations;
    await runService({
      isSeaBinaryFn: () => true,
      readChannelFn: async () => "latest",
      inspectKUpgradeStartFn: async () => {
        throw new Error("inspect must not run for an invalid identity");
      },
      spawnKUpgradeCoordinatorFn: async () => {
        throw new Error("spawn must not run for an invalid identity");
      },
      onMutationsReady: (ready) => {
        mutations = ready;
      },
      stopAfterMutationsReady: true,
    });
    await assert.rejects(
      // local scope with a web trigger is not a valid identity
      mutations.upgradeStart({ scope: "local", requestId: "upgrade-bad-identity", targetVersion: "1.0.28", trigger: "web" } as never),
      (error: unknown) => {
        const typed = error as { code?: string; message: string };
        assert.equal(typed.code, "UPGRADE_START_REJECTED");
        assert.match(typed.message, /^K_UPGRADE_REQUEST_IDENTITY_INVALID: /u);
        return true;
      },
    );
  });
});

test("upgradeStart coordinator timeout is a typed UPGRADE_START_REJECTED (K_UPGRADE_START_TIMEOUT) whose Next is upgrade (task #779)", async () => {
  await withHome(async () => {
    let mutations!: ServiceIpcMutations;
    await runService({
      isSeaBinaryFn: () => true,
      readChannelFn: async () => "latest",
      inspectKUpgradeStartFn: async () => "fresh",
      spawnKUpgradeCoordinatorFn: async () => ({ pid: 34567, once: () => ({}) }) as never,
      waitForKUpgradeStartFn: async () => {
        throw new Error("K_UPGRADE_START_TIMEOUT");
      },
      onMutationsReady: (ready) => {
        mutations = ready;
      },
      stopAfterMutationsReady: true,
    });
    await assert.rejects(
      mutations.upgradeStart({ scope: "local", requestId: "upgrade-timeout", targetVersion: "1.0.28", trigger: "cli" }),
      (error: unknown) => {
        const typed = error as { code?: string; message: string };
        assert.equal(typed.code, "UPGRADE_START_REJECTED");
        assert.match(typed.message, /^K_UPGRADE_START_TIMEOUT: /u);
        assert.match(formatHumanError(typed.code!, typed.message), /^Next: raft-computer upgrade$/mu);
        return true;
      },
    );
  });
});

test("upgradeStart unreadable receipt is the ONLY rejection whose Next is doctor (task #779)", async () => {
  await withHome(async () => {
    let mutations!: ServiceIpcMutations;
    await runService({
      isSeaBinaryFn: () => true,
      readChannelFn: async () => "latest",
      inspectKUpgradeStartFn: async () => {
        throw new Error("K_UPGRADE_RECEIPT_UNREADABLE");
      },
      spawnKUpgradeCoordinatorFn: async () => {
        throw new Error("spawn must not run over an unreadable receipt");
      },
      onMutationsReady: (ready) => {
        mutations = ready;
      },
      stopAfterMutationsReady: true,
    });
    await assert.rejects(
      mutations.upgradeStart({ scope: "local", requestId: "upgrade-unreadable-receipt", targetVersion: "1.0.28", trigger: "cli" }),
      (error: unknown) => {
        const typed = error as { code?: string; message: string };
        assert.equal(typed.code, "UPGRADE_START_REJECTED");
        assert.match(typed.message, /^K_UPGRADE_RECEIPT_UNREADABLE: /u);
        assert.match(formatHumanError(typed.code!, typed.message), /^Next: raft-computer doctor$/mu);
        return true;
      },
    );
  });
});

test("upgradeStart default rejection strips fences from a raw error so it cannot steer Next back to doctor (task #779)", async () => {
  await withHome(async () => {
    let mutations!: ServiceIpcMutations;
    await runService({
      isSeaBinaryFn: () => true,
      readChannelFn: async () => "latest",
      inspectKUpgradeStartFn: async () => "fresh",
      spawnKUpgradeCoordinatorFn: async () => {
        // An untyped failure whose text carries a fenced command.
        throw new Error("spawn failed; try `raft-computer doctor` first");
      },
      onMutationsReady: (ready) => {
        mutations = ready;
      },
      stopAfterMutationsReady: true,
    });
    await assert.rejects(
      mutations.upgradeStart({ scope: "local", requestId: "upgrade-raw-error", targetVersion: "1.0.28", trigger: "cli" }),
      (error: unknown) => {
        const typed = error as { code?: string; message: string };
        assert.equal(typed.code, "UPGRADE_START_REJECTED");
        assert.match(typed.message, /^K_UPGRADE_START_FAILED: /u);
        // The raw text is preserved for the operator, but no fence survives.
        assert.match(typed.message, /spawn failed; try raft-computer doctor first/u);
        assert.doesNotMatch(typed.message, /`raft-computer doctor`/u);
        const rendered = formatHumanError(typed.code!, typed.message);
        assert.match(rendered, /^Next: raft-computer upgrade$/mu);
        return true;
      },
    );
  });
});

test("describeUpgradeStartRejection keeps an unknown K_ token as the prefix and uses the default sentence (task #779)", () => {
  const rendered = describeUpgradeStartRejection("K_FUTURE_REASON: some detail with `raft-computer doctor` fenced");
  assert.match(rendered, /^K_FUTURE_REASON: The service refused to start this upgrade \(some detail with raft-computer doctor fenced\); /u);
  assert.doesNotMatch(rendered, /K_UPGRADE_START_FAILED/u);
  assert.match(formatHumanError("UPGRADE_START_REJECTED", rendered), /^Next: raft-computer upgrade$/mu);
});

test("upgradeStart exact durable replay does not spawn another coordinator", async () => {
  await withHome(async () => {
    let mutations!: ServiceIpcMutations;
    await runService({
      isSeaBinaryFn: () => true,
      readChannelFn: async () => "latest",
      inspectKUpgradeStartFn: async () => "exact",
      spawnKUpgradeCoordinatorFn: async () => {
        throw new Error("exact replay must not spawn");
      },
      onMutationsReady: (ready) => {
        mutations = ready;
      },
      stopAfterMutationsReady: true,
    });

    assert.deepEqual(await mutations.upgradeStart({
      scope: "local",
      requestId: "upgrade-replay",
      targetVersion: "1.0.8",
      trigger: "cli",
    }), {
      status: "already-running",
      upgradeId: "upgrade-replay",
      targetVersion: "1.0.8",
    });
  });
});

test("shutdownService escalates an ignored SIGTERM before Windows operator stop exits 0", async () => {
  const events: string[] = [];
  let now = 0;
  const runners = new Map<string, RunnerRecord>();
  const child = {
    kill(signal: string) {
      events.push(`child:${signal}`);
      if (signal === "SIGKILL") runners.get(SERVER_A)!.child = undefined;
    },
  } as never;
  runners.set(SERVER_A, {
    serverId: SERVER_A,
    lifecycle: "running",
    stopping: false,
    child,
  });

  await shutdownService({
    runners,
    closeIpc: () => {},
    isProcessAlive: () => true,
    clearServicePidfile: async () => {
      events.push("pidfile:clear");
    },
    restartRequested: false,
    now: () => now,
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
      now += ms === 100 ? 10_000 : ms;
    },
    exit: (code) => events.push(`exit:${code}`),
  });

  assert.deepEqual(events, [
    "child:SIGTERM",
    "sleep:100",
    "child:SIGKILL",
    "sleep:1000",
    "pidfile:clear",
    "exit:0",
  ]);
});

test("start: no attached servers → fail-closed before any spawn", async () => {
  await withHome(async () => {
    const cap = captureOut();
    try {
      await assert.rejects(() => runStart({}), (e) => e instanceof CliExit && e.exitCode === 1);
    } finally {
      cap.restore();
    }
    const out = cap.text();
    assert.match(
      out,
      /What happened \(NO_ATTACHMENT\): No server attachments yet\. Run `raft-computer attach \/<serverSlug>` first\./,
    );
    assert.match(out, /\nNext: raft-computer attach \/<serverSlug>\n/);
    assert.doesNotMatch(out, /attach <serverId>/);
  });
});

test("start: serverId not in attached set → NOT_ATTACHED", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const cap = captureOut();
    try {
      await assert.rejects(() => runStart({ serverId: SERVER_B }), (e) => e instanceof CliExit);
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /NOT_ATTACHED/);
  });
});

test("start: live service pidfile → waits for daemon readiness before returning", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid)); // alive
    await writeServiceVersion(home);
    let polls = 0;
    const cap = captureOut();
    try {
      await runStart(
        {},
        {
          readPidfile: async (pidfile) => {
            polls += 1;
            if (polls === 2) await writeReadyRunner(home, SERVER_A);
            return readPidfileAt(pidfile);
          },
          sleep: async () => undefined,
        },
      );
    } finally {
      cap.restore();
    }
    assert.equal(polls >= 2, true);
    assert.match(cap.text(), /Service already running/);
    assert.match(cap.text(), /Daemons for 1 managed server\(s\) are running/);
    assert.doesNotMatch(cap.text(), /next reconcile tick/);
  });
});

test("start: live service but daemon never becomes ready → fail-loud START_DAEMON_TIMEOUT", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home);
    const cap = captureOut();
    try {
      await assert.rejects(
        () =>
          runStart(
            { serverId: SERVER_A, serverLabel: "/alpha" },
            {
              ensureTimeoutMs: 0,
              ensurePollIntervalMs: 1,
              sleep: async () => undefined,
            },
          ),
        (e) => e instanceof CliExit,
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /START_DAEMON_TIMEOUT/);
    assert.match(cap.text(), /raft-computer status/);
    assert.ok(cap.text().includes(serviceLogPath(home)));
    assert.ok(cap.text().includes(serverRunnerLogPath(home, SERVER_A)));
    assert.doesNotMatch(cap.text(), /~\/.slock/);
    assert.doesNotMatch(cap.text(), /next reconcile tick/);
  });
});

test("start: connected live runner without pid-bound version proof is not ready", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home);
    await writeRunnerPid(home, SERVER_A);
    writeResidentConnectedMarker(serverConnectedMarkerPath(home, SERVER_A));
    const cap = captureOut();
    try {
      await assert.rejects(
        () => runStart(
          { serverId: SERVER_A, serverLabel: "/alpha" },
          { ensureTimeoutMs: 0, sleep: async () => undefined },
        ),
        (error) => error instanceof CliExit,
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /START_DAEMON_TIMEOUT/);
    assert.doesNotMatch(cap.text(), /Daemon for server \/alpha is running/);
  });
});

test("start: replacement waits for its own PID-bound connection evidence", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home);
    await writeReadyRunner(home, SERVER_A);
    writeResidentConnectedMarker(
      serverConnectedMarkerPath(home, SERVER_A),
      process.pid + 1,
      Date.now() - 1_000,
    );

    let sleeps = 0;
    const cap = captureOut();
    try {
      await runStart(
        { serverId: SERVER_A, serverLabel: "/alpha" },
        {
          ensureTimeoutMs: 1_000,
          ensurePollIntervalMs: 1,
          sleep: async () => {
            sleeps += 1;
            writeResidentConnectedMarker(serverConnectedMarkerPath(home, SERVER_A), process.pid);
          },
        },
      );
    } finally {
      cap.restore();
    }

    assert.equal(sleeps, 1, "stale predecessor evidence must force another readiness poll");
    assert.match(cap.text(), /Daemon for server \/alpha is running/);
  });
});

test("start: newly spawned service waits for target daemon before returning", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const cap = captureOut();
    try {
      await runStart(
        { serverId: SERVER_A, serverLabel: "/alpha" },
        {
          spawnDetachedService: async () => {
            await writeReadyRunner(home, SERVER_A);
            return process.pid;
          },
        },
      );
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /Service started/);
    assert.match(cap.text(), /Daemon for server \/alpha is running/);
    assert.ok(cap.text().includes(serviceLogPath(home)));
    assert.ok(cap.text().includes(serverRunnerLogPath(home, SERVER_A)));
    assert.doesNotMatch(cap.text(), /~\/.slock/);
  });
});

// --- managed.flag contract v4 §6 line 80 ---

test("start <serverId>: marks target managed without clearing already-managed servers", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeAttach(home, SERVER_B);
    await setServerManaged(home, SERVER_B);
    // Pre-write service pid so runStart returns idempotently without
    // spawning a real service process.
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home);
    await writeReadyRunner(home, SERVER_A);
    const cap = captureOut();
    try {
      await runStart({ serverId: SERVER_A });
    } finally {
      cap.restore();
    }
    assert.equal(await isServerManaged(home, SERVER_A), true);
    assert.equal(await isServerManaged(home, SERVER_B), true);
  });
});

test("start (no arg): marks ALL attached servers as managed", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeAttach(home, SERVER_B);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home);
    await writeReadyRunner(home, SERVER_A);
    await writeReadyRunner(home, SERVER_B);
    const cap = captureOut();
    try {
      await runStart({});
    } finally {
      cap.restore();
    }
    assert.equal(await isServerManaged(home, SERVER_A), true);
    assert.equal(await isServerManaged(home, SERVER_B), true);
  });
});

test("listManagedServerIds: returns only servers with both attachment AND managed.flag", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeAttach(home, SERVER_B);
    await setServerManaged(home, SERVER_A);
    // SERVER_B is attached but NOT managed.
    const managed = await listManagedServerIds(home);
    assert.deepEqual(managed, [SERVER_A]);
  });
});

// Touch serverRunnerPidPath to exercise the path helper (no semantic
// assertion; would catch accidental shape regression at compile time).
test("paths: serverRunnerPidPath ends in servers/<id>/runner.pid", () => {
  const p = serverRunnerPidPath("/x", SERVER_A);
  assert.match(p, new RegExp(`servers/${SERVER_A}/runner\\.pid$`));
});

// Dayu blocker (#wg-raft-computer:b43b36fb msg=ff69d33f). Service
// startup recovery can run either as a detached replacement (marker is
// inherited) or as an unmarked manual/legacy start. Lock cleanup must be
// ownership-safe in both cases.
// These tests pin both branches.

async function makeLockDir(home: string): Promise<string> {
  const dir = join(computerDir(home), ".lock");
  await mkdir(dir, { recursive: true });
  return dir;
}

test("runServiceStartupRecovery: parent holds lock → .lock preserved, breadcrumb emitted", async () => {
  await withHome(async (home) => {
    const lockDir = await makeLockDir(home);
    const prevMarker = process.env[PARENT_LOCK_HELD_ENV_VAR];
    process.env[PARENT_LOCK_HELD_ENV_VAR] = "1";
    const cap = captureOut();
    try {
      await runServiceStartupRecovery(home);
    } finally {
      cap.restore();
      if (prevMarker === undefined) delete process.env[PARENT_LOCK_HELD_ENV_VAR];
      else process.env[PARENT_LOCK_HELD_ENV_VAR] = prevMarker;
    }
    // Lock must still be on disk — PR-H §3.2 serialization invariant.
    const s = await stat(lockDir);
    assert.ok(s.isDirectory(), ".lock must survive parent-held startup recovery");
    assert.match(cap.text(), /skipping lock cleanup/);
  });
});

test("runServiceStartupRecovery: unmarked start cannot delete a current CLI-owned lock", async () => {
  await withHome(async (home) => {
    const prevMarker = process.env[PARENT_LOCK_HELD_ENV_VAR];
    delete process.env[PARENT_LOCK_HELD_ENV_VAR];
    const cap = captureOut();
    try {
      await withComputerMutationLock(home, async () => {
        await runServiceStartupRecovery(home);
        await assert.doesNotReject(() => stat(join(computerDir(home), ".lock")));
      });
    } finally {
      cap.restore();
      if (prevMarker !== undefined) process.env[PARENT_LOCK_HELD_ENV_VAR] = prevMarker;
    }
    assert.doesNotMatch(cap.text(), /force-released/);
  });
});

test("runServiceStartupRecovery: marker present but no lock → no-op + no spurious breadcrumb about release", async () => {
  await withHome(async (home) => {
    const prevMarker = process.env[PARENT_LOCK_HELD_ENV_VAR];
    process.env[PARENT_LOCK_HELD_ENV_VAR] = "1";
    const cap = captureOut();
    try {
      await runServiceStartupRecovery(home);
    } finally {
      cap.restore();
      if (prevMarker === undefined) delete process.env[PARENT_LOCK_HELD_ENV_VAR];
      else process.env[PARENT_LOCK_HELD_ENV_VAR] = prevMarker;
    }
    // No lock to begin with; recovery still emits the marker note but
    // does not falsely claim it released anything.
    assert.match(cap.text(), /skipping lock cleanup/);
    assert.doesNotMatch(cap.text(), /\d+ stale lock\(s\)\./);
  });
});

// Dayu Round 3 blocker (#wg-raft-computer:b43b36fb msg=29336624):
// the env-var marker MUST suppress the entire `.lock` cleanup category,
// not just one cleanup call. `runFullCleanup` also fires
// `cleanupStaleLock` for `.lock` whose mtime is
// older than 60s — and a real PR-E upgrade (stage + verify + extract +
// swap + rolling-health + cleanup) routinely exceeds 60s. Without this
// fix, the parent CLI's still-valid lock would be wiped mid-upgrade,
// breaking the PR-H §3.2 "mutating commands serialize cleanly"
// invariant during the upgrade window.

test("runServiceStartupRecovery: marker + >60s-old .lock → still preserved (age-gated cleanup ALSO skipped)", async () => {
  await withHome(async (home) => {
    const lockDir = await makeLockDir(home);
    // Backdate the lock dir's mtime to 5 minutes ago so cleanupStaleLock
    // (60s threshold) would normally rm it.
    const oldTime = new Date(Date.now() - 5 * 60 * 1000);
    await utimes(lockDir, oldTime, oldTime);
    const prevMarker = process.env[PARENT_LOCK_HELD_ENV_VAR];
    process.env[PARENT_LOCK_HELD_ENV_VAR] = "1";
    const cap = captureOut();
    try {
      await runServiceStartupRecovery(home);
    } finally {
      cap.restore();
      if (prevMarker === undefined) delete process.env[PARENT_LOCK_HELD_ENV_VAR];
      else process.env[PARENT_LOCK_HELD_ENV_VAR] = prevMarker;
    }
    // Even though the lock is well past the 60s age gate, the marker
    // tells the service "parent CLI is mid-mutate, hands off the
    // lock entirely". Same serialization invariant as the fresh-lock
    // case above.
    const s = await stat(lockDir);
    assert.ok(s.isDirectory(), ".lock must survive parent-held even when older than 60s");
    assert.match(cap.text(), /skipping lock cleanup/);
    assert.doesNotMatch(cap.text(), /\d+ stale lock\(s\)\./);
  });
});

test("runServiceStartupRecovery: NO marker + >60s-old .lock → ownership-safely reclaimed", async () => {
  await withHome(async (home) => {
    const lockDir = await makeLockDir(home);
    const oldTime = new Date(Date.now() - 5 * 60 * 1000);
    await utimes(lockDir, oldTime, oldTime);
    const prevMarker = process.env[PARENT_LOCK_HELD_ENV_VAR];
    delete process.env[PARENT_LOCK_HELD_ENV_VAR];
    const cap = captureOut();
    try {
      await runServiceStartupRecovery(home);
    } finally {
      cap.restore();
      if (prevMarker !== undefined) process.env[PARENT_LOCK_HELD_ENV_VAR] = prevMarker;
    }
    // Orphan path: proper-lockfile atomically reacquires the stale mutex and
    // releases it as the current owner.
    await assert.rejects(() => stat(lockDir), /ENOENT/);
    assert.match(cap.text(), /1 stale lock\(s\)/);
  });
});

// ---------- classifyRunnerExit (task #48 #3 — SIGTERM crash budget) ----------
//
// Field finding: external `kill -TERM <runnerPid>` was counted as a crash
// because the service's exit handler treated all `handle.stopping=false`
// exits as crashes. After 3 such kills in 60s the server went degraded
// even though no actual crash occurred. classifyRunnerExit splits exit
// modes so only true crashes count toward the budget.

import {
  classifyRunnerExit,
  COMPUTER_MACHINE_UNLINKED_EXIT_CODE,
  EX_CONFIG_EXIT_CODE,
  hasRunnerReadyEvidence,
  parseDaemonLockConflictOwnerPid,
} from "./service.js";

test("classifyRunnerExit: code 0 → graceful (not a crash)", () => {
  assert.equal(classifyRunnerExit(0, null), "graceful");
});

test("classifyRunnerExit: SIGTERM → graceful regardless of source", () => {
  // External `kill -TERM`, service-initiated kill, or daemon's own
  // SIGTERM-handler-driven exit all surface as signal=SIGTERM. The
  // exit handler can't tell them apart, but they all represent
  // "process was asked to stop", not "process crashed".
  assert.equal(classifyRunnerExit(null, "SIGTERM"), "graceful");
});

test("classifyRunnerExit: SIGINT → graceful (Ctrl-C / dev kill)", () => {
  assert.equal(classifyRunnerExit(null, "SIGINT"), "graceful");
});

test(`classifyRunnerExit: code ${EX_CONFIG_EXIT_CODE} → config-error`, () => {
  // EX_CONFIG sentinel from runResident when @botiverse/raft-daemon/core can't
  // resolve. Don't count toward crash budget AND don't restart.
  assert.equal(classifyRunnerExit(EX_CONFIG_EXIT_CODE, null), "config-error");
});

test(`classifyRunnerExit: code ${COMPUTER_MACHINE_UNLINKED_EXIT_CODE} → unlinked-terminal`, () => {
  assert.equal(classifyRunnerExit(COMPUTER_MACHINE_UNLINKED_EXIT_CODE, null), "unlinked-terminal");
});

test("classifyRunnerExit: non-zero exit code → crash", () => {
  assert.equal(classifyRunnerExit(1, null), "crash");
  assert.equal(classifyRunnerExit(127, null), "crash");
});

test("classifyRunnerExit: daemon machine-lock conflict → already-running (not crash budget)", () => {
  const diagnostic =
    "Another Slock daemon is already running for this machine key " +
    "(pid=54054, startedAt=2026-07-07T15:03:22Z, host=xxdev).";
  assert.equal(classifyRunnerExit(1, null, diagnostic), "already-running");
  assert.equal(parseDaemonLockConflictOwnerPid(diagnostic), 54054);
});

test("classifyRunnerExit: spawn-exit runner log sequence with already-running child testament is not crash", () => {
  const diagnostic = [
    "[2026-07-08T14:56:24.001Z] raft-computer __run starting",
    "Another Slock daemon is already running (pid=1898867)",
    "exiting because this machine key is already owned by the incumbent daemon",
  ].join("\n");
  assert.equal(classifyRunnerExit(1, null, diagnostic), "already-running");
  assert.equal(parseDaemonLockConflictOwnerPid(diagnostic), 1898867);
});

test("parseDaemonLockConflictOwnerPid: ignores unrelated diagnostics and invalid pids", () => {
  assert.equal(parseDaemonLockConflictOwnerPid("provider crashed"), null);
  assert.equal(
    parseDaemonLockConflictOwnerPid("Another Slock daemon is already running (pid=0)."),
    null,
  );
  assert.equal(
    parseDaemonLockConflictOwnerPid("Another Slock daemon is already running (unknown owner)."),
    null,
  );
});

test("classifyRunnerExit: non-graceful signals → crash", () => {
  assert.equal(classifyRunnerExit(null, "SIGKILL"), "crash");
  assert.equal(classifyRunnerExit(null, "SIGSEGV"), "crash");
  assert.equal(classifyRunnerExit(null, "SIGBUS"), "crash");
});

test("classifyRunnerExit: EX_CONFIG_EXIT_CODE constant is 78 (BSD EX_CONFIG)", () => {
  assert.equal(EX_CONFIG_EXIT_CODE, 78);
});

test("classifyRunnerExit: COMPUTER_MACHINE_UNLINKED_EXIT_CODE constant is 77", () => {
  assert.equal(COMPUTER_MACHINE_UNLINKED_EXIT_CODE, 77);
});

test("hasRunnerReadyEvidence: connection marker must belong to the live pid", async () => {
  await withHome(async (home) => {
    assert.equal(await hasRunnerReadyEvidence(home, SERVER_A, process.pid), false);
    const markerPath = serverConnectedMarkerPath(home, SERVER_A);
    await mkdir(dirname(markerPath), { recursive: true });
    writeResidentConnectedMarker(markerPath, process.pid + 1);
    assert.equal(await hasRunnerReadyEvidence(home, SERVER_A, process.pid), false);
    writeResidentConnectedMarker(markerPath, process.pid);
    assert.equal(await hasRunnerReadyEvidence(home, SERVER_A, process.pid), true);
    assert.equal(await hasRunnerReadyEvidence(home, SERVER_A, process.pid, () => false), false);
  });
});

// --- runStop (root `raft-computer stop` — v0.0.8 hotfix command) ---
//
// Wired into ephemeral-context upgrade remediation per #wg-raft-computer
// msg=fb9e5675 (Hao blocker). Tests cover the four state transitions:
// missing pidfile, stale pidfile, alive service, and the failure
// surfaces (signal throw, exit-timeout).

test("runStop: no pidfile → idempotent 'Service not running' (exit 0)", async () => {
  await withHome(async () => {
    const cap = captureOut();
    try {
      await runStop({
        readPidfile: async () => null,
        isProcessAlive: () => false,
      });
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /Service not running/);
  });
});

test("runStop: stale pidfile (pid dead) → clears pidfile + idempotent success", async () => {
  await withHome(async (home) => {
    const pidfile = servicePidPath(home);
    await mkdir(dirname(pidfile), { recursive: true });
    await writeFile(pidfile, "99999\n", "utf8");
    const cap = captureOut();
    try {
      await runStop({
        readPidfile: async () => 99999,
        isProcessAlive: () => false,
      });
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /Service not running.*cleared stale pidfile/);
    // Pidfile cleared.
    await assert.rejects(
      () => readFile(pidfile, "utf8"),
      (e) => (e as NodeJS.ErrnoException).code === "ENOENT",
    );
  });
});

test("runStop: alive service → SIGTERM + waits for exit + success", async () => {
  await withHome(async () => {
    let killed = false;
    let aliveCalls = 0;
    const cap = captureOut();
    try {
      await runStop({
        readPidfile: async () => 12345,
        // First call (gate): alive. After kill (subsequent polls): dead.
        isProcessAlive: () => {
          aliveCalls += 1;
          return aliveCalls === 1;
        },
        killService: (pid: number) => {
          assert.equal(pid, 12345);
          killed = true;
        },
        sleep: async () => {},
        pollIntervalMs: 1,
        timeoutMs: 1000,
      });
    } finally {
      cap.restore();
    }
    assert.equal(killed, true, "SIGTERM must be sent");
    assert.match(cap.text(), /Stopped service.*pid 12345/);
  });
});

test("runStop: SIGTERM throws (e.g. EPERM) → STOP_SIGNAL_FAILED with actionable kill hint", async () => {
  await withHome(async () => {
    const cap = captureOut();
    try {
      await assert.rejects(
        () =>
          runStop({
            readPidfile: async () => 12345,
            isProcessAlive: () => true,
            killService: () => {
              const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
              err.code = "EPERM";
              throw err;
            },
          }),
        (e) => e instanceof CliExit && e.exitCode === 1,
      );
    } finally {
      cap.restore();
    }
    const out = cap.text();
    assert.match(out, /STOP_SIGNAL_FAILED/);
    assert.match(out, /EPERM/);
    assert.match(out, /kill 12345/);
  });
});

test("runStop: SIGTERM succeeds but service doesn't exit within timeout → STOP_TIMEOUT with kill -9 hint", async () => {
  await withHome(async () => {
    const cap = captureOut();
    try {
      await assert.rejects(
        () =>
          runStop({
            readPidfile: async () => 12345,
            isProcessAlive: () => true, // never dies
            killService: () => {},
            sleep: async () => {},
            pollIntervalMs: 1,
            timeoutMs: 10,
          }),
        (e) => e instanceof CliExit && e.exitCode === 1,
      );
    } finally {
      cap.restore();
    }
    const out = cap.text();
    assert.match(out, /STOP_TIMEOUT/);
    assert.match(out, /pid 12345/);
    assert.match(out, /kill -9 12345/);
  });
});

// Regression: the supervisor must never spawn a SECOND daemon for a serverId
// whose graceful/crash respawn is mid-backoff. Before the fix, reconcile()
// keyed only on the running set + a side `restarting` Set; a restart removed
// the child immediately but respawned only after CHILD_RESTART_BACKOFF_MS, so
// reconcile double-spawned in the gap and the two daemons raced the machine
// lock ("Another Slock daemon is already running" → degraded). The side set is
// now gone: spawn-eligibility is the pure `canSpawn(record, wanted, now)`, and a
// runner mid-backoff is `crashed`/`stopped` with a future `backoffUntil`, which
// `canSpawn` rejects — the race window cannot exist. (Exhaustive eligibility
// table lives in lib/runnerStateMachine.test.ts; this pins the supervisor-level
// scenario in the record vocabulary the service loop actually holds.)
test("canSpawn: blocks reconcile spawn while a respawn is mid-backoff (double-spawn regression)", () => {
  const id = "server-A";
  const backoffUntil = 5_000;
  const make = (p: Partial<RunnerRecord>): RunnerRecord => ({
    serverId: id,
    lifecycle: "stopped",
    stopping: false,
    ...p,
  });

  // Idle, attached server with no record yet → spawnable.
  assert.equal(canSpawn(undefined, true, 1_000), true);

  // A live daemon is registered (child present) → never spawn a second.
  assert.equal(
    canSpawn(make({ lifecycle: "running", child: {} as RunnerRecord["child"] }), true, 1_000),
    false,
  );

  // Service-restart orphan adoption: a live daemon is holding the lock, but it
  // is not this supervisor's child. It is still spawn-blocking.
  assert.equal(
    canSpawn(make({ lifecycle: "running", externalPid: 12345 }), true, 1_000),
    false,
  );

  // THE REGRESSION CASE: child just exited (crashed, under budget) and a respawn
  // is scheduled behind the backoff. reconcile firing inside the window MUST NOT
  // spawn — no side set needed, the future backoffUntil rejects it.
  const midBackoff = make({ lifecycle: "crashed", backoffUntil });
  assert.equal(canSpawn(midBackoff, true, backoffUntil - 1), false);

  // Backoff elapsed → eligible again.
  assert.equal(canSpawn(midBackoff, true, backoffUntil), true);

  // A degraded runner (crash budget breached / fatal config) is parked: no
  // backoff value can make it spawnable — explicit start/restart clears it.
  assert.equal(canSpawn(make({ lifecycle: "degraded", backoffUntil: 0 }), true, 9_999_999), false);
});

test("external runner pid adoption blocks spawn until the pid is observed dead", () => {
  const rec: RunnerRecord = {
    serverId: SERVER_A,
    lifecycle: "starting",
    stopping: false,
  };
  adoptExternalRunnerPid(rec, 54054);
  assert.equal(rec.lifecycle, "running");
  assert.equal(rec.externalPid, 54054);
  assert.equal(canSpawn(rec, true, 1_000), false);

  assert.equal(clearExternalRunnerPidIfDead(rec, () => true), false);
  assert.equal(rec.externalPid, 54054);
  assert.equal(rec.lifecycle, "running");

  assert.equal(clearExternalRunnerPidIfDead(rec, () => false), true);
  assert.equal(rec.externalPid, undefined);
  assert.equal(rec.lifecycle, "stopped");
  assert.equal(canSpawn(rec, true, 1_000), true);
});

test("external runner pid adoption keeps local status aligned with connected server view", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);

    const rec: RunnerRecord = {
      serverId: SERVER_A,
      lifecycle: "starting",
      stopping: false,
    };
    adoptExternalRunnerPid(rec, process.pid);
    assert.equal(rec.externalPid, process.pid);
    const adoptedPid = rec.externalPid;
    if (adoptedPid === undefined) assert.fail("expected adopted external pid");
    await writeRunnerPid(home, SERVER_A, adoptedPid);
    await writeFile(serverConnectedMarkerPath(home, SERVER_A), "connected\n", { mode: 0o600 });

    const report = await buildStatusReport(home);
    const server = report.servers.find((s) => s.serverId === SERVER_A);
    assert.ok(server);
    assert.deepEqual(server.daemon, { running: true, pid: process.pid });
    assert.equal(server.health, "ok", "adopted live orphan must not surface as local status offline");
    assert.equal(
      server.serverConnected,
      true,
      "server/web connected marker remains truthful once local status sees the adopted pid",
    );
  });
});

test("service log replay: repeated already-running lock losers adopt incumbent without crash/degraded lie", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const markerPath = serverConnectedMarkerPath(home, SERVER_A);
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, "connected\n", { mode: 0o600 });

    const incumbentPid = process.pid;
    const rec: RunnerRecord = {
      serverId: SERVER_A,
      lifecycle: "starting",
      stopping: false,
    };
    const transitions: Array<{ from: string; to: string; trigger: string }> = [];

    for (let i = 0; i < 3; i += 1) {
      // Replay each service.log stanza from the old spawn storm as the child
      // exit handler saw it: a just-spawned loser exits while the incumbent
      // daemon still owns the machine lock.
      rec.lifecycle = "starting";
      rec.externalPid = undefined;
      await handleRunnerExitForSupervisor({
        slockHome: home,
        serverId: SERVER_A,
        rec,
        code: 1,
        signal: null,
        diagnosticText: [
          `[2026-07-08T14:56:2${i}.001Z] raft-computer __run starting`,
          `Another Slock daemon is already running (pid=${incumbentPid})`,
          "exiting because this machine key is already owned by the incumbent daemon",
        ].join("\n"),
        isOwnerProcessAlive: (pid) => pid === incumbentPid,
        emitTransition: (_serverId, from, to, trigger) => {
          transitions.push({ from, to, trigger });
        },
        scheduleReconcile: () => {
          assert.fail("already-running adoption must not schedule a respawn");
        },
        writeStderr: () => {},
      });

      assert.equal(rec.lifecycle, "running");
      assert.equal(rec.externalPid, incumbentPid);
      assert.equal(await readPidfileAt(serverRunnerPidPath(home, SERVER_A)), incumbentPid);
    }

    assert.deepEqual(
      transitions,
      [
        { from: "starting", to: "running", trigger: RUNNER_TRIGGER.exitAlreadyRunning },
        { from: "starting", to: "running", trigger: RUNNER_TRIGGER.exitAlreadyRunning },
        { from: "starting", to: "running", trigger: RUNNER_TRIGGER.exitAlreadyRunning },
      ],
      "old fake-ready handling would not replay the service.log sequence as starting→running adoption",
    );
    assert.deepEqual(await readCrashHistory(home, SERVER_A), []);
    assert.equal(await isDegraded(home, SERVER_A), false);

    const report = await buildStatusReport(home);
    const server = report.servers.find((s) => s.serverId === SERVER_A);
    assert.ok(server);
    assert.deepEqual(server.daemon, { running: true, pid: incumbentPid });
    assert.equal(server.health, "ok");
    assert.equal(server.serverConnected, true);
  });
});

test("already-running loser retries through reconcile when the attested lock owner exited during handoff", async () => {
  await withHome(async (home) => {
    const ownerPid = 54054;
    const rec: RunnerRecord = {
      serverId: SERVER_A,
      lifecycle: "starting",
      stopping: false,
    };
    const transitions: Array<{ from: string; to: string; trigger: string }> = [];
    const scheduled: number[] = [];
    const stderr: string[] = [];
    let now = 1_000;

    await handleRunnerExitForSupervisor({
      slockHome: home,
      serverId: SERVER_A,
      rec,
      code: 1,
      signal: null,
      diagnosticText: `Another Slock daemon is already running (pid=${ownerPid})`,
      isOwnerProcessAlive: () => false,
      emitTransition: (_serverId, from, to, trigger) => {
        transitions.push({ from, to, trigger });
      },
      scheduleReconcile: (delayMs) => scheduled.push(delayMs),
      writeStderr: (text) => stderr.push(text),
      nowMs: () => now,
    });

    assert.equal(rec.lifecycle, "stopped");
    assert.equal(rec.externalPid, undefined);
    assert.ok((rec.backoffUntil ?? 0) > now);
    assert.deepEqual(scheduled, [(rec.backoffUntil ?? now) - now]);
    assert.deepEqual(transitions, [
      {
        from: "starting",
        to: "stopped",
        trigger: RUNNER_TRIGGER.exitLockOwnerGone,
      },
    ]);
    assert.match(stderr.join(""), /owner exited during handoff; retrying once/);
    assert.equal(await isDegraded(home, SERVER_A), false);
    now = rec.backoffUntil ?? now;
    assert.equal(canSpawn(rec, true, now), true);
  });
});

test("already-running loser preserves matching dead-owner daemon.lock for canonical daemon acquisition", async () => {
  await withHome(async (home) => {
    const ownerPid = 54054;
    const lockDir = join(home, "machines", "machine-deadbeefdeadbeef", "daemon.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: ownerPid, token: "stale" })}\n`,
      { mode: 0o600 },
    );
    const rec: RunnerRecord = {
      serverId: SERVER_A,
      lifecycle: "starting",
      stopping: false,
    };
    const scheduled: number[] = [];
    const stderr: string[] = [];
    let livenessChecks = 0;

    await handleRunnerExitForSupervisor({
      slockHome: home,
      serverId: SERVER_A,
      rec,
      code: 1,
      signal: null,
      diagnosticText:
        `Another Slock daemon is already running for this machine key (pid=${ownerPid}, startedAt=old, host=old). ` +
        `Lock: ${lockDir}. Stop the existing daemon first.`,
      isOwnerProcessAlive: () => {
        livenessChecks += 1;
        return false;
      },
      scheduleReconcile: (delayMs) => scheduled.push(delayMs),
      writeStderr: (text) => stderr.push(text),
    });

    assert.equal(existsSync(lockDir), true, "Computer must not delete daemon-owned lock state");
    assert.equal(livenessChecks, 1, "Computer must not re-enter a pre-delete ownership seam");
    assert.deepEqual(scheduled, [2_000]);
    assert.match(stderr.join(""), /owner exited during handoff; retrying once/);
  });
});

test("already-running loser preserves live, changed, mismatched, and malformed daemon lock owners", async (t) => {
  const cases = [
    { name: "live owner", diagnosticPid: 61001, ownerText: JSON.stringify({ pid: 61001 }), alive: true },
    { name: "changed live successor", diagnosticPid: 61002, ownerText: JSON.stringify({ pid: 61003 }), alive: false },
    { name: "dead mismatched owner", diagnosticPid: 61004, ownerText: JSON.stringify({ pid: 61005 }), alive: false },
    { name: "malformed owner", diagnosticPid: 61006, ownerText: "{not-json", alive: false },
  ] as const;

  for (const fixture of cases) {
    await runNamedCase(fixture.name, async () => {
      await withHome(async (home) => {
        const lockDir = join(home, "machines", `machine-${fixture.diagnosticPid}`, "daemon.lock");
        const ownerPath = join(lockDir, "owner.json");
        await mkdir(lockDir, { recursive: true });
        await writeFile(ownerPath, `${fixture.ownerText}\n`, { mode: 0o600 });
        const rec: RunnerRecord = {
          serverId: SERVER_A,
          lifecycle: "starting",
          stopping: false,
        };

        await handleRunnerExitForSupervisor({
          slockHome: home,
          serverId: SERVER_A,
          rec,
          code: 1,
          signal: null,
          diagnosticText:
            `Another Slock daemon is already running for this machine key (pid=${fixture.diagnosticPid}). ` +
            `Lock: ${lockDir}. Stop the existing daemon first.`,
          isOwnerProcessAlive: () => fixture.alive,
          scheduleReconcile: () => {},
          writeStderr: () => {},
        });

        assert.equal(existsSync(lockDir), true, `${fixture.name}: daemon.lock must survive`);
        assert.equal(await readFile(ownerPath, "utf8"), `${fixture.ownerText}\n`);
      });
    });
  }
});

test("already-running conflict without an attested owner pid remains degraded and does not spin", async () => {
  await withHome(async (home) => {
    const rec: RunnerRecord = {
      serverId: SERVER_A,
      lifecycle: "starting",
      stopping: false,
    };
    let scheduled = 0;
    await handleRunnerExitForSupervisor({
      slockHome: home,
      serverId: SERVER_A,
      rec,
      code: 1,
      signal: null,
      diagnosticText: "Another Slock daemon is already running (unknown owner)",
      scheduleReconcile: () => {
        scheduled += 1;
      },
      writeStderr: () => {},
    });
    assert.equal(rec.lifecycle, "degraded");
    assert.equal(scheduled, 0);
  });
});

// --- §3/§4 IPC seam wiring (RFC v9.8) ---
//
// Pins that the long-running service binds the typed-RPC seam at the path the
// `@botiverse/raft-computer/lib` client expects, and that the reader handlers
// answer with the shape downstream consumers depend on. Without this lock,
// `connectService` has no production peer — the seam was code-only before.
test("startServiceIpcSeam: binds the §4 socket and answers `service-status` via lib readers", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer", "run"), { recursive: true });
    const cap = captureOut();
    let ipc: Awaited<ReturnType<typeof startServiceIpcSeam>> | null = null;
    try {
      ipc = await startServiceIpcSeam(home);
    } finally {
      cap.restore();
    }
    assert.match(cap.text(), /IPC seam listening at/);
    try {
      const client = await connectService(home);
      try {
        const report = await client.request("service-status", undefined);
        // No attachments yet → empty servers list, but the report shape comes
        // from `buildStatusReport` and proves the lib reader is wired.
        assert.equal(Array.isArray(report.servers), true);
        assert.deepEqual(report.servers, []);
      } finally {
        await client.close();
      }
    } finally {
      if (ipc) await ipc.close();
    }
  });
});

test("startServiceIpcSeam: a lock-loser fails instead of running without IPC ownership", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer", "run"), { recursive: true });
    const cap = captureOut();
    let incumbent: Awaited<ReturnType<typeof startServiceIpcSeam>> | null = null;
    try {
      incumbent = await startServiceIpcSeam(home);
      await assert.rejects(startServiceIpcSeam(home));
    } finally {
      cap.restore();
      if (incumbent) await incumbent.close();
    }
    assert.match(cap.text(), /ownership not acquired/);
  });
});

test("startServiceIpcSeam: restart/reset/upgrade mutations route to the injected supervisor mutation surface (single-writer)", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer", "run"), { recursive: true });
    const calls: string[] = [];
    const mutations = {
      restartService: async (params?: { requestId: string; originServerId: string }) => {
        calls.push(
          `restart-service:${params?.requestId ?? "cli"}:${params?.originServerId ?? "unrouted"}`,
        );
        return { status: "accepted" as const };
      },
      resetService: async () => {
        calls.push("reset-service");
        return { status: "ok" as const, previousState: "degraded" as const, clearedCrashCount: 2 };
      },
      resetRunner: async (serverId: string) => {
        calls.push(`reset-runner:${serverId}`);
        return {
          status: "ok" as const,
          serverId,
          previousState: "degraded" as const,
          clearedCrashCount: 1,
        };
      },
      upgradeStart: async (params: { targetVersion?: string; requestId?: string; originServerId?: string; trigger?: "cli" | "web" | "tray" }) => {
        calls.push(
          `upgrade-start:${params.targetVersion ?? "channel"}:${params.requestId ?? "generated"}:${params.originServerId ?? "unrouted"}:${params.trigger ?? "cli"}`,
        );
        return { status: "started" as const, upgradeId: "u-1", targetVersion: params.targetVersion ?? "9.9.9" };
      },
    };
    const cap = captureOut();
    let ipc: Awaited<ReturnType<typeof startServiceIpcSeam>> | null = null;
    try {
      ipc = await startServiceIpcSeam(home, mutations);
    } finally {
      cap.restore();
    }
    try {
      const client = await connectService(home);
      try {
        const restart = await client.request("restart-service", {
          requestId: "restart-request-1",
          originServerId: "11111111-1111-4111-8111-111111111111",
        });
        assert.equal(restart.status, "accepted");
        const svc = await client.request("reset-service", undefined);
        assert.equal(svc.status, "ok");
        assert.equal(svc.clearedCrashCount, 2);
        const SERVER = "11111111-1111-4111-8111-111111111111";
        const run = await client.request("reset-runner", { serverId: SERVER });
        assert.equal(run.status, "ok");
        assert.equal(run.status === "ok" && run.serverId, SERVER);
        const up = await client.request("upgrade-start", {
          scope: "remote",
          targetVersion: "1.2.3",
          requestId: "web-request-1",
          originServerId: SERVER,
          trigger: "web",
        });
        assert.equal(up.status, "started");
        assert.equal(up.targetVersion, "1.2.3");
        // The handlers ran the SUPERVISOR mutation surface (in-memory aware),
        // not the lib-pure disk-only fallback / not-implemented stub.
        assert.deepEqual(calls, [
          "restart-service:restart-request-1:11111111-1111-4111-8111-111111111111",
          "reset-service",
          `reset-runner:${SERVER}`,
          `upgrade-start:1.2.3:web-request-1:${SERVER}:web`,
        ]);
      } finally {
        await client.close();
      }
    } finally {
      if (ipc) await ipc.close();
    }
  });
});

test("startServiceIpcSeam: `restart-service` requires a live supervisor mutation surface", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer", "run"), { recursive: true });
    const cap = captureOut();
    let ipc: Awaited<ReturnType<typeof startServiceIpcSeam>> | null = null;
    try {
      ipc = await startServiceIpcSeam(home);
    } finally {
      cap.restore();
    }
    try {
      const client = await connectService(home);
      try {
        await assert.rejects(
          () => client.request("restart-service", undefined),
          (e: unknown) =>
            typeof e === "object" &&
            e !== null &&
            "code" in e &&
            (e as { code?: string }).code === "IPC_MALFORMED_FRAME" &&
            /requires a live supervisor mutation surface/.test(String((e as { message?: unknown }).message)),
        );
      } finally {
        await client.close();
      }
    } finally {
      if (ipc) await ipc.close();
    }
  });
});

test("requestServiceSelfRestartAfterUpgrade carries the parent-lock marker and exits only after replacement owns the IPC boundary", async () => {
  await withHome(async (home) => {
    const calls: string[] = [];
    await requestServiceSelfRestartAfterUpgrade(home, {
      releaseServiceOwnership: async () => { calls.push("release"); },
      restoreServiceOwnership: async () => { calls.push("forbidden-restore"); },
      spawnDetachedServiceFn: async (actualHome, opts) => {
        const childEnv = buildDetachedServiceEnv({}, opts);
        calls.push(`spawn:${actualHome}:${childEnv[PARENT_LOCK_HELD_ENV_VAR]}`);
        return 12345;
      },
      readReplacementAttestationFn: async () => {
        calls.push("attested");
        return {
          computerVersion: COMPUTER_VERSION,
          serviceGeneration: "replacement-generation",
          servicePid: 12345,
          sourceServicePid: process.pid,
          managedServerIds: [],
          managedMachineIdentities: {},
          managedSetRevision: "replacement-revision",
        };
      },
      listManagedServerIdsFn: async () => [],
      scheduleCurrentServiceExit: () => { calls.push("schedule-exit"); },
    });

    assert.deepEqual(calls, [
      "release",
      `spawn:${home}:1`,
      "attested",
      "schedule-exit",
    ]);
  });
});

test("upgrade handoff rejects a replacement service that does not run the exact requested version", async () => {
  await withHome(async (home) => {
    const calls: string[] = [];
    await assert.rejects(
      requestServiceSelfRestartAfterUpgrade(home, {
        expectedComputerVersion: "9.9.9",
        releaseServiceOwnership: async () => { calls.push("release"); },
        restoreServiceOwnership: async () => { calls.push("restore"); },
        spawnDetachedServiceFn: async () => 34567,
        readReplacementAttestationFn: async () => ({
          computerVersion: "9.9.8",
          serviceGeneration: "replacement-generation",
          servicePid: 34567,
          sourceServicePid: process.pid,
          managedServerIds: [],
          managedMachineIdentities: {},
          managedSetRevision: "replacement-revision",
        }),
        listManagedServerIdsFn: async () => [],
        killProcess: (pid, signal) => { calls.push(`kill:${pid}:${signal}`); },
        isProcessAliveFn: () => false,
        takeoverTimeoutMs: 0,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: string }).code, "SELF_RELAUNCH_UNAVAILABLE");
        assert.match(error.message, /expected 9\.9\.9, got 9\.9\.8/);
        return true;
      },
    );
    assert.deepEqual(calls, ["release", "kill:34567:SIGTERM", "restore"]);
  });
});

test("installer migration keeps detached Computer ready when optional manager cleanup fails", async () => {
  await withHome(async (home) => {
    const calls: string[] = [];
    const outcome = await migrateLegacyOsSupervisorInstall(
      home,
      process.execPath,
      {
        retire: async () => {
          calls.push("cleanup-attempt");
          return {
            status: "incomplete",
            kind: "systemd-user",
            id: "raft-computer-test.service",
            managerUnloaded: false,
            definitionRemoved: false,
            receiptPath: join(
              home,
              "computer",
              "legacy-os-supervisor-retirement.json",
            ),
            message:
              "legacy_os_supervisor_cleanup_incomplete: Computer remains usable",
          };
        },
        listAttached: async () => [SERVER_A],
        withLock: async (_home, fn) => {
          calls.push("lock");
          return fn(new AbortController().signal);
        },
        stopService: async () => {
          calls.push("stop-old-owner");
          return {
            status: "stopped",
            pid: 111,
            pidfilePath: servicePidPath(home),
          };
        },
        startService: async () => {
          calls.push("start-detached");
          return {
            status: "spawned",
            managedTargets: [SERVER_A],
            attachedCount: 1,
            ready: new Map([[SERVER_A, 222]]),
            servicePid: 333,
            serviceLogPath: join(home, "computer", "run", "service.log"),
          };
        },
      },
    );
    assert.equal(outcome.retirement.status, "incomplete");
    assert.equal(outcome.lifecycle, "detached-ready");
    assert.deepEqual(calls, [
      "lock",
      "cleanup-attempt",
      "stop-old-owner",
      "start-detached",
    ]);
  });
});

test("installer migration rejects stop failure instead of claiming optional cleanup success", async () => {
  await assert.rejects(
    migrateLegacyOsSupervisorInstall("/tmp/home", "/tmp/raft-computer", {
      listAttached: async () => [SERVER_A],
      withLock: async (_home, fn) => fn(new AbortController().signal),
      retire: async () => ({
        status: "absent",
        kind: "systemd-user",
        id: "raft-computer-test.service",
        managerUnloaded: true,
        definitionRemoved: true,
        receiptPath: "/tmp/receipt",
        message: "absent",
      }),
      stopService: async () => {
        throw new Error("STOP_SIGNAL_FAILED");
      },
      startService: async () => {
        throw new Error("must not start after stop failure");
      },
    }),
    /STOP_SIGNAL_FAILED/,
  );
});

test("installer migration rejects detached start failure after successful retirement and stop", async () => {
  await assert.rejects(
    migrateLegacyOsSupervisorInstall("/tmp/home", "/tmp/raft-computer", {
      listAttached: async () => [SERVER_A],
      withLock: async (_home, fn) => fn(new AbortController().signal),
      retire: async () => ({
        status: "retired",
        kind: "launchd-user",
        id: "com.raft.computer.test",
        managerUnloaded: true,
        definitionRemoved: true,
        receiptPath: "/tmp/receipt",
        message: "retired",
      }),
      stopService: async () => ({
        status: "stopped",
        pid: 123,
        pidfilePath: "/tmp/service.pid",
      }),
      startService: async () => {
        throw new Error("START_DAEMON_TIMEOUT");
      },
    }),
    /START_DAEMON_TIMEOUT/,
  );
});

test("machine service attestation binds each managed server to its stable Computer identity", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await setServerManaged(home, SERVER_A);
    const attestation = await createMachineAttestationHandler(home, 24680)();
    assert.deepEqual(attestation.managedServerIds, [SERVER_A]);
    assert.deepEqual(attestation.managedMachineIdentities, {
      [SERVER_A]: `cm-${SERVER_A}`,
    });
    assert.equal(attestation.sourceServicePid, 24680);
  });
});

test("requestServiceSelfRestartAfterUpgrade ignores a legacy OS-supervisor marker and self-respawns", async () => {
  await withHome(async (home) => {
    const calls: string[] = [];
    await requestServiceSelfRestartAfterUpgrade(home, {
      env: { RAFT_COMPUTER_OS_SUPERVISOR_KIND: "systemd-user" },
      releaseServiceOwnership: async () => { calls.push("release"); },
      restoreServiceOwnership: async () => { calls.push("forbidden-restore"); },
      spawnDetachedServiceFn: async () => {
        calls.push("detached-spawn");
        return 12345;
      },
      readReplacementAttestationFn: async () => ({
        computerVersion: COMPUTER_VERSION,
        serviceGeneration: "replacement-generation",
        servicePid: 12345,
        sourceServicePid: process.pid,
        managedServerIds: [],
        managedMachineIdentities: {},
        managedSetRevision: "replacement-revision",
      }),
      listManagedServerIdsFn: async () => [],
      scheduleCurrentServiceExit: () => { calls.push("schedule-exit"); },
    });

    assert.deepEqual(calls, ["release", "detached-spawn", "schedule-exit"]);
  });
});

test("requestServiceSelfRestartAfterUpgrade restores the incumbent when child PID never proves takeover", async () => {
  await withHome(async (home) => {
    const calls: string[] = [];
    await assert.rejects(
      requestServiceSelfRestartAfterUpgrade(home, {
        releaseServiceOwnership: async () => { calls.push("release"); },
        restoreServiceOwnership: async () => { calls.push("restore"); },
        spawnDetachedServiceFn: async () => {
          calls.push("spawn");
          return 12345;
        },
        readReplacementAttestationFn: async () => {
          calls.push("unproven");
          return null;
        },
        listManagedServerIdsFn: async () => [],
        killProcess: (pid, signal) => { calls.push(`kill:${pid}:${signal}`); },
        isProcessAliveFn: () => false,
        sleep: async () => {},
        takeoverTimeoutMs: 0,
        scheduleCurrentServiceExit: () => { calls.push("forbidden-exit"); },
      }),
      /SELF_RELAUNCH_UNAVAILABLE/,
    );

    assert.deepEqual(calls, [
      "release",
      "spawn",
      "unproven",
      "kill:12345:SIGTERM",
      "restore",
    ]);
  });
});

test("requestServiceSelfRestartAfterUpgrade rejects a replacement with a changed machine identity", async () => {
  await withHome(async (home) => {
    const calls: string[] = [];
    await assert.rejects(
      requestServiceSelfRestartAfterUpgrade(home, {
        releaseServiceOwnership: async () => { calls.push("release"); },
        restoreServiceOwnership: async () => { calls.push("restore"); },
        spawnDetachedServiceFn: async () => 34567,
        readReplacementAttestationFn: async () => ({
          computerVersion: COMPUTER_VERSION,
          serviceGeneration: "replacement-generation",
          servicePid: 34567,
          sourceServicePid: process.pid,
          managedServerIds: [SERVER_A],
          managedMachineIdentities: { [SERVER_A]: "changed-machine" },
          managedSetRevision: "replacement-revision",
        }),
        listManagedServerIdsFn: async () => [SERVER_A],
        readManagedMachineIdentitiesFn: async () => ({ [SERVER_A]: "original-machine" }),
        killProcess: (pid, signal) => { calls.push(`kill:${pid}:${signal}`); },
        isProcessAliveFn: () => false,
        takeoverTimeoutMs: 0,
      }),
      /SELF_RELAUNCH_UNAVAILABLE/,
    );
    assert.deepEqual(calls, ["release", "kill:34567:SIGTERM", "restore"]);
  });
});

test("requestServiceSelfRestartAfterUpgrade rejects incomplete incumbent identity before releasing IPC", async () => {
  for (const identities of [{}, { [SERVER_A]: "" }] as Array<
    Record<string, string>
  >) {
    await withHome(async (home) => {
      const calls: string[] = [];
      await assert.rejects(
        requestServiceSelfRestartAfterUpgrade(home, {
          releaseServiceOwnership: async () => {
            calls.push("forbidden-release");
          },
          restoreServiceOwnership: async () => {
            calls.push("forbidden-restore");
          },
          spawnDetachedServiceFn: async () => {
            calls.push("forbidden-spawn");
            return 34567;
          },
          listManagedServerIdsFn: async () => [SERVER_A],
          readManagedMachineIdentitiesFn: async () => identities,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            (error as { code?: string }).code,
            "SELF_RELAUNCH_UNAVAILABLE",
          );
          assert.match(error.message, /managed identity/i);
          return true;
        },
      );
      assert.deepEqual(calls, []);
    });
  }
});

test("requestServiceSelfRestartAfterUpgrade kills a candidate with missing or empty identity and restores IPC", async () => {
  for (const identities of [{}, { [SERVER_A]: "" }] as Array<
    Record<string, string>
  >) {
    await withHome(async (home) => {
      const calls: string[] = [];
      await assert.rejects(
        requestServiceSelfRestartAfterUpgrade(home, {
          releaseServiceOwnership: async () => {
            calls.push("release");
          },
          restoreServiceOwnership: async () => {
            calls.push("restore");
          },
          spawnDetachedServiceFn: async () => {
            calls.push("spawn");
            return 34567;
          },
          readReplacementAttestationFn: async () => {
            calls.push("attested");
            return {
              computerVersion: COMPUTER_VERSION,
              serviceGeneration: "replacement-generation",
              servicePid: 34567,
              sourceServicePid: process.pid,
              managedServerIds: [SERVER_A],
              managedMachineIdentities: identities,
              managedSetRevision: "replacement-revision",
            };
          },
          listManagedServerIdsFn: async () => [SERVER_A],
          readManagedMachineIdentitiesFn: async () => ({
            [SERVER_A]: "original-machine",
          }),
          killProcess: (pid, signal) => {
            calls.push(`kill:${pid}:${signal}`);
          },
          isProcessAliveFn: () => false,
          takeoverTimeoutMs: 0,
        }),
        /SELF_RELAUNCH_UNAVAILABLE/,
      );
      assert.deepEqual(calls, [
        "release",
        "spawn",
        "attested",
        "kill:34567:SIGTERM",
        "restore",
      ]);
    });
  }
});

test("requestServiceSelfRestartAfterUpgrade waits for the exact failed candidate before restoring IPC", async () => {
  await withHome(async (home) => {
    const calls: string[] = [];
    const alive = [true, false, false];
    await assert.rejects(
      requestServiceSelfRestartAfterUpgrade(home, {
        releaseServiceOwnership: async () => { calls.push("release"); },
        restoreServiceOwnership: async () => { calls.push("restore"); },
        spawnDetachedServiceFn: async () => 45678,
        readReplacementAttestationFn: async () => null,
        listManagedServerIdsFn: async () => [],
        killProcess: (pid, signal) => { calls.push(`kill:${pid}:${signal}`); },
        isProcessAliveFn: () => alive.shift() ?? false,
        sleep: async () => { calls.push("wait-for-candidate-exit"); },
        takeoverTimeoutMs: 0,
        candidateShutdownTimeoutMs: 1_000,
      }),
      /SELF_RELAUNCH_UNAVAILABLE/,
    );

    assert.deepEqual(calls, [
      "release",
      "kill:45678:SIGTERM",
      "wait-for-candidate-exit",
      "restore",
    ]);
  });
});

test("requestServiceSelfRestartAfterUpgrade restores and types a partially failed listener release", async () => {
  await withHome(async (home) => {
    const calls: string[] = [];
    await assert.rejects(
      requestServiceSelfRestartAfterUpgrade(home, {
        releaseServiceOwnership: async () => {
          calls.push("release-closed-listener");
          throw new Error("partial-release");
        },
        restoreServiceOwnership: async () => {
          calls.push("restore");
        },
        spawnDetachedServiceFn: async () => {
          calls.push("forbidden-spawn");
          return 12345;
        },
        listManagedServerIdsFn: async () => [],
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as { code?: string }).code,
          "SELF_RELAUNCH_UNAVAILABLE",
        );
        assert.match(error.message, /partial-release/);
        return true;
      },
    );
    assert.deepEqual(calls, ["release-closed-listener", "restore"]);
  });
});

test("requestServiceSelfRestartAfterUpgrade retries incumbent ownership restoration after candidate spawn failure", async () => {
  await withHome(async (home) => {
    const calls: string[] = [];
    let restoreAttempts = 0;
    let now = 0;
    await assert.rejects(
      requestServiceSelfRestartAfterUpgrade(home, {
        releaseServiceOwnership: async () => {
          calls.push("release");
        },
        restoreServiceOwnership: async () => {
          restoreAttempts += 1;
          calls.push(`restore:${restoreAttempts}`);
          if (restoreAttempts === 1) throw new Error("restore-bind-failed");
        },
        spawnDetachedServiceFn: async () => {
          calls.push("spawn");
          throw new Error("spawn-failed");
        },
        listManagedServerIdsFn: async () => [],
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          calls.push(`sleep:${ms}`);
        },
        restoreOwnershipTimeoutMs: 100,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as { code?: string }).code,
          "SELF_RELAUNCH_UNAVAILABLE",
        );
        assert.match(error.message, /spawn-failed/);
        return true;
      },
    );
    assert.deepEqual(calls, [
      "release",
      "spawn",
      "restore:1",
      "sleep:50",
      "restore:2",
    ]);
  });
});

test("requestServiceSelfRestartAfterUpgrade preserves the original failure when bounded restore also fails", async () => {
  await withHome(async (home) => {
    let now = 0;
    await assert.rejects(
      requestServiceSelfRestartAfterUpgrade(home, {
        releaseServiceOwnership: async () => {},
        restoreServiceOwnership: async () => {
          throw new Error("restore-bind-terminal");
        },
        spawnDetachedServiceFn: async () => {
          throw new Error("spawn-original");
        },
        listManagedServerIdsFn: async () => [],
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        restoreOwnershipTimeoutMs: 50,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as { code?: string }).code,
          "SELF_RELAUNCH_UNAVAILABLE",
        );
        assert.match(error.message, /spawn-original/);
        assert.match(error.message, /restore-bind-terminal/);
        return true;
      },
    );
  });
});

test("service control overlap accepts only exact replay and rejects every competing action", () => {
  const active = { action: "upgrade" as const, requestId: "upgrade-1" };
  assert.equal(checkServiceControlAvailability(null, "restart", "restart-1"), "available");
  assert.equal(checkServiceControlAvailability(active, "upgrade", "upgrade-1"), "replay");
  assert.throws(
    () => checkServiceControlAvailability(active, "restart", "restart-1"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "CONTROL_BUSY");
      return true;
    },
  );
  assert.throws(
    () => checkServiceControlAvailability(active, "upgrade", "upgrade-2"),
    /CONTROL_BUSY/,
  );
  assert.throws(
    () => checkServiceControlAvailability(active, "upgrade", undefined),
    /CONTROL_BUSY/,
  );
});

test("runService mutation handlers claim upgrade control before async resolution and preserve exact replay", async () => {
  await withHome(async () => {
    let resolveChannel!: () => void;
    let enteredChannel!: () => void;
    const channelEntered = new Promise<void>((resolve) => {
      enteredChannel = resolve;
    });
    const channelGate = new Promise<void>((resolve) => {
      resolveChannel = resolve;
    });
    let channelReads = 0;
    const targetResolutions: unknown[] = [];
    let upgradeTasks = 0;
    await runService({
      isSeaBinaryFn: () => true,
      requestSelfRestart: async () => {},
      readChannelFn: async () => {
        channelReads += 1;
        enteredChannel();
        await channelGate;
        return "alpha";
      },
      resolveUpgradeTargetVersionFn: async (channel, context) => {
        targetResolutions.push({ channel, context });
        return "1.0.8";
      },
      spawnKUpgradeCoordinatorFn: async () => {
        upgradeTasks += 1;
        return { pid: 34567, once: () => ({}) } as never;
      },
      waitForKUpgradeStartFn: async () => {},
      onMutationsReady: async (mutations) => {
        const upgradeA = mutations.upgradeStart({
          scope: "remote",
          requestId: "upgrade-a",
          originServerId: SERVER_A,
          trigger: "web",
        });
        await channelEntered;
        const upgradeB = mutations.upgradeStart({
          scope: "remote",
          requestId: "upgrade-b",
          originServerId: SERVER_A,
          trigger: "web",
        });
        const restartC = mutations.restartService({
          requestId: "restart-c",
          originServerId: SERVER_A,
        });
        const exactReplayA = mutations.upgradeStart({
          scope: "remote",
          requestId: "upgrade-a",
          originServerId: SERVER_A,
          trigger: "web",
        });
        const wrongOriginReplayA = mutations.upgradeStart({
          scope: "remote",
          requestId: "upgrade-a",
          originServerId: SERVER_B,
          trigger: "web",
        });

        await assert.rejects(upgradeB, (error: unknown) => {
          assert.equal((error as { code?: string }).code, "CONTROL_BUSY");
          return true;
        });
        await assert.rejects(restartC, (error: unknown) => {
          assert.equal((error as { code?: string }).code, "CONTROL_BUSY");
          return true;
        });
        await assert.rejects(wrongOriginReplayA, (error: unknown) => {
          assert.equal((error as { code?: string }).code, "CONTROL_BUSY");
          assert.match((error as Error).message, /identity does not match/u);
          return true;
        });
        resolveChannel();
        const [first, replay] = await Promise.all([upgradeA, exactReplayA]);
        assert.deepEqual(first, {
          status: "started",
          upgradeId: "upgrade-a",
          targetVersion: "1.0.8",
        });
        assert.deepEqual(replay, first);
      },
      stopAfterMutationsReady: true,
    });
    assert.equal(
      channelReads,
      1,
      "only one upgrade may enter async target resolution",
    );
    assert.equal(
      upgradeTasks,
      1,
      "exact replay must not start a second swap task",
    );
    assert.deepEqual(targetResolutions, [{
      channel: "alpha",
      context: {
        currentVersion: COMPUTER_VERSION,
        platformKey: `${process.platform}-${process.arch}`,
      },
    }], "the saved Alpha channel must enter the same target resolver exactly once");
  });
});

test("runService publishes its live IPC handle before accepting a restart request", async () => {
  await withHome(async (home) => {
    const calls: string[] = [];
    let restartResult: unknown;
    const cap = captureOut();
    try {
      await runService({
        serviceSelfRestartDeps: {
          spawnDetachedServiceFn: async () => {
            calls.push("spawn-replacement");
            return 34567;
          },
          readReplacementAttestationFn: async () => ({
            computerVersion: COMPUTER_VERSION,
            serviceGeneration: "replacement-generation",
            servicePid: 34567,
            sourceServicePid: process.pid,
            managedServerIds: [],
            managedMachineIdentities: {},
            managedSetRevision: "replacement-revision",
          }),
          listManagedServerIdsFn: async () => [],
          readManagedMachineIdentitiesFn: async () => ({}),
          scheduleCurrentServiceExit: () => {
            calls.push("schedule-exit");
          },
        },
        serviceIdentityPublishDeps: {
          writePidfileAtFn: async () => {
            const client = await connectService(home);
            try {
              restartResult = await client.request("restart-service", undefined);
              calls.push("restart-accepted-during-publication");
            } finally {
              await client.close();
            }
          },
          writeServiceVersionEvidenceFn: async () => {},
        },
        shutdownServiceFn: (shutdownDeps) => shutdownService({
          ...shutdownDeps,
          exit: () => {},
        }),
        afterIpcReady: async (shutdown) => {
          await shutdown();
        },
      });
    } finally {
      cap.restore();
    }

    assert.deepEqual(restartResult, { status: "accepted" });
    assert.deepEqual(calls, [
      "spawn-replacement",
      "schedule-exit",
      "restart-accepted-during-publication",
    ]);
  });
});

test("buildDetachedServiceEnv: false parent lock option strips inherited marker for self-restart", () => {
  const env = buildDetachedServiceEnv(
    {
      PATH: "/bin",
      [PARENT_LOCK_HELD_ENV_VAR]: "1",
      [OS_SUPERVISOR_KIND_ENV_VAR]: "launchd-user",
    },
    { parentMutationLockHeld: false },
  );

  assert.equal(env.PATH, "/bin");
  assert.equal(env[PARENT_LOCK_HELD_ENV_VAR], undefined);
  assert.equal(env[OS_SUPERVISOR_KIND_ENV_VAR], undefined);
});

test("buildDetachedServiceEnv: default marks CLI-spawned service as parent-lock protected", () => {
  const env = buildDetachedServiceEnv({ PATH: "/bin" });

  assert.equal(env.PATH, "/bin");
  assert.equal(env[PARENT_LOCK_HELD_ENV_VAR], "1");
});

test("buildRunnerChildEnv preserves the launchd discovery PATH while stripping service-only markers", () => {
  const pathValue =
    "/Users/example/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const env = buildRunnerChildEnv({
    PATH: pathValue,
    HOME: "/Users/example",
    [PARENT_LOCK_HELD_ENV_VAR]: "1",
    RAFT_COMPUTER_SOURCE_SERVICE_PID: "123",
    RAFT_COMPUTER_OS_SUPERVISOR_KIND: "launchd-user",
  });

  assert.equal(env.PATH, pathValue);
  assert.equal(env.HOME, "/Users/example");
  assert.equal(env[PARENT_LOCK_HELD_ENV_VAR], undefined);
  assert.equal(env.RAFT_COMPUTER_SOURCE_SERVICE_PID, undefined);
  assert.equal(env.RAFT_COMPUTER_OS_SUPERVISOR_KIND, undefined);
});

test("a runner child can resolve an external runtime probe through the inherited launchd PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "raft-launchd-path-probe-"));
  t.onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const userBin = join(root, ".local", "bin");
  const runtimePath = join(userBin, "cursor-agent");
  await mkdir(userBin, { recursive: true });
  await writeFile(runtimePath, "#!/bin/sh\necho cursor-agent-test\n");
  await chmod(runtimePath, 0o755);

  const childEnv = buildRunnerChildEnv({
    PATH: `${userBin}:/usr/bin:/bin`,
    HOME: root,
    [OS_SUPERVISOR_KIND_ENV_VAR]: "launchd-user",
  });
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      "const {spawnSync}=require('node:child_process');const r=spawnSync('cursor-agent',['--version'],{encoding:'utf8'});if(r.status!==0)process.exit(1);process.stdout.write(r.stdout)",
    ],
    { env: childEnv, encoding: "utf8" },
  );

  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), "cursor-agent-test");
});

test("a systemd runner child can resolve Codex from the selected NVM bin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "raft-systemd-nvm-path-probe-"));
  t.onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const nvmBin = join(root, ".nvm", "versions", "node", "v24.15.0", "bin");
  const codexPath = join(nvmBin, "codex");
  await mkdir(nvmBin, { recursive: true });
  await writeFile(codexPath, "#!/bin/sh\necho codex-app-server-test\n");
  await chmod(codexPath, 0o755);

  const childEnv = buildRunnerChildEnv({
    PATH: buildSystemdDiscoveryPath(
      root,
      `/tmp/hostile:${nvmBin}:/opt/private/bin`,
    ),
    HOME: root,
    [OS_SUPERVISOR_KIND_ENV_VAR]: "systemd-user",
  });
  const probe = spawnSync("codex", ["app-server", "--help"], {
    env: childEnv,
    encoding: "utf8",
  });

  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), "codex-app-server-test");
  assert.doesNotMatch(childEnv.PATH ?? "", /hostile|private/);
});

test("startServiceIpcSeam: `runner-status` for an unattached server surfaces a typed IPC error (NOT_ATTACHED)", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer", "run"), { recursive: true });
    const cap = captureOut();
    let ipc: Awaited<ReturnType<typeof startServiceIpcSeam>> | null = null;
    try {
      ipc = await startServiceIpcSeam(home);
    } finally {
      cap.restore();
    }
    try {
      const client = await connectService(home);
      try {
        await assert.rejects(
          () => client.request("runner-status", { serverId: SERVER_A }),
          (err: unknown) => {
            // The handler throws a `ServiceClientError` (closed-set IpcErrorCode);
            // the wire round-trip preserves both `code` and `message`.
            const e = err as { code?: string; message?: string };
            return e.code === "IPC_MALFORMED_FRAME" && /NOT_ATTACHED/.test(e.message ?? "");
          },
        );
      } finally {
        await client.close();
      }
    } finally {
      if (ipc) await ipc.close();
    }
  });
});

test("requestServiceUpgradeViaIpc preserves requestId and relays supervisor progress + terminal events", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer", "run"), { recursive: true });
    let ipc: Awaited<ReturnType<typeof startServiceIpcSeam>> | null = null;
    const cap = captureOut();
    try {
      ipc = await startServiceIpcSeam(home, {
        restartService: async () => ({ status: "accepted" }),
        resetService: async () => ({ status: "ok", previousState: "running", clearedCrashCount: 0 }),
        resetRunner: async (serverId) => ({ status: "not-found", serverId }),
        upgradeStart: async (params) => {
          assert.deepEqual(params, {
            scope: "remote",
            requestId: "web-upgrade-1",
            originServerId: SERVER_A,
            trigger: "web",
          });
          const immediate = setImmediate(() => {
            ipc?.broadcast({
              kind: "upgrade-progressed",
              payload: {
                requestId: "web-upgrade-1",
                phase: "downloading",
                message: "fetching",
                percent: 42,
                fromVersion: "0.72.6",
                targetVersion: "0.72.7",
              },
            });
            ipc?.broadcast({
              kind: "upgrade-completed",
              payload: { requestId: "web-upgrade-1", ok: false, error: "test-stop" },
            });
          });
          immediate.unref();
          return { status: "started", upgradeId: "web-upgrade-1", targetVersion: "0.72.7" };
        },
      });
    } finally {
      cap.restore();
    }

    const progress: unknown[] = [];
    const completed: unknown[] = [];
    try {
      await requestServiceUpgradeViaIpc(home, SERVER_A, "web-upgrade-1", {
        emitUpgradeProgress: (event) => progress.push(event),
        emitUpgradeDone: (event) => completed.push(event),
      });
      assert.deepEqual(progress, [{
        phase: "downloading",
        message: "fetching",
        percent: 42,
        fromVersion: "0.72.6",
        targetVersion: "0.72.7",
      }]);
      assert.deepEqual(completed, [{ ok: false, error: "test-stop" }]);
    } finally {
      await ipc?.close();
    }
  });
});

test("requestServiceUpgradeViaIpc rejects a different in-flight upgrade instead of orphaning the Web request", async () => {
  const completed: unknown[] = [];
  await requestServiceUpgradeViaIpc("/unused", SERVER_A, "web-upgrade-2", {
    emitUpgradeProgress: () => assert.fail("must not emit progress"),
    emitUpgradeDone: (event) => completed.push(event),
  }, {
    connectServiceFn: async () => ({
      request: async () => ({
        status: "already-running",
        upgradeId: "cli-upgrade-1",
        targetVersion: "0.72.7",
      }),
      events: {
        async *[Symbol.asyncIterator]() {
          assert.fail("must not attach to a different request id");
        },
      },
      close: async () => {},
    }),
  });
  assert.deepEqual(completed, [{
    ok: false,
    error: "UPGRADE_ALREADY_RUNNING: upgrade cli-upgrade-1 to 0.72.7 is already running",
  }]);
});

test("resolveResidentSlockCliPath: SEA → __cli sentinel (ignores env)", () => {
  assert.equal(resolveResidentSlockCliPath(true, {}), "__cli");
  assert.equal(resolveResidentSlockCliPath(true, { [RESIDENT_CLI_PATH_ENV_VAR]: "/x/cli.js" }), "__cli");
});

test("resolveResidentSlockCliPath: non-SEA + injected RAFT_COMPUTER_CLI_PATH → that path (Electron host case)", () => {
  assert.equal(
    resolveResidentSlockCliPath(false, { [RESIDENT_CLI_PATH_ENV_VAR]: "/Applications/Raft Computer.app/Contents/Resources/cli/index.js" }),
    "/Applications/Raft Computer.app/Contents/Resources/cli/index.js",
  );
});

test("resolveResidentSlockCliPath: non-SEA + no env → undefined (normal node install, daemon self-resolves)", () => {
  assert.equal(resolveResidentSlockCliPath(false, {}), undefined);
  // empty string is treated as unset (falsy), not a bogus path
  assert.equal(resolveResidentSlockCliPath(false, { [RESIDENT_CLI_PATH_ENV_VAR]: "" }), undefined);
});
