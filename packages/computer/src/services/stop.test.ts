// Byte-pin tests for the StopService seam extraction (Hao msg=51a17400 +
// liuliu msg=7a1a2c3d / 35034229 / 240069cd / bb503633).
//
// Companion: ../service.test.ts asserts the CLI adapter (`runStop`)
// still emits the pre-extraction info()/fail() lines byte-identically.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ComputerServiceError } from "./errors";
import { stop } from "./stop";
import type { ComputerApiEvent } from "../lib/events";
import { servicePidPath, serviceVersionPath } from "../paths";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-stop-svc-"));
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

async function writePidfile(home: string, pid: number): Promise<void> {
  const p = servicePidPath(home);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, String(pid), { mode: 0o600 });
}

// --- Gate 1: STOP_SIGNAL_FAILED (kill throws) ---
test("stop service: kill throws → STOP_SIGNAL_FAILED with pid + actionable hint + cause", async () => {
  await withHome(async (home) => {
    await assert.rejects(
      () =>
        stop(
          { slockHome: home },
          {
            readPidfile: async () => 12345,
            isProcessAlive: () => true,
            killService: () => {
              const e = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
              e.code = "EPERM";
              throw e;
            },
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "STOP_SIGNAL_FAILED");
        assert.match((err as ComputerServiceError).message, /pid 12345/);
        assert.match((err as ComputerServiceError).message, /EPERM/);
        assert.match((err as ComputerServiceError).message, /kill 12345/);
        assert.ok((err as ComputerServiceError).cause instanceof Error);
        return true;
      },
    );
  });
});

// --- Gate 2: STOP_TIMEOUT (service doesn't exit after SIGTERM) ---
test("stop service: SIGTERM succeeds + service never exits → STOP_TIMEOUT with kill -9 hint", async () => {
  await withHome(async (home) => {
    await assert.rejects(
      () =>
        stop(
          { slockHome: home },
          {
            readPidfile: async () => 12345,
            isProcessAlive: () => true, // never dies
            killService: () => {},
            sleep: async () => undefined,
            pollIntervalMs: 1,
            timeoutMs: 10,
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof ComputerServiceError);
        assert.equal((err as ComputerServiceError).code, "STOP_TIMEOUT");
        assert.match((err as ComputerServiceError).message, /pid 12345/);
        assert.match((err as ComputerServiceError).message, /kill -9 12345/);
        assert.match((err as ComputerServiceError).message, /10ms/);
        return true;
      },
    );
  });
});

// --- Gate 3: not_running idempotent (no pidfile) ---
test("stop service: missing pidfile → status='not_running' + emits not_running event + no kill", async () => {
  await withHome(async (home) => {
    let killCount = 0;
    const events: ComputerApiEvent[] = [];
    const result = await stop(
      { slockHome: home },
      {
        readPidfile: async () => null,
        isProcessAlive: () => false,
        killService: () => {
          killCount += 1;
        },
        onEvent: (e) => events.push(e),
      },
    );
    assert.equal(result.status, "not_running");
    assert.equal(result.pid, null);
    assert.equal(killCount, 0);
    assert.ok(events.find((e) => e.kind === "stop.stopping"));
    assert.ok(events.find((e) => e.kind === "stop.not_running"));
    assert.equal(events.find((e) => e.kind === "stop.signaled"), undefined);
    assert.equal(events.find((e) => e.kind === "stop.stopped"), undefined);
  });
});

test("stop service: successful no-process stop records the disabled macOS CLI host lifecycle", async () => {
  await withHome(async (home) => {
    const order: string[] = [];
    const result = await stop(
      { slockHome: home, hostLifecycleOwner: "cli" },
      {
        hostLifecycleDeps: { platform: "darwin" },
        convergeHostLifecycle: async (_actualHome, desired) => {
          order.push(`lifecycle:${desired}`);
          return {
            owner: "cli",
            enabled: false,
            status: "not-applicable",
            label: null,
            definitionPath: null,
            definition: null,
          };
        },
        readPidfile: async () => {
          order.push("pid-read");
          return null;
        },
        isProcessAlive: () => false,
      },
    );
    assert.equal(result.status, "not_running");
    assert.equal(order.at(-1), "lifecycle:disabled");
    assert.ok(order.slice(0, -1).every((entry) => entry === "pid-read"));
  });
});

test("stop service: a host-lifecycle failure never blocks the stop", async () => {
  await withHome(async (home) => {
    await writePidfile(home, 12345);
    let alive = true;
    const order: string[] = [];
    const events: ComputerApiEvent[] = [];

    const result = await stop(
      { slockHome: home, hostLifecycleOwner: "cli" },
      {
        hostLifecycleDeps: { platform: "darwin" },
        convergeHostLifecycle: async (_actualHome, desired) => {
          order.push(`lifecycle:${desired}`);
          throw new ComputerServiceError("HOST_LIFECYCLE_OWNER_UNREADABLE", "owner record unreadable");
        },
        isProcessAlive: () => alive,
        killService: () => {
          order.push("kill");
          alive = false;
        },
        sleep: async () => undefined,
        onEvent: (event) => events.push(event),
      },
    );

    assert.equal(result.status, "stopped");
    assert.deepEqual(order, ["lifecycle:disabled", "kill"]);
    const skipped = events.find((event) => event.kind === "host_lifecycle.skipped");
    assert.deepEqual(skipped, {
      kind: "host_lifecycle.skipped",
      operation: "stop",
      code: "HOST_LIFECYCLE_OWNER_UNREADABLE",
      message: "owner record unreadable",
    });
  });
});

test("stop service: live macOS CLI service records the disabled host lifecycle before SIGTERM", async () => {
  await withHome(async (home) => {
    await writePidfile(home, 12345);
    let alive = true;
    const order: string[] = [];

    const result = await stop(
      { slockHome: home, hostLifecycleOwner: "cli" },
      {
        hostLifecycleDeps: { platform: "darwin" },
        convergeHostLifecycle: async (_actualHome, desired) => {
          order.push(`lifecycle:${desired}`);
          return {
            owner: "cli",
            enabled: false,
            status: "not-applicable",
            label: null,
            definitionPath: null,
            definition: null,
          };
        },
        isProcessAlive: () => alive,
        killService: () => {
          order.push("kill");
          alive = false;
        },
        sleep: async () => undefined,
      },
    );

    assert.equal(result.status, "stopped");
    assert.deepEqual(order, ["lifecycle:disabled", "kill"]);
  });
});

// --- Gate 4: stale_pidfile_cleared (pidfile present but pid dead) ---
test("stop service: stale pidfile → clears pidfile + status='stale_pidfile_cleared' + no kill", async () => {
  await withHome(async (home) => {
    await writePidfile(home, 99999);
    const pidfilePath = servicePidPath(home);
    let killCount = 0;
    const events: ComputerApiEvent[] = [];
    const result = await stop(
      { slockHome: home },
      {
        readPidfile: async () => 99999,
        isProcessAlive: () => false,
        killService: () => {
          killCount += 1;
        },
        onEvent: (e) => events.push(e),
      },
    );
    assert.equal(result.status, "stale_pidfile_cleared");
    assert.equal(result.pid, 99999);
    assert.equal(killCount, 0);
    // Pidfile cleared from disk.
    await assert.rejects(
      () => readFile(pidfilePath, "utf8"),
      (e) => (e as NodeJS.ErrnoException).code === "ENOENT",
    );
    const cleared = events.find((e) => e.kind === "stop.stale_pidfile_cleared");
    assert.ok(cleared && cleared.kind === "stop.stale_pidfile_cleared");
    assert.equal(cleared.pid, 99999);
    assert.equal(events.find((e) => e.kind === "stop.signaled"), undefined);
  });
});

// --- a live recorded pid that is not the service ---
// A service that ended with its Windows sign-in session leaves run/service.pid
// and service-version.json behind, and the pid goes to an unrelated program.
const SERVICE_RECORDED_AT = "2026-11-13T08:00:00.000Z";

async function writeServiceRecord(home: string, pid: number): Promise<void> {
  await writePidfile(home, pid);
  await writeFile(serviceVersionPath(home), JSON.stringify({ version: "1.22.0", installRoot: "/raft", pid, writtenAt: SERVICE_RECORDED_AT }));
}

test("stop service: a live recorded pid that started after the service's evidence is another program → not signalled, record cleared, reported", async () => {
  await withHome(async (home) => {
    await writeServiceRecord(home, 7720);
    const killed: number[] = [];
    const events: ComputerApiEvent[] = [];
    const result = await stop(
      { slockHome: home },
      {
        isProcessAlive: (pid) => pid === 7720,
        probeLiveServicePid: async () => null, // nothing answers on the IPC endpoint
        processStartTimeMs: async () => Date.parse(SERVICE_RECORDED_AT) + 10 * 60_000,
        killService: (pid) => { killed.push(pid); },
        onEvent: (e) => events.push(e),
      },
    );
    assert.deepEqual(killed, [], "another program is never signalled");
    assert.equal(result.status, "stale_pidfile_cleared");
    assert.equal(result.pid, 7720);
    await assert.rejects(() => readFile(servicePidPath(home), "utf8"), (e) => (e as NodeJS.ErrnoException).code === "ENOENT");
    assert.deepEqual(events.find((e) => e.kind === "stop.stale_pidfile_cleared"), { kind: "stop.stale_pidfile_cleared", pid: 7720, otherProgram: true });
    assert.equal(events.find((e) => e.kind === "stop.signaled"), undefined);
  });
});

for (const [evidence, deps, startReads] of [
  ["the service answering on IPC names that pid", { probeLiveServicePid: async () => 7720 }, 0],
  ["nothing answers, and it started before the service's evidence", { probeLiveServicePid: async () => null, startedAtMs: Date.parse(SERVICE_RECORDED_AT) - 2_000 }, 1],
  ["nothing answers, and its start cannot be read", { probeLiveServicePid: async () => null, startedAtMs: undefined }, 1],
] as const) {
  test(`stop service: a live recorded pid is stopped as before when ${evidence}`, async () => {
    await withHome(async (home) => {
      await writeServiceRecord(home, 7720);
      let alive = true;
      let reads = 0;
      const killed: number[] = [];
      const result = await stop(
        { slockHome: home },
        {
          isProcessAlive: (pid) => pid === 7720 && alive,
          probeLiveServicePid: deps.probeLiveServicePid,
          processStartTimeMs: async () => { reads += 1; return "startedAtMs" in deps ? deps.startedAtMs : undefined; },
          killService: (pid) => { killed.push(pid); alive = false; },
          sleep: async () => undefined,
          inspectSupervisor: async () => null,
        },
      );
      assert.equal(result.status, "stopped");
      assert.deepEqual(killed, [7720]);
      assert.equal(reads, startReads, "a start is read only when the service does not answer");
    });
  });
}

// Another service answering on the endpoint says nothing about the recorded
// pid: only an answer that reports that very pid counts for it.
test("stop service: IPC answers with a different live pid → the recorded pid is judged by its start, never signalled as the service; the answering service is stopped", async () => {
  await withHome(async (home) => {
    await writeServiceRecord(home, 7720);
    const alive = new Set([7720, 8844]);
    let reads = 0;
    const killed: number[] = [];
    const result = await stop(
      { slockHome: home },
      {
        isProcessAlive: (pid) => alive.has(pid),
        probeLiveServicePid: async () => 8844,
        processStartTimeMs: async () => { reads += 1; return Date.parse(SERVICE_RECORDED_AT) + 10 * 60_000; },
        killService: (pid) => { killed.push(pid); alive.delete(pid); },
        sleep: async () => undefined,
        inspectSupervisor: async () => null,
      },
    );
    assert.equal(reads, 1, "the answer from pid 8844 did not vouch for pid 7720");
    assert.deepEqual(killed, [8844]);
    assert.deepEqual({ status: result.status, pid: result.pid }, { status: "stopped", pid: 8844 });
  });
});

// --- task #912: stale pidfile but a service still answers on the IPC endpoint ---
test("stop service: stale pidfile + IPC answers with a live pid → that service is stopped, not reported stale", async () => {
  await withHome(async (home) => {
    await writePidfile(home, 99999); // the killed replacement from a failed self-restart
    const pidfilePath = servicePidPath(home);
    const LIVE = 4242;
    let alive = true;
    const killed: number[] = [];
    const events: ComputerApiEvent[] = [];
    const result = await stop(
      { slockHome: home },
      {
        readPidfile: async () => 99999,
        isProcessAlive: (pid) => pid === LIVE && alive,
        probeLiveServicePid: async () => LIVE,
        killService: (pid) => {
          killed.push(pid);
          alive = false;
        },
        sleep: async () => {},
        onEvent: (e) => events.push(e),
      },
    );
    assert.equal(result.status, "stopped");
    assert.equal(result.pid, LIVE);
    assert.deepEqual(killed, [LIVE]);
    const stopping = events.find((e) => e.kind === "stop.stopping");
    assert.ok(stopping && stopping.kind === "stop.stopping" && stopping.pid === LIVE);
    assert.equal(events.find((e) => e.kind === "stop.stale_pidfile_cleared"), undefined);
    // The incumbent exited on SIGTERM; its pidfile is gone.
    await assert.rejects(
      () => readFile(pidfilePath, "utf8"),
      (e) => (e as NodeJS.ErrnoException).code === "ENOENT",
    );
  });
});

test("stop service: stale pidfile + nothing answers on IPC → still stale_pidfile_cleared, no kill", async () => {
  await withHome(async (home) => {
    await writePidfile(home, 99999);
    let killCount = 0;
    const result = await stop(
      { slockHome: home },
      {
        readPidfile: async () => 99999,
        isProcessAlive: () => false,
        probeLiveServicePid: async () => null,
        killService: () => {
          killCount += 1;
        },
      },
    );
    assert.equal(result.status, "stale_pidfile_cleared");
    assert.equal(result.pid, 99999);
    assert.equal(killCount, 0);
  });
});

test("stop service: an IPC answer naming a dead pid is ignored", async () => {
  await withHome(async (home) => {
    await writePidfile(home, 99999);
    let killCount = 0;
    const result = await stop(
      { slockHome: home },
      {
        readPidfile: async () => 99999,
        isProcessAlive: () => false,
        probeLiveServicePid: async () => 31337,
        killService: () => {
          killCount += 1;
        },
      },
    );
    assert.equal(result.status, "stale_pidfile_cleared");
    assert.equal(killCount, 0);
  });
});

// --- Gate 5: alive service SIGTERM happy path ---
test("stop service: alive service → SIGTERM + waits for exit + status='stopped' + emits signaled+stopped", async () => {
  await withHome(async (home) => {
    await writePidfile(home, 12345);
    const pidfilePath = servicePidPath(home);
    let killed = false;
    let aliveCalls = 0;
    const events: ComputerApiEvent[] = [];
    const result = await stop(
      { slockHome: home },
      {
        readPidfile: async () => 12345,
        // Pre-kill gate sees alive; post-kill polls see dead.
        isProcessAlive: () => {
          aliveCalls += 1;
          return aliveCalls === 1;
        },
        killService: (pid: number) => {
          assert.equal(pid, 12345);
          killed = true;
        },
        sleep: async () => undefined,
        pollIntervalMs: 1,
        timeoutMs: 1000,
        onEvent: (e) => events.push(e),
      },
    );
    assert.equal(killed, true, "SIGTERM must be sent");
    assert.equal(result.status, "stopped");
    assert.equal(result.pid, 12345);
    // Defensive pidfile cleanup ran.
    await assert.rejects(
      () => readFile(pidfilePath, "utf8"),
      (e) => (e as NodeJS.ErrnoException).code === "ENOENT",
    );
    const signaled = events.find((e) => e.kind === "stop.signaled");
    assert.ok(signaled && signaled.kind === "stop.signaled");
    assert.equal(signaled.pid, 12345);
    const stopped = events.find((e) => e.kind === "stop.stopped");
    assert.ok(stopped && stopped.kind === "stop.stopped");
    assert.equal(stopped.pid, 12345);
  });
});

test("stop service sends direct SIGTERM", async () => {
  await withHome(async (home) => {
    await writePidfile(home, 777);
    const signals: string[] = [];
    let aliveChecks = 0;
    const result = await stop(
      { slockHome: home },
      {
        isProcessAlive: () => {
          aliveChecks += 1;
          return aliveChecks === 1;
        },
        killService: (pid) => { signals.push(`${pid}:SIGTERM`); },
        sleep: async () => {},
      },
    );

    assert.equal(result.status, "stopped");
    assert.deepEqual(signals, ["777:SIGTERM"]);
  });
});

// --- Gate 6: pre-aborted AbortSignal throws AbortError (NOT ComputerServiceError) ---
test("stop service: pre-aborted AbortSignal throws AbortError, not ComputerServiceError", async () => {
  await withHome(async (home) => {
    const ac = new AbortController();
    ac.abort();
    let killCount = 0;
    await assert.rejects(
      () =>
        stop(
          { slockHome: home },
          {
            signal: ac.signal,
            readPidfile: async () => 12345,
            isProcessAlive: () => true,
            killService: () => {
              killCount += 1;
            },
          },
        ),
      (err: unknown) => {
        assert.ok(!(err instanceof ComputerServiceError));
        return true;
      },
    );
    assert.equal(killCount, 0, "abort before kill must skip the SIGTERM call");
  });
});

// --- Gate 7: abort BETWEEN pidfile-alive-check and SIGTERM → AbortError, no kill ---
test("stop service: abort between alive-check and SIGTERM → AbortError, no kill sent", async () => {
  await withHome(async (home) => {
    const ac = new AbortController();
    let killCount = 0;
    await assert.rejects(
      () =>
        stop(
          { slockHome: home },
          {
            signal: ac.signal,
            readPidfile: async () => 12345,
            isProcessAlive: () => true,
            killService: () => {
              killCount += 1;
            },
            onEvent: (e) => {
              // Abort right after we observe `stopping` (i.e. before signal).
              if (e.kind === "stop.stopping") ac.abort();
            },
          },
        ),
      (err: unknown) => {
        assert.ok(!(err instanceof ComputerServiceError));
        return true;
      },
    );
    assert.equal(killCount, 0);
  });
});

// --- Gate 8: abort AFTER SIGTERM (during wait loop) → AbortError, NEVER SIGKILL ---
test("stop service: abort during wait-for-exit loop → AbortError + service NOT escalated to SIGKILL", async () => {
  await withHome(async (home) => {
    const ac = new AbortController();
    let killCount = 0;
    let killSignals: string[] = [];
    void killSignals;
    await assert.rejects(
      () =>
        stop(
          { slockHome: home },
          {
            signal: ac.signal,
            readPidfile: async () => 12345,
            isProcessAlive: () => true, // pretend never exits
            killService: () => {
              killCount += 1;
            },
            sleep: async () => undefined,
            pollIntervalMs: 1,
            timeoutMs: 10_000,
            onEvent: (e) => {
              // Abort right after SIGTERM was sent.
              if (e.kind === "stop.signaled") ac.abort();
            },
          },
        ),
      (err: unknown) => {
        assert.ok(!(err instanceof ComputerServiceError));
        return true;
      },
    );
    // Exactly ONE SIGTERM — abort during wait does NOT trigger a second
    // kill / SIGKILL escalation. Stop's contract is "ask politely with
    // SIGTERM then time out", not "force-kill on cancel".
    assert.equal(killCount, 1);
  });
});


// --- task #917: a systemd unit that owns the live pid is stopped through systemd ---
test("task #917: stop delegates to `systemctl stop` when the unit's MainPID is the live service", async () => {
  await withHome(async (home) => {
    let alive = true;
    let killed = 0;
    const calls: string[] = [];
    const result = await stop(
      { slockHome: home },
      {
        readPidfile: async () => 777,
        isProcessAlive: () => alive,
        killService: () => { killed += 1; },
        sleep: async () => undefined,
        pollIntervalMs: 1,
        timeoutMs: 50,
        inspectSupervisor: async () => ({
          record: { kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "x", pid: 777, recordedAt: "t" },
          unitLoaded: true, enabledState: "enabled", activeState: "active", mainPid: 777, killMode: "process", reachable: true,
        }),
        systemctl: async (scope, args) => { calls.push(`${scope}:${args.join(" ")}`); alive = false; return { code: 0, stdout: "", stderr: "" }; },
      },
    );
    assert.equal(result.status, "stopped");
    assert.deepEqual(calls, ["user:stop raft-computer.service"]);
    assert.equal(killed, 0, "no SIGTERM from here: the unit's Restart= policy would answer it with a relaunch");
  });
});

test("task #917: stop never acts beside an unreachable manager, and reports a failing systemctl", async () => {
  await withHome(async (home) => {
    const record = { kind: "systemd" as const, scope: "user" as const, unit: "raft-computer.service", invocationId: "x", pid: 777, recordedAt: "t" };
    let killed = 0;
    await assert.rejects(
      () => stop({ slockHome: home }, {
        readPidfile: async () => 777, isProcessAlive: () => true, killService: () => { killed += 1; },
        inspectSupervisor: async () => ({ record, unitLoaded: false, enabledState: null, activeState: null, mainPid: null, killMode: null, reachable: false }),
      }),
      (err: unknown) => err instanceof ComputerServiceError && err.code === "STOP_SUPERVISOR_UNREACHABLE" && /XDG_RUNTIME_DIR/.test(err.message),
    );
    await assert.rejects(
      () => stop({ slockHome: home }, {
        readPidfile: async () => 777, isProcessAlive: () => true, killService: () => { killed += 1; },
        inspectSupervisor: async () => ({ record, unitLoaded: true, enabledState: "enabled", activeState: "active", mainPid: 777, killMode: "process", reachable: true }),
        systemctl: async () => ({ code: 1, stdout: "", stderr: "Failed to stop raft-computer.service: Access denied" }),
      }),
      (err: unknown) => err instanceof ComputerServiceError && err.code === "STOP_SUPERVISOR_FAILED" && /Access denied/.test(err.message),
    );
    assert.equal(killed, 0);
  });
});

test("task #917: a unit that does not own the live pid leaves the SIGTERM path untouched", async () => {
  await withHome(async (home) => {
    let alive = true;
    let killed = 0;
    const result = await stop(
      { slockHome: home },
      {
        readPidfile: async () => 777,
        isProcessAlive: () => alive,
        killService: () => { killed += 1; alive = false; },
        sleep: async () => undefined, pollIntervalMs: 1, timeoutMs: 50,
        inspectSupervisor: async () => ({
          record: { kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "x", pid: 1, recordedAt: "t" },
          unitLoaded: true, enabledState: "enabled", activeState: "inactive", mainPid: 0, killMode: "process", reachable: true,
        }),
        systemctl: async () => { throw new Error("must not be called"); },
      },
    );
    assert.equal(result.status, "stopped");
    assert.equal(killed, 1);
  });
});
