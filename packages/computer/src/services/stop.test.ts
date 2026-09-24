// Byte-pin tests for the StopService seam extraction (Hao msg=51a17400 +
// liuliu msg=7a1a2c3d / 35034229 / 240069cd / bb503633).
//
// Companion: ../service.test.ts asserts the CLI adapter (`runStop`)
// still emits the pre-extraction info()/fail() lines byte-identically.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { ComputerServiceError } from "./errors.js";
import { stop } from "./stop.js";
import type { ComputerApiEvent } from "../lib/events.js";
import { servicePidPath } from "../paths.js";

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

test("stop service: successful no-process stop durably disables the macOS CLI carrier", async () => {
  await withHome(async (home) => {
    const order: string[] = [];
    const result = await stop(
      { slockHome: home, hostLifecycleOwner: "cli" },
      {
        hostLifecycleDeps: {
          platform: "darwin",
          dispatcherPath: "/usr/local/bin/raft-computer",
        },
        convergeHostLifecycle: async (_actualHome, desired) => {
          order.push(`carrier:${desired}`);
          return {
            owner: "cli",
            enabled: false,
            status: "converged",
            label: "build.raft.computer.login.test",
            definitionPath: "/tmp/test.plist",
            definition: "plist",
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
    assert.equal(order.at(-1), "carrier:disabled");
    assert.ok(order.slice(0, -1).every((entry) => entry === "pid-read"));
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

// The default OS signal is not visible through the injected one-argument
// kill seam used by the runtime matrix. Treat the complete production source
// as the negative policy subject: Stop owns one direct signal authority and it
// must remain graceful TERM-only, with no numeric or SIGKILL escalation path.
test("stop service: source has exactly one graceful process.kill(SIGTERM) authority", async () => {
  const raw = await readFile(new URL("./stop.ts", import.meta.url), "utf8");
  const src = raw
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  assert.equal(src.match(/process\.kill\s*\(/g)?.length, 1);
  assert.match(src, /process\.kill\s*\([^)]*,\s*["']SIGTERM["']\s*\)/);
  assert.equal(src.match(/\b(?:process\.)?kill\s*\([^)]*,\s*(?:9|["']SIGKILL["'])/g), null);
});
