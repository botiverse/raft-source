import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { acquireDaemonMachineLock, getDaemonMachineLockId, resolveDefaultMachineStateRoot } from "./machineLock.js";

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
