import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type ProcessStartIdentity, readProcessStartIdentitySync } from "./drivers/processTree";
import {
  acquireDaemonMachineLock,
  DaemonMachineLockConflictError,
  getDaemonMachineLockId,
  MACHINE_LOCK_PID_REUSE_TOLERANCE_MS,
  type MachineLockProcessProbe,
  resolveDefaultMachineStateRoot,
} from "./machineLock";

test("daemon machine lock serializes one running daemon per machine key", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-machine-lock-test-"));

  try {
    const first = acquireDaemonMachineLock({
      apiKey: "sk_machine_test",
      serverUrl: "https://daemon.example.com",
      rootDir,
    });

    assert.equal(first.lockId, getDaemonMachineLockId("sk_machine_test"));
    assert.match(first.machineDir, /machine-/);
    const owner = JSON.parse(await readFile(path.join(first.lockDir, "owner.json"), "utf8")) as {
      pid: number;
      schemaVersion?: number;
      kind?: string;
    };
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.schemaVersion, 2);
    assert.equal(owner.kind, "legacy_raw_daemon");

    assert.throws(
      () => acquireDaemonMachineLock({ apiKey: "sk_machine_test", serverUrl: "https://daemon.example.com", rootDir }),
      /Another Slock daemon is already running/,
    );

    first.release();
    const second = acquireDaemonMachineLock({
      apiKey: "sk_machine_test",
      serverUrl: "https://daemon.example.com",
      rootDir,
    });
    second.release();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("daemon machine lock preserves machine identity (owner.json) across a clean release", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-machine-lock-identity-test-"));

  try {
    const lock = acquireDaemonMachineLock({
      apiKey: "sk_machine_test",
      serverUrl: "https://daemon.example.com",
      rootDir,
    });
    const ownerPath = path.join(lock.lockDir, "owner.json");
    const before = JSON.parse(await readFile(ownerPath, "utf8")) as {
      pid: number;
      apiKeyFingerprint: string;
      schemaVersion?: number;
      kind?: string;
    };
    assert.equal(before.pid, process.pid);
    assert.equal(before.schemaVersion, 2);
    assert.equal(before.kind, "legacy_raw_daemon");

    lock.release();

    // The identity fingerprint MUST survive a clean shutdown so a stopped
    // legacy daemon stays discoverable for Computer migration ("Ctrl-C
    // then `raft-computer setup`"). Previously release() removed
    // owner.json with the lock dir, which silently fresh-attached a
    // duplicate machine on upgrade.
    const after = JSON.parse(await readFile(ownerPath, "utf8")) as {
      pid: number;
      apiKeyFingerprint: string;
      schemaVersion?: number;
      kind?: string;
    };
    assert.equal(after.apiKeyFingerprint, before.apiKeyFingerprint);
    assert.equal(after.schemaVersion, 2);
    assert.equal(after.kind, "legacy_raw_daemon");
    // The live-pid claim is neutralized (0) so the lock is relinquished
    // and can never collide with a recycled live pid.
    assert.equal(after.pid, 0);

    // A subsequent acquire reclaims the released (pid-0) lock cleanly and
    // takes ownership with the new live pid.
    const next = acquireDaemonMachineLock({
      apiKey: "sk_machine_test",
      serverUrl: "https://daemon.example.com",
      rootDir,
    });
    const reacquired = JSON.parse(await readFile(path.join(next.lockDir, "owner.json"), "utf8")) as {
      pid: number;
    };
    assert.equal(reacquired.pid, process.pid);
    next.release();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("daemon machine lock writes and preserves managed Computer provenance", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-machine-lock-managed-test-"));

  try {
    const lock = acquireDaemonMachineLock({
      apiKey: "sk_computer_test",
      serverUrl: "https://daemon.example.com",
      rootDir,
      ownerProvenance: {
        kind: "managed_computer_runner",
        serverId: "11111111-1111-4111-8111-111111111111",
        serverMachineId: "22222222-2222-4222-8222-222222222222",
      },
    } as never);
    const ownerPath = path.join(lock.lockDir, "owner.json");
    const readOwner = async () => JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;

    assert.deepEqual(
      await readOwner().then(({ schemaVersion, kind, serverId, serverMachineId }) => ({
        schemaVersion,
        kind,
        serverId,
        serverMachineId,
      })),
      {
        schemaVersion: 2,
        kind: "managed_computer_runner",
        serverId: "11111111-1111-4111-8111-111111111111",
        serverMachineId: "22222222-2222-4222-8222-222222222222",
      },
    );

    lock.release();
    assert.deepEqual(
      await readOwner().then(({ pid, schemaVersion, kind, serverId, serverMachineId }) => ({
        pid,
        schemaVersion,
        kind,
        serverId,
        serverMachineId,
      })),
      {
        pid: 0,
        schemaVersion: 2,
        kind: "managed_computer_runner",
        serverId: "11111111-1111-4111-8111-111111111111",
        serverMachineId: "22222222-2222-4222-8222-222222222222",
      },
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("daemon machine lock defaults to SLOCK_HOME machines directory", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-machine-lock-home-test-"));
  const oldSlockHome = process.env.SLOCK_HOME;

  try {
    process.env.SLOCK_HOME = rootDir;
    const lock = acquireDaemonMachineLock({
      apiKey: "sk_machine_test",
      serverUrl: "https://daemon.example.com",
    });

    assert.equal(resolveDefaultMachineStateRoot(), path.join(rootDir, "machines"));
    assert.equal(lock.machineDir, path.join(rootDir, "machines", getDaemonMachineLockId("sk_machine_test")));
    lock.release();
  } finally {
    if (oldSlockHome === undefined) {
      delete process.env.SLOCK_HOME;
    } else {
      process.env.SLOCK_HOME = oldSlockHome;
    }
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("daemon machine lock recovers stale lock directories", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-machine-lock-stale-test-"));

  try {
    const lockId = getDaemonMachineLockId("sk_machine_test");
    const lockDir = path.join(rootDir, lockId, "daemon.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: 0 }), "utf8");

    const lock = acquireDaemonMachineLock({
      apiKey: "sk_machine_test",
      serverUrl: "https://daemon.example.com",
      rootDir,
    });

    assert.equal(lock.lockDir, lockDir);
    lock.release();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("daemon machine lock does not remove recent incomplete lock directories", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "slock-machine-lock-incomplete-test-"));

  try {
    const lockId = getDaemonMachineLockId("sk_machine_test");
    const lockDir = path.join(rootDir, lockId, "daemon.lock");
    await mkdir(lockDir, { recursive: true });

    assert.throws(
      () => acquireDaemonMachineLock({ apiKey: "sk_machine_test", serverUrl: "https://daemon.example.com", rootDir }),
      /Another Slock daemon is already running/,
    );

    const info = await stat(lockDir);
    assert.ok(info.isDirectory(), "recent incomplete lock directory should remain for the owner to finish writing");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

const STALE_OWNER_PID = 10424;
const STALE_OWNER_STARTED_AT = "2026-10-28T05:35:31.074Z";

async function writeForeignOwner(rootDir: string, extra: Record<string, unknown> = {}): Promise<string> {
  const lockDir = path.join(rootDir, getDaemonMachineLockId("sk_machine_test"), "daemon.lock");
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    path.join(lockDir, "owner.json"),
    JSON.stringify({
      pid: STALE_OWNER_PID,
      token: "previous-owner",
      hostname: "DESKTOP-F431GV8",
      startedAt: STALE_OWNER_STARTED_AT,
      serverUrl: "https://daemon.example.com",
      apiKeyFingerprint: "e64f259009a007e0",
      schemaVersion: 2,
      kind: "managed_computer_runner",
      serverId: "11111111-1111-4111-8111-111111111111",
      serverMachineId: "22222222-2222-4222-8222-222222222222",
      ...extra,
    }),
    "utf8",
  );
  return lockDir;
}

function probe(options: { alive: boolean; startTimeMs?: number }): MachineLockProcessProbe & { startTimeReads: number[] } {
  const startTimeReads: number[] = [];
  return {
    startTimeReads,
    isAlive: (pid) => pid === STALE_OWNER_PID && options.alive,
    startTimeMs: (pid) => {
      startTimeReads.push(pid);
      return options.startTimeMs;
    },
  };
}

async function withRoot(name: string, fn: (rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), `slock-machine-lock-${name}-`));
  try {
    await fn(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("a lock whose live owner pid belongs to a process started after the lock was written is stale and reclaimed", async () => {
  await withRoot("reused-pid", async (rootDir) => {
    const lockDir = await writeForeignOwner(rootDir);
    // Windows reused pid 10424 for an unrelated program started two weeks later.
    const reused = probe({ alive: true, startTimeMs: Date.parse("2026-11-11T09:00:00.000Z") });

    const lock = acquireDaemonMachineLock({
      apiKey: "sk_machine_test",
      serverUrl: "https://daemon.example.com",
      rootDir,
      processProbe: reused,
    });

    assert.equal(lock.lockDir, lockDir);
    assert.deepEqual(reused.startTimeReads, [STALE_OWNER_PID]);
    assert.deepEqual(lock.reclaimed, { reason: "pid_reused", platform: process.platform, identitySource: "start_time" });
    const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as { pid: number };
    assert.equal(owner.pid, process.pid);
    lock.release();
  });
});

// Tenny's review of #14388: two daemons judging the same stale lock. B
// reclaims it while A is still reading the owner's start time; A must not
// then remove B's fresh lock. RED proof: drop the owner re-read before
// rmSync and both acquisitions succeed.
test("a stale lock reclaimed by another daemon while this one reads the owner's start time is not taken twice", async () => {
  await withRoot("reclaim-race", async (rootDir) => {
    const lockDir = await writeForeignOwner(rootDir);
    const reusedAt = Date.parse("2026-11-11T09:00:00.000Z");
    let lockB: ReturnType<typeof acquireDaemonMachineLock> | null = null;
    const probeA: MachineLockProcessProbe = {
      isAlive: (pid) => pid === STALE_OWNER_PID,
      startTimeMs: () => {
        // B's whole acquisition happens inside A's start-time read.
        lockB = acquireDaemonMachineLock({
          apiKey: "sk_machine_test",
          serverUrl: "https://daemon.example.com",
          rootDir,
          processProbe: probe({ alive: true, startTimeMs: reusedAt }),
        });
        return reusedAt;
      },
    };
    try {
      assert.throws(
        () => acquireDaemonMachineLock({ apiKey: "sk_machine_test", serverUrl: "https://daemon.example.com", rootDir, processProbe: probeA }),
        DaemonMachineLockConflictError,
      );
      assert.ok(lockB, "B reclaimed the stale lock");
      const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as { token: string };
      assert.ok(owner.token, "B's owner record is still in place");
    } finally {
      (lockB as ReturnType<typeof acquireDaemonMachineLock> | null)?.release();
    }
  });
});

test("a live owner that started at or before the lock's startedAt (within the tolerance) still holds the lock", async () => {
  for (const startTimeMs of [
    Date.parse(STALE_OWNER_STARTED_AT) - 2_000,
    Date.parse(STALE_OWNER_STARTED_AT),
    Date.parse(STALE_OWNER_STARTED_AT) + MACHINE_LOCK_PID_REUSE_TOLERANCE_MS,
  ]) {
    await withRoot("genuine-owner", async (rootDir) => {
      const lockDir = await writeForeignOwner(rootDir);
      assert.throws(
        () =>
          acquireDaemonMachineLock({
            apiKey: "sk_machine_test",
            serverUrl: "https://daemon.example.com",
            rootDir,
            processProbe: probe({ alive: true, startTimeMs }),
          }),
        (err: Error & { code?: string }) => {
          assert.equal(err.code, "DAEMON_MACHINE_LOCK_HELD");
          assert.equal(
            err.message,
            `Another Slock daemon is already running for this machine key (pid=${STALE_OWNER_PID}, startedAt=${STALE_OWNER_STARTED_AT}, host=DESKTOP-F431GV8, ownerStart=readable). ` +
              `Lock: ${lockDir}. Stop the existing daemon first, or use a different machine key/state directory.`,
          );
          return true;
        },
      );
      const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as { pid: number };
      assert.equal(owner.pid, STALE_OWNER_PID, "a genuine owner's lock is left untouched");
    });
  }
});

test("a live owner pid whose start time cannot be read still holds the lock (never reclaim on uncertainty)", async () => {
  await withRoot("unreadable-start", async (rootDir) => {
    await writeForeignOwner(rootDir);
    assert.throws(
      () =>
        acquireDaemonMachineLock({
          apiKey: "sk_machine_test",
          serverUrl: "https://daemon.example.com",
          rootDir,
          processProbe: probe({ alive: true, startTimeMs: undefined }),
        }),
      /Another Slock daemon is already running for this machine key \(pid=10424, .*ownerStart=unreadable\)/,
    );
  });
});

test("a dead owner pid is reclaimed without reading any start time", async () => {
  await withRoot("dead-owner", async (rootDir) => {
    const lockDir = await writeForeignOwner(rootDir);
    const dead = probe({ alive: false, startTimeMs: Date.parse(STALE_OWNER_STARTED_AT) });

    const lock = acquireDaemonMachineLock({
      apiKey: "sk_machine_test",
      serverUrl: "https://daemon.example.com",
      rootDir,
      processProbe: dead,
    });

    assert.equal(lock.lockDir, lockDir);
    assert.deepEqual(dead.startTimeReads, []);
    assert.deepEqual(lock.reclaimed, { reason: "owner_dead", platform: process.platform });
    lock.release();
  });
});

// A daemon records its own OS start identity in owner.json; a later daemon
// compares the owner pid's identity to it exactly.

const SELF_IDENTITY: ProcessStartIdentity = { platform: "win32", value: "1793696400123456" };
const OWNER_WIN: ProcessStartIdentity = { platform: "win32", value: "1793178931074000" };
const OWNER_LINUX: ProcessStartIdentity = { platform: "linux", value: "12345", bootId: "boot-a", pidNamespace: "pid:[4026531836]" };

function identityProbe(options: {
  alive?: boolean;
  self?: ProcessStartIdentity;
  owner?: ProcessStartIdentity;
  startTimeMs?: number;
}): MachineLockProcessProbe & { identityReads: number[] } {
  const identityReads: number[] = [];
  return {
    identityReads,
    isAlive: (pid) => pid === STALE_OWNER_PID && (options.alive ?? true),
    startTimeMs: () => options.startTimeMs,
    selfStartIdentitySync: () => {
      identityReads.push(process.pid);
      return options.self;
    },
    startIdentity: (pid) => {
      identityReads.push(pid);
      return options.owner;
    },
  };
}

function acquireWith(rootDir: string, processProbe: MachineLockProcessProbe) {
  return acquireDaemonMachineLock({ apiKey: "sk_machine_test", serverUrl: "https://daemon.example.com", rootDir, processProbe });
}

test("the lock owner records its own process start identity, additive to schemaVersion 2", async () => {
  await withRoot("records-identity", async (rootDir) => {
    const lockProbe = identityProbe({ self: SELF_IDENTITY });
    const lock = acquireWith(rootDir, lockProbe);
    const owner = JSON.parse(await readFile(path.join(lock.lockDir, "owner.json"), "utf8")) as Record<string, unknown>;
    assert.equal(owner.schemaVersion, 2);
    assert.equal(owner.kind, "legacy_raw_daemon");
    assert.deepEqual(owner.processStart, SELF_IDENTITY);
    // Read once, for this daemon: no lock existed, nothing else to judge.
    assert.deepEqual(lockProbe.identityReads, [process.pid]);
    assert.equal(lock.reclaimed, undefined);
    lock.release();
    const released = JSON.parse(await readFile(path.join(lock.lockDir, "owner.json"), "utf8")) as Record<string, unknown>;
    assert.equal(released.pid, 0);
    assert.deepEqual(released.processStart, SELF_IDENTITY);

    // A lock released cleanly is taken over, but it is no reclaim.
    const next = acquireWith(rootDir, identityProbe({ self: SELF_IDENTITY }));
    assert.equal(next.reclaimed, undefined);
    next.release();
  });
});

test("an unreadable own start identity is simply left out of owner.json", async () => {
  await withRoot("no-identity", async (rootDir) => {
    const lock = acquireWith(rootDir, identityProbe({ self: undefined }));
    const owner = JSON.parse(await readFile(path.join(lock.lockDir, "owner.json"), "utf8")) as Record<string, unknown>;
    assert.equal("processStart" in owner, false);
    assert.equal(owner.schemaVersion, 2);
    lock.release();
  });
});

test.skipIf(process.platform === "win32")("this host's real start identity is what owner.json records", async () => {
  await withRoot("real-identity", async (rootDir) => {
    const lock = acquireDaemonMachineLock({ apiKey: "sk_machine_test", serverUrl: "https://daemon.example.com", rootDir });
    // Off Linux the read spawns `ps` and lands after acquire returns.
    assert.equal(await lock.processStartRecorded, true);
    const owner = JSON.parse(await readFile(path.join(lock.lockDir, "owner.json"), "utf8")) as Record<string, unknown>;
    const expected = readProcessStartIdentitySync(process.pid);
    assert.ok(expected);
    assert.deepEqual(owner.processStart, expected);
    lock.release();
  });
});

test("a recorded owner identity equal to the pid's current one holds the lock, whatever the start time says", async () => {
  for (const recorded of [OWNER_WIN, OWNER_LINUX]) {
    await withRoot("identity-match", async (rootDir) => {
      const lockDir = await writeForeignOwner(rootDir, { processStart: recorded });
      // The clock-based check alone would call this pid reused.
      const lockProbe = identityProbe({ self: SELF_IDENTITY, owner: { ...recorded }, startTimeMs: Date.parse("2026-11-11T09:00:00.000Z") });
      assert.throws(
        () => acquireWith(rootDir, lockProbe),
        (err: DaemonMachineLockConflictError) => {
          assert.equal(err.code, "DAEMON_MACHINE_LOCK_HELD");
          assert.equal(err.ownerStartReadable, true);
          assert.match(err.message, /ownerStart=readable\)/);
          return true;
        },
      );
      assert.deepEqual(lockProbe.identityReads, [process.pid, STALE_OWNER_PID]);
      const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as { pid: number };
      assert.equal(owner.pid, STALE_OWNER_PID);
    });
  }
});

test("a recorded owner identity that differs from the pid's current one is a reused pid: reclaimed", async () => {
  const cases: Array<{ name: string; recorded: ProcessStartIdentity; current: ProcessStartIdentity }> = [
    { name: "windows creation time", recorded: OWNER_WIN, current: { platform: "win32", value: "1793178931074001" } },
    { name: "linux ticks", recorded: OWNER_LINUX, current: { ...OWNER_LINUX, value: "12346" } },
    // Same ticks after a reboot: a different process all the same.
    { name: "linux boot id", recorded: OWNER_LINUX, current: { ...OWNER_LINUX, bootId: "boot-b" } },
    { name: "darwin lstart", recorded: { platform: "darwin", value: "1793178931000" }, current: { platform: "darwin", value: "1793696400000" } },
  ];
  for (const { name, recorded, current } of cases) {
    await withRoot("identity-mismatch", async (rootDir) => {
      const lockDir = await writeForeignOwner(rootDir, { processStart: recorded });
      // The clock-based check alone would keep it held.
      const lock = acquireWith(rootDir, identityProbe({ self: SELF_IDENTITY, owner: current, startTimeMs: Date.parse(STALE_OWNER_STARTED_AT) }));
      assert.equal(lock.lockDir, lockDir, name);
      assert.deepEqual(lock.reclaimed, { reason: "pid_reused", platform: process.platform, identitySource: "recorded" }, name);
      const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as { pid: number; processStart?: unknown };
      assert.equal(owner.pid, process.pid, name);
      assert.deepEqual(owner.processStart, SELF_IDENTITY, name);
      lock.release();
    });
  }
});

test("a recorded owner identity that cannot be compared now keeps the lock held (never reclaim on uncertainty)", async () => {
  const cases: Array<{ name: string; recorded: ProcessStartIdentity; current: ProcessStartIdentity | undefined }> = [
    { name: "unreadable now", recorded: OWNER_WIN, current: undefined },
    { name: "other pid namespace", recorded: OWNER_LINUX, current: { ...OWNER_LINUX, value: "99", pidNamespace: "pid:[4026532000]" } },
    { name: "namespace unknown now", recorded: OWNER_LINUX, current: { platform: "linux", value: "99", bootId: "boot-a" } },
    // Tenny's review of #14393: the same live owner read from another time
    // namespace (unshare --time) has shifted ticks; it must not look reused.
    { name: "other time namespace", recorded: { ...OWNER_LINUX, timeNamespace: "time:[4026531834]" }, current: { ...OWNER_LINUX, value: "112345", timeNamespace: "time:[4026532100]" } },
    { name: "time namespace unknown now", recorded: { ...OWNER_LINUX, timeNamespace: "time:[4026531834]" }, current: { ...OWNER_LINUX, value: "99" } },
    { name: "other platform", recorded: OWNER_WIN, current: { platform: "darwin", value: "1" } },
  ];
  for (const { name, recorded, current } of cases) {
    await withRoot("identity-uncertain", async (rootDir) => {
      await writeForeignOwner(rootDir, { processStart: recorded });
      assert.throws(
        () => acquireWith(rootDir, identityProbe({ self: SELF_IDENTITY, owner: current, startTimeMs: Date.parse("2026-11-11T09:00:00.000Z") })),
        (err: DaemonMachineLockConflictError) => {
          assert.equal(err.ownerStartReadable, false, name);
          assert.match(err.message, /ownerStart=unreadable\)/, name);
          return true;
        },
        name,
      );
    });
  }
});

test("a malformed recorded identity falls back to the start-time check", async () => {
  await withRoot("identity-malformed", async (rootDir) => {
    await writeForeignOwner(rootDir, { processStart: { platform: "linux", value: "12345" } });
    const lock = acquireWith(rootDir, identityProbe({ self: SELF_IDENTITY, owner: OWNER_LINUX, startTimeMs: Date.parse("2026-11-11T09:00:00.000Z") }));
    assert.deepEqual(lock.reclaimed, { reason: "pid_reused", platform: process.platform, identitySource: "start_time" });
    lock.release();
  });
});

test("an incomplete lock left long enough is reclaimed as incomplete", async () => {
  await withRoot("incomplete-old", async (rootDir) => {
    const lockDir = path.join(rootDir, getDaemonMachineLockId("sk_machine_test"), "daemon.lock");
    await mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(lockDir, old, old);
    const lock = acquireWith(rootDir, identityProbe({ self: SELF_IDENTITY }));
    assert.deepEqual(lock.reclaimed, { reason: "incomplete", platform: process.platform });
    lock.release();
  });
});

// Where reading the own identity spawns a process (Windows PowerShell, `ps`),
// it never runs on the startup path: the lock is taken without it and the
// identity is added once read, only while the lock is still ours.

function deferredSelfProbe(): MachineLockProcessProbe & {
  asyncReads: number;
  resolve: (identity: ProcessStartIdentity | undefined) => void;
  reject: (err: Error) => void;
} {
  let settle!: { resolve: (identity: ProcessStartIdentity | undefined) => void; reject: (err: Error) => void };
  const pending = new Promise<ProcessStartIdentity | undefined>((resolve, reject) => { settle = { resolve, reject }; });
  const probeState = {
    asyncReads: 0,
    isAlive: () => false,
    startTimeMs: () => undefined,
    selfStartIdentitySync: () => undefined,
    startIdentity: () => { throw new Error("no owner to judge"); },
    selfStartIdentityAsync: () => {
      probeState.asyncReads += 1;
      return pending;
    },
    resolve: (identity: ProcessStartIdentity | undefined) => settle.resolve(identity),
    reject: (err: Error) => settle.reject(err),
  };
  return probeState;
}

async function readOwnerJson(lockDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as Record<string, unknown>;
}

test("a spawned own-identity read never blocks acquire: owner.json gets processStart once it resolves", async () => {
  await withRoot("async-identity", async (rootDir) => {
    const selfProbe = deferredSelfProbe();
    const lock = acquireWith(rootDir, selfProbe);
    // Acquire returned with the read still pending: no processStart yet.
    assert.equal(selfProbe.asyncReads, 1);
    const before = await readOwnerJson(lock.lockDir);
    assert.equal("processStart" in before, false);

    selfProbe.resolve(SELF_IDENTITY);
    assert.equal(await lock.processStartRecorded, true);
    const after = await readOwnerJson(lock.lockDir);
    assert.deepEqual(after.processStart, SELF_IDENTITY);
    assert.deepEqual({ ...after, processStart: undefined }, { ...before, processStart: undefined });
    assert.deepEqual((await readdir(lock.lockDir)).sort(), ["owner.json"], "no temp file left");

    // release still matches token and pid and keeps the identity.
    lock.release();
    const released = await readOwnerJson(lock.lockDir);
    assert.equal(released.pid, 0);
    assert.deepEqual(released.processStart, SELF_IDENTITY);
  });
});

test("an own identity that resolves after the lock changed hands (or was released) leaves owner.json untouched", async () => {
  await withRoot("async-identity-stale", async (rootDir) => {
    const selfProbe = deferredSelfProbe();
    const lock = acquireWith(rootDir, selfProbe);
    const ownerFile = path.join(lock.lockDir, "owner.json");
    const other = { ...(await readOwnerJson(lock.lockDir)), token: "another-owner" };
    await writeFile(ownerFile, JSON.stringify(other));
    selfProbe.resolve(SELF_IDENTITY);
    assert.equal(await lock.processStartRecorded, false);
    assert.equal(await readFile(ownerFile, "utf8"), JSON.stringify(other));
  });
  await withRoot("async-identity-released", async (rootDir) => {
    const selfProbe = deferredSelfProbe();
    const lock = acquireWith(rootDir, selfProbe);
    lock.release();
    const released = await readFile(path.join(lock.lockDir, "owner.json"), "utf8");
    selfProbe.resolve(SELF_IDENTITY);
    assert.equal(await lock.processStartRecorded, false);
    assert.equal(await readFile(path.join(lock.lockDir, "owner.json"), "utf8"), released);
  });
});

test("a failing or unreadable own-identity read is swallowed and leaves owner.json as acquired", async () => {
  for (const fail of [(p: ReturnType<typeof deferredSelfProbe>) => p.reject(new Error("powershell timed out")), (p: ReturnType<typeof deferredSelfProbe>) => p.resolve(undefined)]) {
    await withRoot("async-identity-fails", async (rootDir) => {
      const selfProbe = deferredSelfProbe();
      const lock = acquireWith(rootDir, selfProbe);
      const before = await readFile(path.join(lock.lockDir, "owner.json"), "utf8");
      fail(selfProbe);
      assert.equal(await lock.processStartRecorded, false);
      assert.equal(await readFile(path.join(lock.lockDir, "owner.json"), "utf8"), before);
      lock.release();
    });
  }
});

test("an own identity read without spawning (Linux) is written with the lock and no async read starts", async () => {
  await withRoot("sync-identity", async (rootDir) => {
    const selfProbe = { ...deferredSelfProbe(), selfStartIdentitySync: () => SELF_IDENTITY };
    let asyncReads = 0;
    selfProbe.selfStartIdentityAsync = () => { asyncReads += 1; return Promise.resolve(undefined); };
    const lock = acquireWith(rootDir, selfProbe);
    assert.deepEqual((await readOwnerJson(lock.lockDir)).processStart, SELF_IDENTITY);
    assert.equal(await lock.processStartRecorded, true);
    assert.equal(asyncReads, 0);
    lock.release();
  });
});
