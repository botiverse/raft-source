import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import { resetRunner, resetService } from "./reset.js";
import {
  recordCrash,
  isDegraded,
  resetRunnerHealth,
  markFatalConfig,
} from "./health.js";
import {
  clearServiceCrashHistory,
  readServiceState,
} from "./serviceState.js";
import {
  serverAttachmentPath,
  serverHealthPath,
  serviceStatePath,
  serviceLogPath,
} from "./paths.js";

// PR-impl-3 commit 1 — internal reset mutation type pins.
//
// Coverage anchors (RFC v9.8):
//   - §1.3 reset-service: clear crashHistory + degraded→running trace,
//     MUST NOT touch runners (per-runner health.json untouched).
//   - §2.4 reset-runner: clear per-runner crashHistory + degraded→running
//     trace, MUST NOT respawn or kill the runner process. Other runners
//     untouched.
//   - Result shape pin: `ResetServiceResult` / `ResetRunnerResult`
//     concrete shapes (carries the §3.2 RequestMethodMap.result pins).
//   - State-machine modeling discipline: every transition emits
//     `{fromState, toState, trigger}` to service.log.

const SERVER_A = "11111111-1111-4111-8111-111111111111";
const SERVER_B = "22222222-2222-4222-8222-222222222222";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-reset-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAttach(home: string, serverId: string): Promise<void> {
  const file = serverAttachmentPath(home, serverId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      kind: "computer-attachment",
      serverId,
      serverMachineId: `cm-${serverId}`,
      apiKey: `sk_computer_${serverId}`,
      serverUrl: "https://api.example.test",
    }),
    { mode: 0o600 },
  );
}

async function readServiceLogLines(home: string): Promise<unknown[]> {
  try {
    const raw = await readFile(serviceLogPath(home), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

test("resetService clears empty service.state.json from a fresh install", async () => {
  await withHome(async (home) => {
    const result = await resetService(home);
    assert.equal(result.status, "ok");
    assert.equal(result.previousState, "running");
    assert.equal(result.clearedCrashCount, 0);

    const state = await readServiceState(home);
    assert.equal(state.state, "running");
    assert.deepEqual(state.crashHistory, []);
  });
});

test("resetService clears crashHistory and transitions degraded → running", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(
      serviceStatePath(home),
      JSON.stringify({
        state: "degraded",
        crashHistory: [
          { at: "2026-05-29T00:00:00.000Z", exitCode: 1, signal: null },
          { at: "2026-05-29T00:00:30.000Z", exitCode: 1, signal: null },
        ],
      }),
    );

    const result = await resetService(home);
    assert.equal(result.status, "ok");
    assert.equal(result.previousState, "degraded");
    assert.equal(result.clearedCrashCount, 2);

    const state = await readServiceState(home);
    assert.equal(state.state, "running");
    assert.deepEqual(state.crashHistory, []);
  });
});

test("resetService emits {fromState,toState,trigger} transition trace", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(
      serviceStatePath(home),
      JSON.stringify({ state: "degraded", crashHistory: [] }),
    );

    await clearServiceCrashHistory(home);
    const entries = await readServiceLogLines(home);

    const transitions = entries.filter(
      (e): e is { kind: string; fromState: string; toState: string; trigger: string } =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>).kind === "service-state-changed",
    );
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].fromState, "degraded");
    assert.equal(transitions[0].toState, "running");
    assert.equal(transitions[0].trigger, "reset-service");
  });
});

test("resetService MUST NOT touch per-runner health.json (§1.3 invariant)", async () => {
  await withHome(async (home) => {
    // Set up a per-runner health.json with crashes — simulates a runner
    // that has recently crashed. resetService should leave it alone.
    for (let i = 0; i < 3; i++) {
      await recordCrash(home, SERVER_A, 1, null, Date.parse("2026-05-29T00:00:00Z") + i * 1000);
    }
    assert.equal(await isDegraded(home, SERVER_A, Date.parse("2026-05-29T00:00:05Z")), true);
    const runnerHealthBefore = await readFile(serverHealthPath(home, SERVER_A), "utf8");

    await resetService(home);

    // Per-runner health.json byte-identical after service reset.
    const runnerHealthAfter = await readFile(serverHealthPath(home, SERVER_A), "utf8");
    assert.equal(runnerHealthAfter, runnerHealthBefore);
    assert.equal(await isDegraded(home, SERVER_A, Date.parse("2026-05-29T00:00:05Z")), true);
  });
});

test("resetRunner clears per-runner crashHistory and transitions degraded → running", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    // Crash timestamps must fall inside the 60s window of resetRunner's
    // internal Date.now() check — anchor relative to wall clock instead
    // of a fixed UTC instant so the test is stable across run-times.
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await recordCrash(home, SERVER_A, 1, null, now - 5000 + i * 1000);
    }
    assert.equal(await isDegraded(home, SERVER_A), true);

    const result = await resetRunner(home, SERVER_A);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.serverId, SERVER_A);
    assert.equal(result.previousState, "degraded");
    assert.equal(result.clearedCrashCount, 3);

    // health.json gone → no longer degraded.
    assert.equal(await fileExists(serverHealthPath(home, SERVER_A)), false);
    assert.equal(await isDegraded(home, SERVER_A), false);
  });
});

test("resetRunner reports previousState=running when runner is healthy", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    const result = await resetRunner(home, SERVER_A);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.previousState, "running");
    assert.equal(result.clearedCrashCount, 0);
  });
});

test("resetRunner returns not-found for an invalid serverId", async () => {
  await withHome(async (home) => {
    const result = await resetRunner(home, "not-a-uuid");
    assert.equal(result.status, "not-found");
    if (result.status !== "not-found") return;
    assert.equal(result.serverId, "not-a-uuid");
  });
});

test("resetRunner gates on Computer attachment — valid UUID without attachment returns not-found, leaves health.json untouched, emits no trace", async () => {
  // Hao PR-head review blocker (`#wg-raft-computer:7d0e52d8 msg=d7516b60`):
  // the IPC `reset-runner` handler must not let any valid-shape UUID
  // clear residue health.json or emit `runner-state-changed` for runners
  // this Computer does not manage. The lib-pure handler is the boundary
  // point — gate on `readServerAttachment` before touching health state.
  await withHome(async (home) => {
    // Pre-existing residue health.json for SERVER_A — simulates a stale
    // record from a previous (now-detached) attachment.
    for (let i = 0; i < 3; i++) {
      await recordCrash(home, SERVER_A, 1, null, Date.parse("2026-05-29T00:00:00Z") + i * 1000);
    }
    const residueBefore = await readFile(serverHealthPath(home, SERVER_A), "utf8");
    assert.equal(await fileExists(serviceLogPath(home)), false);

    // No runner.state.json for SERVER_A — IPC should short-circuit.
    const result = await resetRunner(home, SERVER_A);
    assert.equal(result.status, "not-found");
    if (result.status !== "not-found") return;
    assert.equal(result.serverId, SERVER_A);

    // Residue untouched: file byte-identical, still degraded.
    const residueAfter = await readFile(serverHealthPath(home, SERVER_A), "utf8");
    assert.equal(residueAfter, residueBefore);
    assert.equal(await isDegraded(home, SERVER_A, Date.parse("2026-05-29T00:00:05Z")), true);

    // No trace emitted — short-circuit fires before emitRunnerStateTransition.
    const entries = await readServiceLogLines(home);
    const transitions = entries.filter(
      (e): e is { kind: string } =>
        typeof e === "object" && e !== null && (e as Record<string, unknown>).kind === "runner-state-changed",
    );
    assert.deepEqual(transitions, []);
  });
});

test("resetRunner emits {fromState,toState,trigger} transition trace", async () => {
  await withHome(async (home) => {
    for (let i = 0; i < 3; i++) {
      await recordCrash(home, SERVER_A, 1, null, Date.parse("2026-05-29T00:00:00Z") + i * 1000);
    }
    await resetRunnerHealth(home, SERVER_A, Date.parse("2026-05-29T00:00:05Z"));
    const entries = await readServiceLogLines(home);

    const transitions = entries.filter(
      (e): e is { kind: string; serverId: string; fromState: string; toState: string; trigger: string } =>
        typeof e === "object" &&
        e !== null &&
        (e as Record<string, unknown>).kind === "runner-state-changed",
    );
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].serverId, SERVER_A);
    assert.equal(transitions[0].fromState, "degraded");
    assert.equal(transitions[0].toState, "running");
    assert.equal(transitions[0].trigger, "reset-runner");
  });
});

test("resetRunner MUST NOT touch sibling runners' health.json (§2.4 isolation)", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await writeAttach(home, SERVER_B);
    for (let i = 0; i < 3; i++) {
      await recordCrash(home, SERVER_A, 1, null, Date.parse("2026-05-29T00:00:00Z") + i * 1000);
    }
    for (let i = 0; i < 3; i++) {
      await recordCrash(home, SERVER_B, 1, null, Date.parse("2026-05-29T00:00:00Z") + i * 1000);
    }
    const siblingBefore = await readFile(serverHealthPath(home, SERVER_B), "utf8");

    await resetRunner(home, SERVER_A);

    // Server B's health.json untouched.
    const siblingAfter = await readFile(serverHealthPath(home, SERVER_B), "utf8");
    assert.equal(siblingAfter, siblingBefore);
    assert.equal(await isDegraded(home, SERVER_B, Date.parse("2026-05-29T00:00:05Z")), true);
    // Server A reset.
    assert.equal(await fileExists(serverHealthPath(home, SERVER_A)), false);
  });
});

test("resetRunner clears the fatal-config marker (§2.4 reset covers both degraded paths)", async () => {
  await withHome(async (home) => {
    await writeAttach(home, SERVER_A);
    await markFatalConfig(home, SERVER_A, 78, null);
    assert.equal(await isDegraded(home, SERVER_A), true);

    const result = await resetRunner(home, SERVER_A);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.previousState, "degraded");
    assert.equal(await isDegraded(home, SERVER_A), false);
  });
});

test("readServiceState defaults to running/[] on missing file (forward-compat baseline)", async () => {
  await withHome(async (home) => {
    const state = await readServiceState(home);
    assert.equal(state.state, "running");
    assert.deepEqual(state.crashHistory, []);
  });
});

test("readServiceState coerces unknown state strings back to running", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer", "run"), { recursive: true });
    await writeFile(
      serviceStatePath(home),
      JSON.stringify({ state: "not-a-real-state", crashHistory: [] }),
    );
    const state = await readServiceState(home);
    assert.equal(state.state, "running");
  });
});

test("service.state.json is written with mode 0o600 (no token leak surface)", async () => {
  await withHome(async (home) => {
    await resetService(home);
    const s = await stat(serviceStatePath(home));
    // Permission bits modulo umask — the file MUST not be world-readable.
    const mode = s.mode & 0o777;
    assert.equal(mode & 0o077, 0, `expected 0o600, got 0o${mode.toString(8)}`);
  });
});
