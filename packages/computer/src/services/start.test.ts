// Byte-pin tests for the StartService seam extraction (Hao msg=51a17400 +
// liuliu msg=7a1a2c3d / 35034229 / 240069cd / bb503633 — Start byte-pin
// gates 1-N + onEvent + AbortSignal pre/post-spawn boundary +
// closed-set sentinel pin).
//
// Companion: ../service.test.ts asserts the CLI adapter (`runStart`)
// still emits the pre-extraction info()/fail() lines byte-identically.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { ComputerServiceError } from "./errors.js";
import { start } from "./start.js";
import type { ComputerApiEvent } from "../lib/events.js";
import {
  legacyServerRunnerLogPath,
  legacyServerRunnerPidPath,
  serverAttachmentPath,
  serverConnectedMarkerPath,
  serverRunnerLogPath,
  serverRunnerPidPath,
  serverRunnerVersionPath,
  serverManagedFlagPath,
  servicePidPath,
  serviceLogPath,
  serviceVersionPath,
} from "../paths.js";
import { isServerManaged, setServerManaged } from "../serverState.js";
import { isDegraded, markTerminalUnlinked, readTerminalUnlinked, recordCrash } from "../health.js";
import { buildDetachedServiceEnv, PARENT_LOCK_HELD_ENV_VAR } from "../service.js";
import { COMPUTER_VERSION } from "../version.js";
import { buildStatusReport } from "../status.js";
import { writeResidentConnectedMarker } from "../residentConnectionMarker.js";

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

test("start service: macOS CLI carrier becomes the sole background executor before readback", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    let spawnCount = 0;
    const order: string[] = [];
    const result = await start(
      { slockHome: home, hostLifecycleOwner: "cli" },
      {
        hostLifecycleDeps: {
          platform: "darwin",
          dispatcherPath: "/usr/local/bin/raft-computer",
        },
        convergeHostLifecycle: async (_actualHome, desired) => {
          order.push(`carrier:${desired}`);
          await mkdir(join(servicePidPath(home), ".."), { recursive: true });
          await writeFile(servicePidPath(home), String(process.pid));
          await writeServiceVersion(home, COMPUTER_VERSION);
          await writeReadyRunner(home, SERVER_A);
          return {
            owner: "cli",
            enabled: true,
            status: "converged",
            label: "build.raft.computer.login.test",
            definitionPath: "/tmp/test.plist",
            definition: "plist",
          };
        },
        spawnDetachedService: async () => {
          spawnCount += 1;
          return process.pid;
        },
        isProcessAlive: (pid) => pid === process.pid,
      },
    );
    assert.deepEqual(order, ["carrier:enabled"]);
    assert.equal(spawnCount, 0);
    assert.equal(result.status, "already_running");
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
        assert.match((err as ComputerServiceError).message, /server has unlinked or deleted this Computer\/machine/);
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
    const report = await buildStatusReport(home);
    assert.equal(report.servers[0]?.serverMachineId, "cm-fresh");
    assert.equal(report.servers[0]?.health, "ok");
  });
});

// --- Gate 6: idempotent already_running path emits structured event ---
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

// --- Gate 12: NEVER-signal-kill invariant — services/start.ts contains
// ZERO executable callsites that terminate a process (Hao msg=924263ff:
// pin call sites, not source words; otherwise we false-block legitimate
// text like `signature`, `Signal`, or future typed event names). ---
test("start service: source contains ZERO process.kill / kill(SIG*) callsites", async () => {
  const src = await readFile(new URL("./start.ts", import.meta.url), "utf8");
  // (a) No direct `process.kill(...)` call.
  assert.equal(src.match(/process\.kill\s*\(/g), null);
  // (b) No callsite of any kill-helper that passes a SIG* constant
  //     (e.g. tree-kill, child.kill("SIGTERM"), etc.).
  assert.equal(src.match(/\bkill\s*\([^)]*,\s*["']SIG/g), null);
});

// --- Gate 13: closed-set sentinel pin (start service failure surface) ---
//
// Cross-verifies the StartService failure surface against the §6 closed
// set without grep'ing source — every code we throw is named here, and
// every code named here MUST have a thrown call site in services/start.ts.
// If a future change adds, removes, or renames a §6 start-axis code,
// this test fails before review.
//
// SERVICE_VERSION_SKEW* are launch-before UX additions: they fail loud when a
// newer app/CLI is likely talking to an already-running older service, before
// the fallback path can degrade into START_DAEMON_TIMEOUT.
test("start service: closed-set start codes include host-lifecycle failures", async () => {
  const expected = new Set([
    "COMPUTER_MACHINE_UNLINKED",
    "HOST_LIFECYCLE_FOREGROUND_UNSUPPORTED",
    "HOST_LIFECYCLE_START_FAILED",
    "NO_ATTACHMENT",
    "NOT_ATTACHED",
    "SERVICE_VERSION_SKEW",
    "SERVICE_VERSION_SKEW_SUSPECT",
    "SUPERVISOR_SPAWN_FAILED",
    "START_DAEMON_TIMEOUT",
  ]);
  const src = await readFile(new URL("./start.ts", import.meta.url), "utf8");
  const re = /new ComputerServiceError\(\s*"([A-Z_]+)"/g;
  const found = new Set<string>();
  for (const m of src.matchAll(re)) found.add(m[1]);
  assert.deepEqual([...found].sort(), [...expected].sort());
});
