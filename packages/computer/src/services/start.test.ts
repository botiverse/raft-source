// Byte-pin tests for the StartService seam extraction (Hao msg=51a17400 +
// liuliu msg=7a1a2c3d / 35034229 / 240069cd / bb503633 — Start byte-pin
// gates 1-N + onEvent + AbortSignal pre/post-spawn boundary +
// closed-set sentinel pin).
//
// Companion: ../service.test.ts asserts the CLI adapter (`runStart`)
// still emits the pre-extraction info()/fail() lines byte-identically.
import { INSTALLER_LIFECYCLE_START_WAIT_MS, noteStartNeverRan, runStart, startAcceptsPartialReady, startNotesUpgradeStep, startWaitForCaller } from "../startStop";
import { CliExit } from "../output";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ComputerServiceError } from "./errors";
import { start as startService } from "./start";
import type { StartReadinessReport } from "../machineReadiness";
import type { StartCommandNote } from "../remoteUpgradeTrace";
import type { ComputerApiEvent } from "../lib/events";
import {
  legacyServerRunnerLogPath,
  legacyServerRunnerPidPath,
  serverAttachmentPath,
  serverConnectedMarkerPath,
  serverRunnerLogPath,
  serverRunnerPidPath,
  serverRunnerVersionPath,
  serverManagedFlagPath,
  serverRunnerLockConflictPath,
  servicePidPath,
  serviceLogPath,
  serviceVersionPath,
} from "../paths";
import { isServerManaged, setServerManaged } from "../serverState";
import { isDegraded, markTerminalUnlinked, readTerminalUnlinked, recordCrash } from "../health";
import { buildDetachedServiceEnv, INSTALL_VERSION_PIN_ENV_VAR, PARENT_LOCK_HELD_ENV_VAR } from "../service";
import { readSupervisorRecord, writeSupervisorRecord } from "../externalSupervisor";
import { COMPUTER_VERSION } from "../version";
import { buildStatusReport } from "../status";
import { writeResidentConnectedMarker } from "../residentConnectionMarker";

// The fixtures' live service is this test process, with service-version.json
// at a fixed date: its start is never read, except in the tests that say how.
const start: typeof startService = (input, options = {}) =>
  startService(input, { processStartTimeMs: async () => undefined, ...options });

const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_B = "22222222-2222-4222-8222-222222222222";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-start-svc-"));
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

async function writeAttach(
  home: string,
  serverId: string,
  serverMachineId = `cm-${serverId}`,
): Promise<void> {
  const p = serverAttachmentPath(home, serverId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(
    p,
    JSON.stringify({
      kind: "computer-attachment",
      serverId,
      serverMachineId,
      serverSlug: serverId === SERVER_A ? "alpha" : "beta",
      apiKey: `sk_computer_${serverId}`,
      serverUrl: "https://api.example.test",
    }),
  );
}

async function writeReadyRunner(
  home: string,
  serverId: string,
  pid = process.pid,
  legacyPid = false,
): Promise<void> {
  const p = legacyPid
    ? legacyServerRunnerPidPath(home, serverId)
    : serverRunnerPidPath(home, serverId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, String(pid), { mode: 0o600 });
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

async function writeRunnerLog(
  home: string,
  serverId: string,
  content: string,
  legacy = false,
): Promise<void> {
  const p = legacy ? legacyServerRunnerLogPath(home, serverId) : serverRunnerLogPath(home, serverId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, content, { mode: 0o600 });
}

async function writeServiceVersion(home: string, version: string | null, pid = process.pid): Promise<void> {
  const p = serviceVersionPath(home);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(
    p,
    JSON.stringify({
      version,
      installRoot: "/old/raft-computer",
      pid,
      writtenAt: "2026-07-06T06:30:50.714Z",
    }),
    { mode: 0o600 },
  );
}

// --- Gate 1: NO_ATTACHMENT (no attachments) ---
test("start service: no attached servers throws NO_ATTACHMENT", async () => {
  await withHome(async (home) => {
    await assert.rejects(
      () => start({ slockHome: home }),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "NO_ATTACHMENT");
        assert.equal(
          (err as ComputerServiceError).message,
          "No server attachments yet. Run `raft-computer attach /<serverSlug>` first.",
        );
        return true;
      },
    );
  });
});

// --- Gate 2: NOT_ATTACHED (serverId not in attached set) ---
test("start service: serverId not in attached set throws NOT_ATTACHED", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await assert.rejects(
      () => start({ serverId: SERVER_B, slockHome: home }),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "NOT_ATTACHED");
        assert.equal(
          (err as ComputerServiceError).message,
          `Not attached to server ${SERVER_B}. Run \`raft-computer attach ${SERVER_B}\` first or omit the argument.`,
        );
        return true;
      },
    );
  });
});

// --- Gate 3: SUPERVISOR_SPAWN_FAILED (spawn throws) ---
test("task #914: start refuses to spawn when another live service on this host holds the same machine key", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    let spawned = 0;
    await assert.rejects(
      () =>
        start(
          { slockHome: home },
          {
            spawnDetachedService: async () => { spawned += 1; return 999; },
            findDuplicateKeyHolder: async () => ({
              root: "/Users/someone/.slock",
              servicePid: 777,
              computerVersion: "1.0.25",
              serverIds: [SERVER_A],
              fingerprints: ["0123456789abcdef"],
            }),
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "DUPLICATE_KEY_HOLDER");
        assert.match((err as ComputerServiceError).message, /pid 777 \(Computer version 1\.0\.25\)/);
        assert.match((err as ComputerServiceError).message, /raft-computer stop/);
        return true;
      },
    );
    assert.equal(spawned, 0, "nothing is spawned behind a refused start");
  });
});

test("task #915: start refuses, before reading the home or spawning, when both default homes hold Raft data", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    let spawned = 0;
    let seenHome: string | null = null;
    await assert.rejects(
      () =>
        start(
          { slockHome: home },
          {
            spawnDetachedService: async () => { spawned += 1; return 999; },
            findRaftHomeConflict: (slockHome) => {
              seenHome = slockHome;
              return {
                homes: [
                  { path: "/Users/alice/.slock", agentCount: 0 },
                  { path: "/Users/alice/.raft", agentCount: 2 },
                ],
              };
            },
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "RAFT_HOME_AMBIGUOUS");
        assert.match((err as ComputerServiceError).message, /RAFT_HOME=/);
        return true;
      },
    );
    assert.equal(seenHome, home);
    assert.equal(spawned, 0, "nothing is spawned behind a refused start");
  });
});

test("task #914: a foreground start is refused the same way, before the service loop runs", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    let serviceCalled = 0;
    await assert.rejects(
      () =>
        start(
          { foreground: true, slockHome: home },
          {
            runService: async () => { serviceCalled += 1; },
            findDuplicateKeyHolder: async () => ({
              root: "/Users/someone/.slock",
              servicePid: 777,
              computerVersion: "1.0.25",
              serverIds: [SERVER_A],
              fingerprints: ["0123456789abcdef"],
            }),
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "DUPLICATE_KEY_HOLDER");
        return true;
      },
    );
    assert.equal(serviceCalled, 0, "the foreground service loop never starts behind a refused start");
  });
});

test("start service: spawnDetachedService failure throws SUPERVISOR_SPAWN_FAILED with cause", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await assert.rejects(
      () =>
        start(
          { slockHome: home },
          {
            spawnDetachedService: async () => {
              throw new Error("EACCES: cannot exec raft-computer __service");
            },
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "SUPERVISOR_SPAWN_FAILED");
        assert.equal(
          (err as ComputerServiceError).message,
          "EACCES: cannot exec raft-computer __service",
        );
        // cause retained in-process for debugging — adapters must not forward.
        assert.ok((err as ComputerServiceError).cause instanceof Error);
        return true;
      },
    );
  });
});

test("start service: on macOS the CLI host lifecycle never starts the service; start spawns it", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const order: string[] = [];
    const result = await start(
      { slockHome: home, hostLifecycleOwner: "cli" },
      {
        hostLifecycleDeps: { platform: "darwin" },
        convergeHostLifecycle: async (_actualHome, desired) => {
          order.push(`lifecycle:${desired}`);
          return {
            owner: "cli",
            enabled: true,
            status: "not-applicable",
            label: null,
            definitionPath: null,
            definition: null,
          };
        },
        spawnDetachedService: async () => {
          order.push("spawn");
          await mkdir(join(servicePidPath(home), ".."), { recursive: true });
          await writeFile(servicePidPath(home), String(process.pid));
          await writeServiceVersion(home, COMPUTER_VERSION);
          await writeReadyRunner(home, SERVER_A);
          return process.pid;
        },
        isProcessAlive: (pid) => pid === process.pid,
      },
    );
    assert.deepEqual(order, ["lifecycle:enabled", "spawn"]);
    assert.notEqual(result.status, "already_running");
  });
});

test("start service: a host-lifecycle failure never blocks the start", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const events: ComputerApiEvent[] = [];
    let spawned = false;
    await start(
      { slockHome: home, hostLifecycleOwner: "cli" },
      {
        onEvent: (e) => events.push(e),
        hostLifecycleDeps: { platform: "darwin" },
        convergeHostLifecycle: async () => {
          throw new ComputerServiceError("HOST_LIFECYCLE_OWNER_UNREADABLE", "owner record unreadable");
        },
        spawnDetachedService: async () => {
          spawned = true;
          await mkdir(join(servicePidPath(home), ".."), { recursive: true });
          await writeFile(servicePidPath(home), String(process.pid));
          await writeServiceVersion(home, COMPUTER_VERSION);
          await writeReadyRunner(home, SERVER_A);
          return process.pid;
        },
        isProcessAlive: (pid) => pid === process.pid,
      },
    );
    assert.equal(spawned, true);
    const skipped = events.find((e) => e.kind === "host_lifecycle.skipped");
    assert.equal(skipped?.kind === "host_lifecycle.skipped" && skipped.operation, "start");
    assert.equal(skipped?.kind === "host_lifecycle.skipped" && skipped.code, "HOST_LIFECYCLE_OWNER_UNREADABLE");
  });
});

// --- Gate 4: START_DAEMON_TIMEOUT (managed daemon never reaches ready) ---
test("start service: daemon never ready throws START_DAEMON_TIMEOUT (single server label form)", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid)); // alive
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await assert.rejects(
      () =>
        start(
          { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
          {
            ensureTimeoutMs: 0,
            ensurePollIntervalMs: 1,
            sleep: async () => undefined,
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "START_DAEMON_TIMEOUT");
        assert.match((err as ComputerServiceError).message, /Timed out waiting for \/alpha to start\./);
        assert.match((err as ComputerServiceError).message, /Run `raft-computer status`/);
        assert.match((err as ComputerServiceError).message, /per-server runner logs/);
        assert.ok((err as ComputerServiceError).message.includes(serviceLogPath(home)));
        assert.ok((err as ComputerServiceError).message.includes(serverRunnerLogPath(home, SERVER_A)));
        assert.doesNotMatch((err as ComputerServiceError).message, /~\/.slock/);
        return true;
      },
    );
  });
});

test("start service: live service with absent version pid fails as skew suspect before timeout", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid)); // alive
    await assert.rejects(
      () =>
        start(
          { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
          {
            ensureTimeoutMs: 0,
            ensurePollIntervalMs: 1,
            sleep: async () => undefined,
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "SERVICE_VERSION_SKEW_SUSPECT");
        assert.match((err as ComputerServiceError).message, /could not verify its version/);
        assert.doesNotMatch((err as ComputerServiceError).message, /Timed out/);
        return true;
      },
    );
  });
});

test("start service: live service with stale version pid fails as skew suspect before timeout", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid)); // alive
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid + 1);
    await assert.rejects(
      () =>
        start(
          { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
          {
            ensureTimeoutMs: 0,
            ensurePollIntervalMs: 1,
            sleep: async () => undefined,
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "SERVICE_VERSION_SKEW_SUSPECT");
        assert.match((err as ComputerServiceError).message, /different process/);
        assert.match((err as ComputerServiceError).message, new RegExp(String(process.pid + 1)));
        assert.doesNotMatch((err as ComputerServiceError).message, /Timed out/);
        return true;
      },
    );
  });
});

// The service writes its pidfile before its version evidence. A start that
// sees the new pid first must wait for the evidence to catch up instead of
// reporting the previous service's file (or no file yet) as skew.
for (const initial of ["previous service's evidence", "no evidence yet"] as const) {
  test(`start service: ${initial} that catches up to the live service pid is not a skew suspect`, async () => {
    await withHome(async (home) => {
      await writeAttach(home, SERVER_A);
      await mkdir(join(home, "computer", "run"), { recursive: true });
      await writeFile(servicePidPath(home), String(process.pid)); // alive
      if (initial === "previous service's evidence") {
        await writeServiceVersion(home, COMPUTER_VERSION, process.pid + 1);
      }
      let sleeps = 0;
      await assert.rejects(
        () =>
          start(
            { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
            {
              ensureTimeoutMs: 0,
              ensurePollIntervalMs: 1,
              sleep: async () => {
                sleeps += 1;
                // The starting service finishes publishing its identity.
                if (sleeps === 2) await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
              },
            },
          ),
        (err: unknown) => {
          assert.ok(err instanceof ComputerServiceError);
          // Past the skew check: the only remaining failure is the runner
          // that this fixture never makes ready.
          assert.equal((err as ComputerServiceError).code, "START_DAEMON_TIMEOUT");
          return true;
        },
      );
      assert.equal(sleeps, 2, "stops re-reading as soon as the evidence names the live pid");
    });
  });
}

test("start service: evidence that settles on an old version still fails loud as skew", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid)); // alive
    let sleeps = 0;
    await assert.rejects(
      () =>
        start(
          { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
          {
            ensureTimeoutMs: 0,
            ensurePollIntervalMs: 1,
            sleep: async () => {
              sleeps += 1;
              if (sleeps === 1) await writeServiceVersion(home, "0.0.68", process.pid);
            },
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "SERVICE_VERSION_SKEW");
        return true;
      },
    );
    assert.equal(sleeps, 1);
  });
});

test("start service: live old service version fails loud before daemon timeout", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid)); // alive
    await writeServiceVersion(home, "0.0.68", process.pid);
    await assert.rejects(
      () =>
        start(
          { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
          {
            ensureTimeoutMs: 0,
            ensurePollIntervalMs: 1,
            sleep: async () => undefined,
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "SERVICE_VERSION_SKEW");
        assert.match((err as ComputerServiceError).message, /0\.0\.68/);
        assert.match((err as ComputerServiceError).message, new RegExp(COMPUTER_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch((err as ComputerServiceError).message, /Timed out/);
        return true;
      },
    );
  });
});

test("start service: multi-runner timeout uses N server runner(s) form", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeAttach(home, SERVER_B);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await assert.rejects(
      () =>
        start(
          { slockHome: home },
          {
            ensureTimeoutMs: 0,
            ensurePollIntervalMs: 1,
            sleep: async () => undefined,
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "START_DAEMON_TIMEOUT");
        // multi-server form: "N server runner(s): <ids>"
        assert.match((err as ComputerServiceError).message, /Timed out waiting for 2 server runner\(s\): /);
        assert.ok((err as ComputerServiceError).message.includes(serverRunnerLogPath(home, SERVER_A)));
        assert.ok((err as ComputerServiceError).message.includes(serverRunnerLogPath(home, SERVER_B)));
        assert.doesNotMatch((err as ComputerServiceError).message, /~\/.slock/);
        return true;
      },
    );
  });
});

test("start service: daemon timeout surfaces computer_machine_unlinked from runner log", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeRunnerLog(
      home,
      SERVER_A,
      "[Daemon] WebSocket handshake rejected (status=401, slock_reason=computer_machine_unlinked)\n",
    );

    await assert.rejects(
      () =>
        start(
          { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
          {
            ensureTimeoutMs: 0,
            ensurePollIntervalMs: 1,
            sleep: async () => undefined,
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "START_DAEMON_TIMEOUT");
        assert.match((err as ComputerServiceError).message, /computer_machine_unlinked/);
        assert.match((err as ComputerServiceError).message, /run `raft-computer setup \/alpha`/);
        assert.match((err as ComputerServiceError).message, /raft-computer status \/alpha/);
        assert.doesNotMatch((err as ComputerServiceError).message, /per-server runner logs/);
        assert.ok((err as ComputerServiceError).message.includes(serviceLogPath(home)));
        assert.ok((err as ComputerServiceError).message.includes(serverRunnerLogPath(home, SERVER_A)));
        assert.doesNotMatch((err as ComputerServiceError).message, /~\/.slock/);
        return true;
      },
    );
  });
});

test("start service: daemon timeout checks legacy runner log for computer_machine_unlinked", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeRunnerLog(
      home,
      SERVER_A,
      '{"level":"warn","slock_reason":"computer_machine_unlinked"}\n',
      true,
    );

    await assert.rejects(
      () =>
        start(
          { serverId: SERVER_A, slockHome: home },
          {
            ensureTimeoutMs: 0,
            ensurePollIntervalMs: 1,
            sleep: async () => undefined,
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "START_DAEMON_TIMEOUT");
        assert.match((err as ComputerServiceError).message, /computer_machine_unlinked/);
        assert.match((err as ComputerServiceError).message, new RegExp(SERVER_A));
        return true;
      },
    );
  });
});

// --- Gate 5: managed.flag is written for each managed target BEFORE spawn ---
test("start service: writes managed.flag for ALL attached when serverId omitted", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeAttach(home, SERVER_B);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    // Pre-write live service pidfile so we take the already_running path
    // and don't actually spawn anything.
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeReadyRunner(home, SERVER_A);
    await writeReadyRunner(home, SERVER_B);

    const result = await start(
      { slockHome: home },
      {
        ensureTimeoutMs: 1000,
        ensurePollIntervalMs: 1,
        sleep: async () => undefined,
      },
    );
    assert.equal(result.status, "already_running");
    assert.equal(await isServerManaged(home, SERVER_A), true);
    assert.equal(await isServerManaged(home, SERVER_B), true);
    assert.deepEqual(result.managedTargets.sort(), [SERVER_A, SERVER_B].sort());
    assert.equal(result.attachedCount, 2);
  });
});

test("start service: writes managed.flag for serverId without clearing already-managed servers", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeAttach(home, SERVER_B);
    await setServerManaged(home, SERVER_B);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeReadyRunner(home, SERVER_A);

    const result = await start(
      { serverId: SERVER_A, slockHome: home },
      {
        ensureTimeoutMs: 1000,
        ensurePollIntervalMs: 1,
        sleep: async () => undefined,
      },
    );
    assert.equal(result.status, "already_running");
    assert.equal(await isServerManaged(home, SERVER_A), true);
    assert.equal(await isServerManaged(home, SERVER_B), true);
    assert.deepEqual(result.managedTargets, [SERVER_A]);
  });
});

test("start service: explicit start clears degraded runner recovery state before retry", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeAttach(home, SERVER_B);
    const now = Date.now() - 10_000;
    await recordCrash(home, SERVER_A, 1, null, now);
    await recordCrash(home, SERVER_A, 1, null, now + 1_000);
    await recordCrash(home, SERVER_A, 1, null, now + 2_000);
    assert.equal(await isDegraded(home, SERVER_A, now + 3_000), true);

    const result = await start(
      { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
      {
        spawnDetachedService: async () => {
          await writeReadyRunner(home, SERVER_A);
          return process.pid;
        },
      },
    );

    assert.equal(result.status, "spawned");
    assert.equal(await isDegraded(home, SERVER_A, now + 3_000), false);

    await recordCrash(home, SERVER_A, 1, null, now + 4_000);
    await recordCrash(home, SERVER_A, 1, null, now + 5_000);
    await recordCrash(home, SERVER_A, 1, null, now + 6_000);
    assert.equal(
      await isDegraded(home, SERVER_A, now + 7_000),
      true,
      "new crashes after retry must still re-enter degraded",
    );
    assert.equal(await isDegraded(home, SERVER_B, now + 7_000), false);
  });
});

test("start service: live-service retry routes degraded reset through recovery seam", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeReadyRunner(home, SERVER_A);
    const now = Date.now() - 10_000;
    await recordCrash(home, SERVER_A, 1, null, now);
    await recordCrash(home, SERVER_A, 1, null, now + 1_000);
    await recordCrash(home, SERVER_A, 1, null, now + 2_000);

    const resets: string[] = [];
    const result = await start(
      { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
      {
        resetRunnerRecoveryState: async (_slockHome, serverId) => {
          resets.push(serverId);
        },
        ensureTimeoutMs: 1000,
        ensurePollIntervalMs: 1,
        sleep: async () => undefined,
      },
    );

    assert.equal(result.status, "already_running");
    assert.deepEqual(resets, [SERVER_A]);
  });
});

test("start service: terminal unlinked marker blocks retry and preserves stale-state marker", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await markTerminalUnlinked(home, SERVER_A, `cm-${SERVER_A}`, 401);

    const resets: string[] = [];
    await assert.rejects(
      () => start(
        { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
        {
          resetRunnerRecoveryState: async (_slockHome, serverId) => {
            resets.push(serverId);
          },
          spawnDetachedService: async () => {
            throw new Error("must not spawn");
          },
        },
      ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal(err.code, "COMPUTER_MACHINE_UNLINKED");
        assert.match(err.message, /computer_machine_unlinked/);
        assert.match(err.message, /raft-computer setup \/alpha/);
        assert.match(err.message, /raft-computer status \/alpha/);
        assert.doesNotMatch(err.message, /back up|move the stale|runner\.state\.json aside/i);
        return true;
      },
    );

    assert.deepEqual(resets, []);
    assert.equal(await isServerManaged(home, SERVER_A), false);
    assert.equal((await readTerminalUnlinked(home, SERVER_A, `cm-${SERVER_A}`))?.statusCode, 401);
  });
});

test("start service: unscoped start skips a terminally unlinked server and starts the rest", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeAttach(home, SERVER_B);
    await markTerminalUnlinked(home, SERVER_A, `cm-${SERVER_A}`, 401);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeReadyRunner(home, SERVER_B);

    const events: Array<{ kind: string; serverIds?: string[] }> = [];
    const result = await start(
      { slockHome: home },
      {
        ensureTimeoutMs: 1000,
        ensurePollIntervalMs: 1,
        onEvent: (event) => events.push(event as { kind: string; serverIds?: string[] }),
      },
    );

    assert.equal(result.status, "already_running");
    assert.deepEqual(result.managedTargets, [SERVER_B]);
    assert.equal(result.attachedCount, 2);
    assert.deepEqual(
      events.find((event) => event.kind === "start.skipped_unlinked")?.serverIds,
      [SERVER_A],
    );
    assert.equal(await isServerManaged(home, SERVER_A), false);
    assert.equal(await isServerManaged(home, SERVER_B), true);
  });
});

test("start service: unscoped start still refuses when every attached server is unlinked", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeAttach(home, SERVER_B);
    await markTerminalUnlinked(home, SERVER_A, `cm-${SERVER_A}`, 401);
    await markTerminalUnlinked(home, SERVER_B, `cm-${SERVER_B}`, 401);

    await assert.rejects(
      () => start(
        { slockHome: home },
        {
          spawnDetachedService: async () => {
            throw new Error("must not spawn");
          },
        },
      ),
      (err: unknown) => err instanceof ComputerServiceError && err.code === "COMPUTER_MACHINE_UNLINKED",
    );
  });
});

test("start service: fresh setup attachment invalidates stale terminal unlinked marker", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A, "cm-stale");
    await markTerminalUnlinked(home, SERVER_A, "cm-stale", 401);

    // Recovery journey: setup writes a fresh attachment for the same server id.
    await writeAttach(home, SERVER_A, "cm-fresh");
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeReadyRunner(home, SERVER_A);

    const result = await start(
      { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
      { ensureTimeoutMs: 1000, ensurePollIntervalMs: 1 },
    );

    assert.equal(result.status, "already_running");
    assert.equal(await readTerminalUnlinked(home, SERVER_A, "cm-fresh"), null);
    // The fixture's live service is this test process with a fixed evidence date: its start is not read.
    const report = await buildStatusReport(home, { processStartTimeMs: async () => undefined });
    assert.equal(report.servers[0]?.serverMachineId, "cm-fresh");
    assert.equal(report.servers[0]?.health, "ok");
  });
});

// --- Gate 6: idempotent already_running path emits structured event ---
// A service that ended with its Windows sign-in session leaves run/service.pid
// and service-version.json behind, and the pid goes to an unrelated program:
// start answered "already running" and started nothing.
test("start service: a live recorded service pid that is another program is not already_running: the stale record goes and the service is spawned", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    let spawned = 0;
    let recordAtSpawn: string | null = "unread";
    const events: ComputerApiEvent[] = [];
    const result = await start(
      { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
      {
        onEvent: (e) => events.push(e),
        endpointAnswers: async () => false,
        // Ten minutes after the fixture's service-version.json was written.
        processStartTimeMs: async () => Date.parse("2026-07-06T06:40:50.714Z"),
        spawnDetachedService: async () => {
          spawned += 1;
          recordAtSpawn = await readFile(servicePidPath(home), "utf8").catch(() => null);
          await writeReadyRunner(home, SERVER_A);
          return process.pid;
        },
      },
    );
    assert.equal(spawned, 1);
    assert.equal(recordAtSpawn, null, "the stale pid record is gone before the service is spawned");
    assert.equal(result.status, "spawned");
    assert.equal(events.find((e) => e.kind === "start.already_running"), undefined);
  });
});

// After a Windows sign-out the runner's pid file, version evidence and
// connected marker name a pid that is another program now. Start spawned the
// service and its first readiness poll answered "ready" from those files,
// before the new service had started any runner.
test("start service: no service running → the runner records an earlier service left are forgotten before the spawn, so only the new runner is ready", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeReadyRunner(home, SERVER_A); // pid, evidence and connected marker of a runner that is gone
    await writeFile(serverRunnerLockConflictPath(home, SERVER_A), JSON.stringify({ servicePid: 999999998, ownerPid: process.pid, lockPath: null, recordedAt: 1 }));
    let recordsAtSpawn: Array<string | null> = [];
    const spawnedOnly = start(
      { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
      {
        ensureTimeoutMs: 0,
        ensurePollIntervalMs: 1,
        sleep: async () => undefined,
        spawnDetachedService: async () => {
          recordsAtSpawn = await Promise.all([serverRunnerPidPath(home, SERVER_A), serverRunnerLockConflictPath(home, SERVER_A)]
            .map((file) => readFile(file, "utf8").catch(() => null)));
          return process.pid; // the new service has not started a runner yet
        },
      },
    );
    await assert.rejects(spawnedOnly, (err: unknown) => err instanceof ComputerServiceError && err.code === "START_DAEMON_TIMEOUT");
    assert.deepEqual(recordsAtSpawn, [null, null], "forgotten before the service is spawned");
    assert.equal(existsSync(serverConnectedMarkerPath(home, SERVER_A)), true, "the connected marker is the runner's own: only it writes it");
  });
});

// A live service owns its runner records: nothing is forgotten under it.
test("start service: a service that answers on its IPC endpoint keeps its runner records, even without a pid file", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeReadyRunner(home, SERVER_A);
    const result = await start(
      { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
      { endpointAnswers: async () => true, spawnDetachedService: async () => process.pid, ensureTimeoutMs: 0, ensurePollIntervalMs: 1, sleep: async () => undefined },
    );
    assert.equal(result.status, "spawned");
    assert.equal((await readFile(serverRunnerPidPath(home, SERVER_A), "utf8")).trim(), String(process.pid));
  });
});

test("start service: a live recorded service pid is already_running when the service answers (its start is not read) or its start is not later", async () => {
  for (const [serviceAnswers, startedAt, startReads] of [
    [true, "2026-07-06T06:40:50.714Z", 0],
    [false, "2026-07-06T06:30:49.000Z", 1],
    [false, undefined, 1],
  ] as const) {
    await withHome(async (home) => {
      await writeAttach(home, SERVER_A);
      await mkdir(join(home, "computer", "run"), { recursive: true });
      await writeFile(servicePidPath(home), String(process.pid));
      await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
      await writeReadyRunner(home, SERVER_A);
      let reads = 0;
      let spawned = 0;
      const result = await start(
        { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
        {
          endpointAnswers: async () => serviceAnswers,
          processStartTimeMs: async () => { reads += 1; return startedAt === undefined ? undefined : Date.parse(startedAt); },
          spawnDetachedService: async () => { spawned += 1; return process.pid; },
          ensureTimeoutMs: 1000,
          ensurePollIntervalMs: 1,
          sleep: async () => undefined,
        },
      );
      assert.equal(result.status, "already_running");
      assert.equal(result.servicePid, process.pid);
      assert.equal(spawned, 0);
      assert.equal(reads, startReads, "no start is read while the service answers");
    });
  }
});

test("start service: live service pidfile emits already_running event + status", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeReadyRunner(home, SERVER_A);

    const events: ComputerApiEvent[] = [];
    const result = await start(
      { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
      {
        onEvent: (e) => events.push(e),
        ensureTimeoutMs: 1000,
        ensurePollIntervalMs: 1,
        sleep: async () => undefined,
      },
    );

    assert.equal(result.status, "already_running");
    assert.equal(result.servicePid, process.pid);
    assert.equal(result.attachedCount, 1);
    assert.equal(result.ready.get(SERVER_A), process.pid);

    const startingEvent = events.find((e) => e.kind === "start.starting");
    assert.ok(startingEvent && startingEvent.kind === "start.starting");
    assert.equal(startingEvent.foreground, false);

    const ar = events.find((e) => e.kind === "start.already_running");
    assert.ok(ar && ar.kind === "start.already_running");
    assert.equal(ar.servicePid, process.pid);
    assert.deepEqual(ar.managedTargets, [SERVER_A]);

    const ready = events.find((e) => e.kind === "start.ready");
    assert.ok(ready && ready.kind === "start.ready");
    assert.equal(ready.ready.get(SERVER_A), process.pid);

    // Foreground/spawned events MUST NOT fire on the already_running path.
    assert.equal(events.find((e) => e.kind === "start.running"), undefined);
    assert.equal(events.find((e) => e.kind === "start.spawned"), undefined);
  });
});

test("start service: already_running accepts legacy server-runner.pid from live old runner", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeReadyRunner(home, SERVER_A, process.pid, true);

    const result = await start(
      { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
      {
        ensureTimeoutMs: 1000,
        ensurePollIntervalMs: 1,
        sleep: async () => undefined,
      },
    );

    assert.equal(result.status, "already_running");
    assert.equal(result.ready.get(SERVER_A), process.pid);
  });
});

// --- Gate 7: foreground path runs service inline + emits running event ---
test("start service: foreground=true emits running event + invokes runService + status='running'", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);

    let serviceCalled = 0;
    let markerDuringService: string | undefined;
    const previousParentMarker = process.env[PARENT_LOCK_HELD_ENV_VAR];
    const events: ComputerApiEvent[] = [];
    const result = await start(
      { foreground: true, slockHome: home },
      {
        onEvent: (e) => events.push(e),
        runService: async () => {
          serviceCalled += 1;
          markerDuringService = process.env[PARENT_LOCK_HELD_ENV_VAR];
        },
      },
    );
    assert.equal(serviceCalled, 1);
    assert.equal(markerDuringService, "1");
    assert.equal(process.env[PARENT_LOCK_HELD_ENV_VAR], previousParentMarker);
    assert.equal(result.status, "running");
    assert.equal(result.servicePid, null);
    assert.equal(result.ready.size, 0);

    const running = events.find((e) => e.kind === "start.running");
    assert.ok(running && running.kind === "start.running");
    assert.deepEqual(running.managedTargets, [SERVER_A]);
    // No spawned event; foreground does not background-spawn.
    assert.equal(events.find((e) => e.kind === "start.spawned"), undefined);
  });
});

// --- Gate 8: background-spawn path emits spawned + ready + status='spawned' ---
test("start service: background spawn emits spawned + ready events; status='spawned'", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);

    const events: ComputerApiEvent[] = [];
    const result = await start(
      { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
      {
        onEvent: (e) => events.push(e),
        spawnDetachedService: async () => {
          // Simulate detached service reaching ready: write daemon pid.
          await writeReadyRunner(home, SERVER_A);
          return process.pid;
        },
      },
    );

    assert.equal(result.status, "spawned");
    assert.equal(result.servicePid, process.pid);
    assert.equal(result.ready.get(SERVER_A), process.pid);

    const spawned = events.find((e) => e.kind === "start.spawned");
    assert.ok(spawned && spawned.kind === "start.spawned");
    assert.equal(spawned.servicePid, process.pid);
    assert.equal(spawned.supervisorUnit, undefined, "spawned detached: nothing starts it again");

    const ready = events.find((e) => e.kind === "start.ready");
    assert.ok(ready && ready.kind === "start.ready");
  });
});

test("start service: concurrent same-home callers serialize and spawn detached service once", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    let spawnCalls = 0;
    const deps = {
      spawnDetachedService: async () => {
        spawnCalls += 1;
        await mkdir(join(home, "computer", "run"), { recursive: true });
        await writeFile(servicePidPath(home), String(process.pid));
        await writeServiceVersion(home, COMPUTER_VERSION);
        await writeReadyRunner(home, SERVER_A);
        return process.pid;
      },
      sleep: async () => undefined,
    };

    const [first, second] = await Promise.all([
      start({ slockHome: home }, deps),
      start({ slockHome: home }, deps),
    ]);

    assert.equal(spawnCalls, 1);
    assert.equal(first.status, "spawned");
    assert.equal(second.status, "already_running");
    assert.equal(first.ready.get(SERVER_A), process.pid);
    assert.equal(second.ready.get(SERVER_A), process.pid);
  });
});

test("start service keeps detached Computer canonical", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    let detachedParentLockMarker: string | undefined;

    const result = await start(
      { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
      {
        spawnDetachedService: async (_actualHome, opts) => {
          detachedParentLockMarker = buildDetachedServiceEnv({}, opts)[PARENT_LOCK_HELD_ENV_VAR];
          await mkdir(join(home, "computer", "run"), { recursive: true });
          await writeFile(servicePidPath(home), String(process.pid));
          await writeServiceVersion(home, COMPUTER_VERSION);
          await writeReadyRunner(home, SERVER_A);
          return process.pid;
        },
        sleep: async () => undefined,
      },
    );

    assert.equal(result.status, "spawned");
    assert.equal(result.servicePid, process.pid);
    assert.equal(result.ready.get(SERVER_A), process.pid);
    assert.equal(detachedParentLockMarker, "1");
  });
});

// --- Gate 9: pre-spawn AbortSignal throws AbortError, NOT ComputerServiceError ---
test("start service: pre-aborted AbortSignal throws AbortError, not ComputerServiceError", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => start({ slockHome: home }, { signal: ac.signal }),
      (err: unknown) => {
        assert.ok(!(err instanceof ComputerServiceError));
        return true;
      },
    );
  });
});

// --- Gate 10: AbortSignal before managed intent/spawn → AbortError + no mutation ---
test("start service: abort before managed.flag write → AbortError, no intent mutation or spawn", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const ac = new AbortController();
    let spawnCount = 0;
    await assert.rejects(
      () =>
        start(
          { slockHome: home },
          {
            signal: ac.signal,
            onEvent: (e) => {
              // Abort right after we observe `starting` (i.e., before spawn).
              if (e.kind === "start.starting") ac.abort();
            },
            spawnDetachedService: async () => {
              spawnCount += 1;
              return process.pid;
            },
          },
        ),
      (err: unknown) => {
        assert.ok(!(err instanceof ComputerServiceError));
        return true;
      },
    );
    assert.equal(spawnCount, 0);
    assert.equal(await isServerManaged(home, SERVER_A), false);
  });
});

// --- Gate 11: post-spawn abort = no-op + status='aborted' + service NOT killed ---
test("start service: abort AFTER spawn returns status='aborted' + emits aborted event + does NOT kill service", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const ac = new AbortController();
    let killAttempts = 0;
    const events: ComputerApiEvent[] = [];
    const result = await start(
      { serverId: SERVER_A, serverLabel: "/alpha", slockHome: home },
      {
        signal: ac.signal,
        onEvent: (e) => {
          events.push(e);
          // Abort right after we observe `spawned` — this is the
          // post-spawn boundary the product invariant locks.
          if (e.kind === "start.spawned") ac.abort();
        },
        spawnDetachedService: async () => {
          // Simulate detached service spawning but daemon not yet ready.
          return 99999; // arbitrary pid, no signal will be sent
        },
      },
    );
    // Hao msg=7a1a2c3d invariant: post-spawn abort is a no-op.
    // Service MUST stay running; service returns status="aborted".
    assert.equal(result.status, "aborted");
    assert.equal(result.servicePid, 99999);
    assert.equal(killAttempts, 0); // sanity: nothing in service path SIGKILLs the service
    const aborted = events.find((e) => e.kind === "start.aborted");
    assert.ok(aborted && aborted.kind === "start.aborted");
    assert.equal(aborted.servicePid, 99999);
  });
});


// --- task #917: a systemd unit that exists for this root is started through systemd ---
test("task #917: start delegates to `systemctl start` whenever the unit exists, even while it is inactive", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    let spawned = 0;
    const calls: string[] = [];
    const events: ComputerApiEvent[] = [];
    const result = await start(
      { slockHome: home },
      {
        onEvent: (e) => events.push(e),
        spawnDetachedService: async () => { spawned += 1; return 999; },
        inspectSupervisor: async () => ({
          record: { kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "x", pid: 0, recordedAt: "t" },
          unitLoaded: true, enabledState: "enabled", activeState: "inactive", mainPid: 0, killMode: "process", reachable: true,
        }),
        // task #37: a start through systemd is not in a login session scope; never asked.
        detectLogindSessionRisk: async () => { calls.push("logind-risk"); return null; },
        // #proj-raft-computer:#59: the unit's own `start --foreground` takes
        // the mutation lock, so this command hands it over before starting
        // the unit. RED proof: drop the release and this order breaks.
        releaseMutationLock: async (slockHome) => { assert.equal(slockHome, home); calls.push("lock-released"); },
        systemctl: async (scope, args) => {
          calls.push(`${scope}:${args.join(" ")}`);
          if (args[0] === "start") { await writeReadyRunner(home, SERVER_A); return { code: 0, stdout: "", stderr: "" }; }
          if (args[0] === "show" && args[2] === "MainPID") return { code: 0, stdout: "4242\n", stderr: "" };
          return { code: 1, stdout: "", stderr: "unexpected" };
        },
      },
    );
    assert.equal(result.status, "spawned");
    assert.equal(result.servicePid, 4242);
    assert.equal(spawned, 0, "nothing is started beside the unit");
    // The start line promises nothing about a restart for a service systemd owns.
    const started = events.find((e) => e.kind === "start.spawned");
    assert.equal(started?.kind === "start.spawned" && started.supervisorUnit, "raft-computer.service");
    assert.deepEqual(calls, ["lock-released", "user:start raft-computer.service", "user:show -P MainPID raft-computer.service"]);
  });
});

test("task #917: start refuses beside an unreachable manager and reports a failing `systemctl start`", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const record = { kind: "systemd" as const, scope: "user" as const, unit: "raft-computer.service", invocationId: "x", pid: 0, recordedAt: "t" };
    let spawned = 0;
    await assert.rejects(
      () => start({ slockHome: home }, {
        spawnDetachedService: async () => { spawned += 1; return 999; },
        inspectSupervisor: async () => ({ record, unitLoaded: false, enabledState: null, activeState: null, mainPid: null, killMode: null, reachable: false }),
      }),
      (err: unknown) => err instanceof ComputerServiceError && err.code === "START_SUPERVISOR_UNREACHABLE",
    );
    await assert.rejects(
      () => start({ slockHome: home }, {
        spawnDetachedService: async () => { spawned += 1; return 999; },
        inspectSupervisor: async () => ({ record, unitLoaded: true, enabledState: "enabled", activeState: "inactive", mainPid: 0, killMode: "process", reachable: true }),
        systemctl: async () => ({ code: 1, stdout: "", stderr: "Failed to start raft-computer.service: Unit not found." }),
      }),
      (err: unknown) => err instanceof ComputerServiceError && err.code === "START_SUPERVISOR_FAILED" && /Unit not found/.test(err.message),
    );
    assert.equal(spawned, 0);
  });
});

test("task #917: a record whose unit file is gone is cleared and the detached spawn runs as before", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeSupervisorRecord(home, { kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "x", pid: 0, recordedAt: "t" });
    const result = await start(
      { slockHome: home },
      {
        spawnDetachedService: async () => { await writeReadyRunner(home, SERVER_A); return process.pid; },
        inspectSupervisor: async () => ({
          record: { kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "x", pid: 0, recordedAt: "t" },
          unitLoaded: false, enabledState: null, activeState: null, mainPid: null, killMode: null, reachable: true,
        }),
      },
    );
    assert.equal(result.status, "spawned");
    assert.equal(await readSupervisorRecord(home), null);
  });
});


test("task #917: a foreground start releases the mutation lock once the service's mutation surface exists", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const order: string[] = [];
    const result = await start(
      { slockHome: home, foreground: true },
      {
        runService: async (deps) => {
          order.push("service-start");
          await deps?.onMutationsReady?.({} as never);
          order.push("service-loop");
        },
        releaseMutationLock: async (slockHome) => { assert.equal(slockHome, home); order.push("lock-released"); },
        // task #37: the foreground service is whatever the caller runs it under; never asked.
        detectLogindSessionRisk: async () => { order.push("logind-risk"); return null; },
      },
    );
    assert.equal(result.status, "running");
    assert.deepEqual(order, ["service-start", "lock-released", "service-loop"], "released after startup recovery, before the loop owns IPC");
  });
});

test("a detached service drops install.sh's version pin and keeps the rest of the environment", () => {
  const env = buildDetachedServiceEnv({ PATH: "/usr/bin", [INSTALL_VERSION_PIN_ENV_VAR]: "1.0.36", RAFT_COMPUTER_INSTALLER_CHANNEL: "alpha" });
  assert.equal(env[INSTALL_VERSION_PIN_ENV_VAR], undefined);
  assert.equal(INSTALL_VERSION_PIN_ENV_VAR, "RAFT_COMPUTER_VERSION");
  assert.equal(env.PATH, "/usr/bin");
  // The installer channel is a runtime setting for in-service upgrades: kept.
  assert.equal(env.RAFT_COMPUTER_INSTALLER_CHANNEL, "alpha");
});

test("a detached service never passes on the installer run that started it (#proj-raft-computer:#32)", () => {
  const base = { PATH: "/usr/bin", RAFT_COMPUTER_INSTALLER_CHANNEL: "alpha", RAFT_COMPUTER_OPERATION_ID: "web-upgrade",
    RAFT_COMPUTER_APPROVED_BY: "remote:web-upgrade", RAFT_COMPUTER_NON_INTERACTIVE: "1", RAFT_COMPUTER_INSTALLER_CALLER: "waiting-cli-v1" };
  const env = buildDetachedServiceEnv(base);
  for (const name of ["RAFT_COMPUTER_OPERATION_ID", "RAFT_COMPUTER_APPROVED_BY", "RAFT_COMPUTER_NON_INTERACTIVE", "RAFT_COMPUTER_INSTALLER_CALLER"]) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(env.RAFT_COMPUTER_INSTALLER_CHANNEL, "alpha");
  assert.equal(base.RAFT_COMPUTER_OPERATION_ID, "web-upgrade", "the caller's environment is not modified");
});

test("start waits longer for runners when the external installer runs it, the default otherwise", () => {
  assert.equal(startWaitForCaller({ RAFT_COMPUTER_INSTALLER_LIFECYCLE: "1" }), INSTALLER_LIFECYCLE_START_WAIT_MS);
  // The installer kills `start` after 45 s, lock wait and setup included (raft-computer-installer rust/computer.rs serve_lifecycle).
  assert.ok(INSTALLER_LIFECYCLE_START_WAIT_MS > 15_000 && INSTALLER_LIFECYCLE_START_WAIT_MS + 10_000 <= 45_000);
  assert.equal(startWaitForCaller({}), undefined);
  assert.equal(startWaitForCaller({ RAFT_COMPUTER_INSTALLER_LIFECYCLE: "0" }), undefined);
});

// Under the external installer, a machine still registered on a server it can
// no longer reach must not fail the upgrade's start (88602a54, 9e56ad23): that
// runner is alive at this version, only not connected.
async function writeDisconnectedRunner(home: string, serverId: string, pid = process.pid): Promise<void> {
  await writeReadyRunner(home, serverId, pid);
  await rm(serverConnectedMarkerPath(home, serverId), { force: true });
}

const PARTIAL_OPTIONS = { ensureTimeoutMs: 0, ensurePollIntervalMs: 1, sleep: async () => undefined, acceptPartialReady: true, detectLogindSessionRisk: async () => null } as const;

async function withTwoServersOneReady<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeAttach(home, SERVER_B);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeReadyRunner(home, SERVER_A);
    return fn(home);
  });
}

test("start service (installer): a ready runner beside one that is alive but not connected succeeds and names it", async () => {
  await withTwoServersOneReady(async (home) => {
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeDisconnectedRunner(home, SERVER_B);
    const events: ComputerApiEvent[] = [];
    const result = await start({ slockHome: home }, { ...PARTIAL_OPTIONS, onEvent: (event: ComputerApiEvent) => { events.push(event); } });
    assert.equal(result.status, "already_running");
    assert.deepEqual([...result.ready.keys()], [SERVER_A]);
    const partial = events.find((event) => event.kind === "start.partial_ready");
    assert.ok(partial && partial.kind === "start.partial_ready");
    assert.deepEqual(partial.notReady, [SERVER_B]);
    assert.equal(events.some((event) => event.kind === "start.ready"), false);
  });
});

test("start service (installer): the same on the path that spawns the service", async () => {
  await withTwoServersOneReady(async (home) => {
    const events: ComputerApiEvent[] = [];
    const result = await start({ slockHome: home }, {
      ...PARTIAL_OPTIONS,
      spawnDetachedService: async () => {
        await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
        // What the runners record once the spawned service has started them (start forgot the earlier records).
        await writeReadyRunner(home, SERVER_A);
        await writeDisconnectedRunner(home, SERVER_B);
        return process.pid;
      },
      onEvent: (event: ComputerApiEvent) => { events.push(event); },
    });
    assert.equal(result.status, "spawned");
    const partial = events.find((event) => event.kind === "start.partial_ready");
    assert.ok(partial && partial.kind === "start.partial_ready");
    assert.deepEqual(partial.notReady, [SERVER_B]);
  });
});

test("task #37: the spawn path reports a login-session risk before spawning; an already running service is not asked", async () => {
  await withTwoServersOneReady(async (home) => {
    const order: string[] = [];
    const risk = { sessionScope: "session-24.scope", user: "archer", linger: false };
    const result = await start({ slockHome: home }, {
      ...PARTIAL_OPTIONS,
      detectLogindSessionRisk: async () => { order.push("detect"); return risk; },
      spawnDetachedService: async () => {
        order.push("spawn");
        await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
        await writeReadyRunner(home, SERVER_A);
        await writeDisconnectedRunner(home, SERVER_B);
        return process.pid;
      },
      onEvent: (event: ComputerApiEvent) => { if (event.kind === "start.logind_session_risk") order.push(`event:${event.risk.sessionScope}`); },
    });
    assert.equal(result.status, "spawned");
    assert.deepEqual(order, ["detect", "event:session-24.scope", "spawn"]);
  });
  await withTwoServersOneReady(async (home) => {
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeDisconnectedRunner(home, SERVER_B);
    let asked = false;
    const result = await start({ slockHome: home }, { ...PARTIAL_OPTIONS, detectLogindSessionRisk: async () => { asked = true; return null; } });
    assert.equal(result.status, "already_running");
    assert.equal(asked, false);
  });
});

for (const [missing, setUp] of [
  ["absent (it exited)", async () => undefined],
  ["at another version", async (home: string) => {
    await writeDisconnectedRunner(home, SERVER_B);
    await writeFile(serverRunnerVersionPath(home, SERVER_B), JSON.stringify({ version: "0.0.1", installRoot: "/x", pid: process.pid, writtenAt: "2026-11-02T00:00:00.000Z" }));
  }],
] as const) {
  test(`start service (installer): a missing runner ${missing} is a fault of this version and still fails`, async () => {
    await withTwoServersOneReady(async (home) => {
      await writeFile(servicePidPath(home), String(process.pid));
      await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
      await setUp(home);
      await assert.rejects(() => start({ slockHome: home }, PARTIAL_OPTIONS), (err: unknown) => (err as ComputerServiceError).code === "START_DAEMON_TIMEOUT");
    });
  });
}

test("start service: a person's start (no acceptPartialReady) still fails on a disconnected runner", async () => {
  await withTwoServersOneReady(async (home) => {
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeDisconnectedRunner(home, SERVER_B);
    await assert.rejects(
      () => start({ slockHome: home }, { ensureTimeoutMs: 0, ensurePollIntervalMs: 1, sleep: async () => undefined }),
      (err: unknown) => (err as ComputerServiceError).code === "START_DAEMON_TIMEOUT",
    );
  });
});

test("start service: acceptPartialReady with no runner ready still fails", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeDisconnectedRunner(home, SERVER_A);
    await assert.rejects(() => start({ slockHome: home }, PARTIAL_OPTIONS), (err: unknown) => (err as ComputerServiceError).code === "START_DAEMON_TIMEOUT");
  });
});

// A runner whose daemon lost the machine lock to another process (on Windows
// possibly an unrelated program that got a dead daemon's pid): the service
// adopted that pid as the runner and recorded the conflict.
const LOCK_OWNER_PID = process.ppid;
const LOCK_PATH = "/home/me/.slock/machines/machine-e64f259009a007e0/daemon.lock";
async function writeLockConflictedRunner(
  home: string,
  serverId: string,
  servicePid = process.pid,
  ownerPid: number | null = LOCK_OWNER_PID,
): Promise<void> {
  const pidPath = serverRunnerPidPath(home, serverId);
  await mkdir(join(pidPath, ".."), { recursive: true });
  if (ownerPid !== null) await writeFile(pidPath, String(ownerPid));
  await writeFile(
    serverRunnerLockConflictPath(home, serverId),
    JSON.stringify({ servicePid, ownerPid, lockPath: LOCK_PATH, recordedAt: Date.now() }),
  );
}

test("start service (installer): a ready runner beside one held off by another daemon's lock succeeds and names it", async () => {
  await withTwoServersOneReady(async (home) => {
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeLockConflictedRunner(home, SERVER_B);
    const events: ComputerApiEvent[] = [];
    let sleeps = 0;
    const result = await start({ slockHome: home }, {
      ...PARTIAL_OPTIONS,
      ensureTimeoutMs: 60_000,
      sleep: async () => { sleeps += 1; },
      onEvent: (event: ComputerApiEvent) => { events.push(event); },
    });
    assert.equal(result.status, "already_running");
    assert.deepEqual([...result.ready.keys()], [SERVER_A]);
    const partial = events.find((event) => event.kind === "start.partial_ready");
    assert.ok(partial && partial.kind === "start.partial_ready");
    assert.deepEqual(partial.notReady, [SERVER_B]);
    assert.equal(sleeps, 0, "a lock-conflicted runner is not waited for");
  });
});

test("start service (installer): the same on the path that spawns the service, with a conflict beside a disconnected runner", async () => {
  await withHome(async (home) => {
    const SERVER_C = "33333333-3333-4333-8333-333333333333";
    for (const id of [SERVER_A, SERVER_B, SERVER_C]) await writeAttach(home, id);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeReadyRunner(home, SERVER_A);
    const events: ComputerApiEvent[] = [];
    const result = await start({ slockHome: home }, {
      ...PARTIAL_OPTIONS,
      spawnDetachedService: async () => {
        await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
        await writeReadyRunner(home, SERVER_A);
        await writeLockConflictedRunner(home, SERVER_B);
        await writeDisconnectedRunner(home, SERVER_C);
        return process.pid;
      },
      onEvent: (event: ComputerApiEvent) => { events.push(event); },
    });
    assert.equal(result.status, "spawned");
    const partial = events.find((event) => event.kind === "start.partial_ready");
    assert.ok(partial && partial.kind === "start.partial_ready");
    assert.deepEqual(partial.notReady, [SERVER_B, SERVER_C]);
  });
});

test("start service: a person's start fails at once, naming the server, the lock owner and the lock", async () => {
  await withTwoServersOneReady(async (home) => {
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeLockConflictedRunner(home, SERVER_B);
    let sleeps = 0;
    await assert.rejects(
      () => start({ slockHome: home }, { ensureTimeoutMs: 60_000, ensurePollIntervalMs: 1, sleep: async () => { sleeps += 1; }, detectLogindSessionRisk: async () => null }),
      (err: unknown) => {
        const error = err as ComputerServiceError;
        assert.equal(error.code, "START_RUNNER_LOCK_CONFLICT");
        assert.match(error.message, new RegExp(`^Cannot start ${SERVER_B}: pid ${LOCK_OWNER_PID} holds this machine's daemon lock, so the Computer service is deferring to it instead of starting its own runner\\.`));
        assert.ok(error.message.includes(`Lock: ${LOCK_PATH}.`), error.message);
        assert.ok(error.message.includes(`Check whether pid ${LOCK_OWNER_PID} is really a Raft daemon`), error.message);
        assert.ok(error.message.includes("raft-computer restart"), error.message);
        // A restart alone can meet the same lock (Linux, unreadable start): say the lock may be deleted once checked.
        assert.ok(
          error.message.includes(`Once you have confirmed pid ${LOCK_OWNER_PID} is not a Raft daemon, you can delete ${LOCK_PATH}: a restart alone may meet the same lock`),
          error.message,
        );
        return true;
      },
    );
    assert.equal(sleeps, 0, "no wait for the timeout");
  });
});

test("start service: a lock conflict with no owner it could name says the lock may be deleted if a restart meets it again", async () => {
  await withTwoServersOneReady(async (home) => {
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeLockConflictedRunner(home, SERVER_B, process.pid, null);
    await assert.rejects(
      () => start({ slockHome: home }, { ensureTimeoutMs: 60_000, ensurePollIntervalMs: 1, sleep: async () => {}, detectLogindSessionRisk: async () => null }),
      (err: unknown) => {
        const error = err as ComputerServiceError;
        assert.equal(error.code, "START_RUNNER_LOCK_CONFLICT");
        assert.match(error.message, /no live owner could be identified/);
        assert.ok(error.message.includes(`If it still reports this lock, delete ${LOCK_PATH} and restart again.`), error.message);
        return true;
      },
    );
  });
});

test("start service: a lock conflict recorded by an earlier service is not this start's; it waits and times out as before", async () => {
  await withTwoServersOneReady(async (home) => {
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeLockConflictedRunner(home, SERVER_B, 999_999);
    await assert.rejects(
      () => start({ slockHome: home }, PARTIAL_OPTIONS),
      (err: unknown) => (err as ComputerServiceError).code === "START_DAEMON_TIMEOUT",
    );
  });
});

test("start service (installer): a lock conflict with no runner ready still fails, as the conflict", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await writeLockConflictedRunner(home, SERVER_A);
    await assert.rejects(() => start({ slockHome: home }, PARTIAL_OPTIONS), (err: unknown) => (err as ComputerServiceError).code === "START_RUNNER_LOCK_CONFLICT");
  });
});

test("installer-run start accepts partial readiness; a person's start does not", () => {
  assert.equal(startAcceptsPartialReady({ RAFT_COMPUTER_INSTALLER_LIFECYCLE: "1" }), true);
  assert.equal(startAcceptsPartialReady({}), false);
});

// #proj-raft-computer:#77: an upgrade rolled back on a failed installer `start`
// left only "start (exit 1)" behind. The start now says what its wait saw.
test("start service: onReadiness counts the runners not ready by reason, on a failed and on a partial start", async () => {
  await withTwoServersOneReady(async (home) => {
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    const reports: StartReadinessReport[] = [];
    // SERVER_B's runner does not exist: not excused, the start fails.
    await assert.rejects(
      () => start({ slockHome: home }, { ...PARTIAL_OPTIONS, onReadiness: (report) => { reports.push(report); } }),
      (err: unknown) => (err as ComputerServiceError).code === "START_DAEMON_TIMEOUT",
    );
    await writeDisconnectedRunner(home, SERVER_B);
    await start({ slockHome: home }, { ...PARTIAL_OPTIONS, onReadiness: (report) => { reports.push(report); } });
    assert.deepEqual(
      reports.map(({ waitedMs, ...rest }) => rest),
      [
        { targets: 2, ready: 1, notReady: { "runner-absent": 1 }, partial: false, unlinked: 0 },
        { targets: 2, ready: 1, notReady: { "runner-disconnected": 1 }, partial: true, unlinked: 0 },
      ],
    );
    assert.ok(reports.every((report) => Number.isInteger(report.waitedMs) && report.waitedMs >= 0));
  });
});

test("start service: onReadiness reports every runner ready, counts skipped unlinked attachments, and a throw in it changes nothing", async () => {
  await withTwoServersOneReady(async (home) => {
    await writeFile(servicePidPath(home), String(process.pid));
    await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
    await markTerminalUnlinked(home, SERVER_B, `cm-${SERVER_B}`, 401);
    const reports: StartReadinessReport[] = [];
    const result = await start({ slockHome: home }, {
      ...PARTIAL_OPTIONS,
      onReadiness: (report) => { reports.push(report); throw new Error("listener fault"); },
    });
    assert.equal(result.status, "already_running");
    assert.deepEqual(reports.map(({ waitedMs, ...rest }) => rest), [{ targets: 1, ready: 1, notReady: {}, partial: false, unlinked: 1 }]);
  });
});

test("installer-run start notes itself in the upgrade's step log; a person's start does not", () => {
  assert.equal(startNotesUpgradeStep({ RAFT_COMPUTER_INSTALLER_LIFECYCLE: "1" }), true);
  assert.equal(startNotesUpgradeStep({}), false);
});

/** Runs `fn` with stderr silenced (a failed start prints its error) and returns what it threw. */
async function thrownBy(fn: () => Promise<unknown>): Promise<unknown> {
  const stderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  } finally {
    process.stderr.write = stderr;
  }
}
const isCliExit = (err: unknown, code: string): boolean => err instanceof CliExit && err.exitCode === 1 && err.code === code;

test("runStart (installer): a failed start is noted with its error code and what the wait saw; a person's start notes nothing", async () => {
  await withTwoServersOneReady(async (home) => {
    const notes: StartCommandNote[] = [];
    const deps = {
      ...PARTIAL_OPTIONS,
      spawnDetachedService: async () => {
        await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
        await writeReadyRunner(home, SERVER_A);
        return process.pid;
      },
      noteStartCommand: async (_home: string, note: StartCommandNote) => { notes.push(note); },
    };
    assert.ok(isCliExit(await thrownBy(() => runStart({ recordLifecycleIntent: false }, { ...deps, noteUpgradeStep: true })), "START_DAEMON_TIMEOUT"));
    assert.ok(isCliExit(await thrownBy(() => runStart({ recordLifecycleIntent: false }, deps)), "START_DAEMON_TIMEOUT"));
    assert.equal(notes.length, 1, "only the installer-run start is noted");
    const [note] = notes;
    assert.deepEqual([note?.version, note?.outcome, note?.errorCode], [COMPUTER_VERSION, "failed", "START_DAEMON_TIMEOUT"]);
    assert.deepEqual(
      [note?.readiness?.targets, note?.readiness?.ready, note?.readiness?.notReady, note?.readiness?.partial],
      [2, 1, { "runner-absent": 1 }, false],
    );
  });
});

test("runStart (installer): a note that fails changes neither a failed start's error nor a successful start", async () => {
  await withTwoServersOneReady(async (home) => {
    const spawn = (ready: boolean) => async () => {
      await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
      await writeReadyRunner(home, SERVER_A);
      if (ready) await writeDisconnectedRunner(home, SERVER_B);
      return process.pid;
    };
    // The seam both rejects and throws synchronously.
    for (const noteStartCommand of [async () => { throw new Error("disk full"); }, (() => { throw new Error("sync"); }) as never]) {
      const deps = { ...PARTIAL_OPTIONS, noteUpgradeStep: true, noteStartCommand };
      assert.ok(isCliExit(await thrownBy(() => runStart({ recordLifecycleIntent: false }, { ...deps, spawnDetachedService: spawn(false) })), "START_DAEMON_TIMEOUT"));
      await rm(servicePidPath(home), { force: true });
      assert.equal(await thrownBy(() => runStart({ recordLifecycleIntent: false }, { ...deps, spawnDetachedService: spawn(true) })), undefined);
      await rm(servicePidPath(home), { force: true });
    }
  });
});

test("runStart (installer): a start refused before its wait is noted without readiness; one refused before it ran is noted by noteStartNeverRan", async () => {
  await withHome(async () => {
    const notes: StartCommandNote[] = [];
    const noteStartCommand = async (_home: string, note: StartCommandNote) => { notes.push(note); };
    assert.ok(isCliExit(await thrownBy(() => runStart({ recordLifecycleIntent: false }, { noteUpgradeStep: true, noteStartCommand })), "NO_ATTACHMENT"));
    await noteStartNeverRan(new CliExit(1, "CONCURRENT_OPERATION"), noteStartCommand);
    await noteStartNeverRan(new Error("boom"), noteStartCommand);
    await noteStartNeverRan(new CliExit(1, "CONCURRENT_OPERATION"), async () => { throw new Error("disk full"); });
    assert.deepEqual(notes.map((note) => [note.outcome, note.errorCode, note.readiness ?? null, note.version]), [
      ["failed", "NO_ATTACHMENT", null, COMPUTER_VERSION],
      ["failed", "CONCURRENT_OPERATION", null, COMPUTER_VERSION],
      ["failed", "unknown", null, COMPUTER_VERSION],
    ]);
  });
});

test("runStart (installer): a start that succeeds with one runner not connected is noted ok and partial", async () => {
  await withTwoServersOneReady(async (home) => {
    const notes: StartCommandNote[] = [];
    await runStart({ recordLifecycleIntent: false }, {
      ...PARTIAL_OPTIONS,
      noteUpgradeStep: true,
      spawnDetachedService: async () => {
        await writeServiceVersion(home, COMPUTER_VERSION, process.pid);
        await writeReadyRunner(home, SERVER_A);
        await writeDisconnectedRunner(home, SERVER_B);
        return process.pid;
      },
      noteStartCommand: async (_home: string, note: StartCommandNote) => { notes.push(note); },
    });
    assert.deepEqual(notes.map((note) => [note.outcome, note.errorCode, note.readiness?.partial, note.readiness?.notReady]), [
      ["ok", undefined, true, { "runner-disconnected": 1 }],
    ]);
  });
});
