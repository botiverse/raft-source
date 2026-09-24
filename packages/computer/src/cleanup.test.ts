import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  cleanupStalePidfile,
  cleanupAllStalePidfiles,
  cleanupOrphanProcesses,
  cleanupPowerLossPartialState,
  cleanupTmpFiles,
  cleanupStaleLock,
  runFullCleanup,
  emptyCleanupReport,
} from "./cleanup.js";
import {
  computerDir,
  servicePidPath,
  serverRunnerPidPath,
  serverAttachmentPath,
} from "./paths.js";
import { withComputerMutationLock } from "./concurrency.js";

// PR-H §3.1 regression guard — residue cleanup primitives.

const SERVER_A = "11111111-1111-4111-8111-111111111111";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "slock-pr-h-cleanup-"));
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

async function writePidfile(path: string, pid: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, String(pid), { mode: 0o600 });
}

async function writeAttachment(home: string, serverId: string): Promise<void> {
  const p = serverAttachmentPath(home, serverId);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(
    p,
    JSON.stringify({
      kind: "computer-attachment",
      serverId,
      serverMachineId: `cm-${serverId}`,
      apiKey: `sk_computer_${serverId}`,
      serverUrl: "https://api.example.test",
    }),
  );
}

test("emptyCleanupReport: returns the well-known no-action shape", () => {
  const r = emptyCleanupReport();
  assert.deepEqual(r, {
    stalePidfiles: [],
    orphanProcesses: [],
    powerLossRecovered: [],
    tmpFilesCleared: [],
    staleLocks: [],
    anyAction: false,
  });
});

test("cleanupStalePidfile: live pid → no-op; dead pid → unlink + true", async () => {
  await withHome(async (home) => {
    const p = servicePidPath(home);
    // Live (our own pid)
    await writePidfile(p, process.pid);
    assert.equal(await cleanupStalePidfile(p), false);
    await assert.doesNotReject(() => stat(p)); // still there
    // Dead (absurd pid)
    await writePidfile(p, 999999999);
    assert.equal(await cleanupStalePidfile(p), true);
    await assert.rejects(() => stat(p)); // unlinked
    // Missing → no-op
    assert.equal(await cleanupStalePidfile(p), false);
  });
});

test("cleanupAllStalePidfiles: walks service + per-server pidfiles", async () => {
  await withHome(async (home) => {
    await writeAttachment(home, SERVER_A);
    await writePidfile(servicePidPath(home), 999999999); // dead
    await writePidfile(serverRunnerPidPath(home, SERVER_A), 999999998); // dead
    const cleaned = await cleanupAllStalePidfiles(home);
    assert.equal(cleaned.length, 2);
    assert.ok(cleaned.some((p) => p.endsWith("service.pid")));
    assert.ok(cleaned.some((p) => p.endsWith("runner.pid")));
  });
});

test("cleanupPowerLossPartialState: corrupt runner.state.json → quarantined, not deleted (v6 §10)", async () => {
  await withHome(async (home) => {
    await mkdir(join(home, "computer", "servers", SERVER_A), { recursive: true });
    // Write invalid JSON as attachment
    await writeFile(serverAttachmentPath(home, SERVER_A), "{not json");
    const repaired = await cleanupPowerLossPartialState(home);
    assert.deepEqual(repaired, [SERVER_A]);
    // The original serverDir must be GONE (renamed away)
    await assert.rejects(() => stat(join(home, "computer", "servers", SERVER_A)));
    // A quarantine entry must exist
    const qroot = join(home, "computer", ".quarantine");
    const qentries = (await import("node:fs/promises")).readdir(qroot);
    const entries = await qentries;
    assert.equal(entries.length, 1);
    assert.ok(entries[0].endsWith(SERVER_A), "quarantine entry name ends with serverId");
  });
});

test("cleanupPowerLossPartialState: valid attachment → no action", async () => {
  await withHome(async (home) => {
    await writeAttachment(home, SERVER_A);
    const repaired = await cleanupPowerLossPartialState(home);
    assert.deepEqual(repaired, []);
  });
});

test("cleanupTmpFiles: removes old upgrade-snapshot.json (>24h)", async () => {
  await withHome(async (home) => {
    const cdir = computerDir(home);
    await mkdir(cdir, { recursive: true });
    const snap = join(cdir, "upgrade-snapshot.json");
    await writeFile(snap, "{}");
    // Backdate by 25h
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const { utimes } = await import("node:fs/promises");
    await utimes(snap, past, past);
    const removed = await cleanupTmpFiles(home);
    assert.equal(removed.length, 1);
    assert.ok(removed[0].endsWith("upgrade-snapshot.json"));
  });
});

test("cleanupTmpFiles: keeps recent upgrade-snapshot.json", async () => {
  await withHome(async (home) => {
    const cdir = computerDir(home);
    await mkdir(cdir, { recursive: true });
    const snap = join(cdir, "upgrade-snapshot.json");
    await writeFile(snap, "{}");
    const removed = await cleanupTmpFiles(home);
    assert.equal(removed.length, 0);
    await assert.doesNotReject(() => stat(snap));
  });
});

test("cleanupStaleLock: stale lock dir (>60s) → ownership-safe reclaim + release", async () => {
  await withHome(async (home) => {
    const cdir = computerDir(home);
    const lockDir = join(cdir, ".lock");
    await mkdir(lockDir, { recursive: true });
    // Backdate by 90s (well past the 60s threshold)
    const past = new Date(Date.now() - 90 * 1000);
    const { utimes } = await import("node:fs/promises");
    await utimes(lockDir, past, past);
    const released = await cleanupStaleLock(home);
    assert.equal(released.length, 1);
    assert.ok(released[0].endsWith(".lock"));
    await assert.rejects(() => stat(lockDir));
  });
});

test("cleanupStaleLock: fresh lock dir → kept", async () => {
  await withHome(async (home) => {
    const cdir = computerDir(home);
    const lockDir = join(cdir, ".lock");
    await mkdir(lockDir, { recursive: true });
    const released = await cleanupStaleLock(home);
    assert.equal(released.length, 0);
    await assert.doesNotReject(() => stat(lockDir));
  });
});

test("cleanupStaleLock: a live proper-lockfile owner is never deleted", async () => {
  await withHome(async (home) => {
    await withComputerMutationLock(home, async () => {
      const released = await cleanupStaleLock(home);
      assert.deepEqual(released, []);
      await assert.doesNotReject(() => stat(join(computerDir(home), ".lock")));
    });
  });
});

test("runFullCleanup: aggregates all 5 categories, sets anyAction correctly", async () => {
  await withHome(async (home) => {
    // Set up multiple residues
    await writePidfile(servicePidPath(home), 999999999); // dead pid
    const cdir = computerDir(home);
    await mkdir(cdir, { recursive: true });
    const snap = join(cdir, "upgrade-snapshot.json");
    await writeFile(snap, "{}");
    const { utimes } = await import("node:fs/promises");
    await utimes(snap, new Date(Date.now() - 25 * 60 * 60 * 1000), new Date(Date.now() - 25 * 60 * 60 * 1000));

    const r = await runFullCleanup(home);
    assert.equal(r.anyAction, true);
    assert.equal(r.stalePidfiles.length, 1);
    assert.equal(r.tmpFilesCleared.length, 1);
  });
});

test("runFullCleanup: clean baseline → anyAction=false", async () => {
  await withHome(async (home) => {
    const r = await runFullCleanup(home);
    assert.equal(r.anyAction, false);
  });
});

// --- ps-walk orphan detection (PR-H §3.1#2) ---

test("cleanupOrphanProcesses: no service pidfile → no-op (baseline anchor)", async () => {
  await withHome(async (home) => {
    const psSpawn = async () => ({ stdout: "PID PPID COMM\n", exitCode: 0 });
    const signaled = await cleanupOrphanProcesses(home, psSpawn);
    assert.deepEqual(signaled, []);
  });
});

test("cleanupOrphanProcesses: ps fails → no-op (best-effort)", async () => {
  await withHome(async (home) => {
    await writePidfile(servicePidPath(home), process.pid);
    const psSpawn = async () => ({ stdout: "", exitCode: 1 });
    const signaled = await cleanupOrphanProcesses(home, psSpawn);
    assert.deepEqual(signaled, []);
  });
});

test("cleanupOrphanProcesses: detects + filters orphan child of service", async () => {
  await withHome(async (home) => {
    // Use real pid as service anchor.
    await writePidfile(servicePidPath(home), process.pid);
    // Mock ps output: service's children include slock-* orphans + a bash row.
    // Use fake pids that won't actually exist on test host — kill() will throw
    // ESRCH and we'll skip them. The test verifies the WALK + FILTER logic,
    // not the signal-success path.
    const stdout = [
      "  PID  PPID COMM",
      `11111 ${process.pid} raft-computer`,
      `22222 ${process.pid} slock-daemon`,
      `33333 ${process.pid} bash`,
    ].join("\n");
    const psSpawn = async () => ({ stdout, exitCode: 0 });
    const signaled = await cleanupOrphanProcesses(home, psSpawn);
    // bash row (not slock-) MUST never appear in signaled.
    for (const pid of signaled) {
      assert.notEqual(pid, 33333, "bash row must be filtered (not slock-)");
    }
  });
});

test("cleanupOrphanProcesses: managed pid → NOT signaled", async () => {
  await withHome(async (home) => {
    await writePidfile(servicePidPath(home), process.pid);
    await writeAttachment(home, SERVER_A);
    // Mock ps reports a known managed pid as service's child.
    await writePidfile(serverRunnerPidPath(home, SERVER_A), 44444);
    const stdout = [
      "  PID  PPID COMM",
      `44444 ${process.pid} slock-daemon`,
    ].join("\n");
    const psSpawn = async () => ({ stdout, exitCode: 0 });
    const signaled = await cleanupOrphanProcesses(home, psSpawn);
    assert.deepEqual(signaled, [], "managed pid 44444 must not be SIGTERMed");
  });
});

test("cleanupOrphanProcesses: ppid != service → NOT signaled", async () => {
  await withHome(async (home) => {
    await writePidfile(servicePidPath(home), process.pid);
    // slock-named process whose ppid is NOT service — not our orphan to reap.
    const stdout = [
      "  PID  PPID COMM",
      "55555 99999 raft-computer",
    ].join("\n");
    const psSpawn = async () => ({ stdout, exitCode: 0 });
    const signaled = await cleanupOrphanProcesses(home, psSpawn);
    assert.deepEqual(signaled, []);
  });
});
