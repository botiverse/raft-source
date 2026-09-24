// kHostAdapter contract tests (#wg-k task #2, fork-A).
//
// Everything runs through the deps seam — no real service, no real spawn.
// The teeth mirror the K-side contract:
//   - probe evidence is answered by the live socket, one incarnation
//   - quiesce fail-closes on an incomplete identity snapshot
//   - the exact parked set survives a driver crash and binds successor resume
//   - resume is version-agnostic (must pass after rollback) and diverges
//     loudly when the successor serves a different managed set
//   - start() waits for reachability; healthProbe alone judges correctness
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createKHostAdapter,
  kParkedSnapshotPath,
  kRunnerHoldPath,
  kSlotBinaryPath,
  kStateDir,
  type KHostAdapterDeps,
} from "./kHostAdapter.js";
import { refreshHostLifecycleWithinDeadline } from "./kHostLifecycleRefresh.js";
import { ComputerServiceError } from "./services/errors.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const HOME = "/tmp/slock-k-test-home";

interface FakeAttestation {
  computerVersion: string;
  serviceGeneration: string;
  servicePid: number;
  managedServerIds: string[];
  managedMachineIdentities?: Record<string, string>;
  managedSetRevision: string;
}

function fakeConnect(
  sequence: Array<FakeAttestation | Error>,
  log: { closed: number } = { closed: 0 },
): KHostAdapterDeps["connectServiceFn"] {
  let call = 0;
  // Only the two methods the adapter uses are faked; the cast documents that.
  return (async () => {
    const step = sequence[Math.min(call, sequence.length - 1)];
    call += 1;
    if (step instanceof Error) throw step;
    return {
      request: async (method: string) => {
        assert.equal(method, "machine-attestation");
        return step;
      },
      close: async () => {
        log.closed += 1;
      },
    } as unknown as Awaited<ReturnType<NonNullable<KHostAdapterDeps["connectServiceFn"]>>>;
  }) as KHostAdapterDeps["connectServiceFn"];
}

function manualClock(): { deps: Pick<KHostAdapterDeps, "now" | "sleep">; advanceOnSleep: (ms: number) => void } {
  let t = 0;
  let step = 0;
  return {
    deps: {
      now: () => t,
      sleep: async (ms: number) => {
        t += step > 0 ? step : ms;
      },
    },
    advanceOnSleep: (ms: number) => {
      step = ms;
    },
  };
}

function memoryParkStore(initial: string | null = null): {
  deps: Pick<KHostAdapterDeps, "readTextFileFn" | "writeDurableTextFileFn" | "removeFileFn">;
  read(): string | null;
  has(path: string): boolean;
} {
  const values = new Map<string, string>();
  if (initial !== null) values.set(kParkedSnapshotPath(HOME), initial);
  return {
    deps: {
      readTextFileFn: async (filePath) => {
        const value = values.get(filePath);
        if (value !== undefined) return value;
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      writeDurableTextFileFn: async (filePath, next) => {
        values.set(filePath, next);
      },
      removeFileFn: async (filePath) => { values.delete(filePath); },
    },
    read: () => values.get(kParkedSnapshotPath(HOME)) ?? null,
    has: (filePath) => values.has(filePath),
  };
}

const ATT: FakeAttestation = {
  computerVersion: "1.0.16",
  serviceGeneration: "gen-aaaa",
  servicePid: 4242,
  managedServerIds: ["srv-a", "srv-b"],
  managedMachineIdentities: { "srv-a": "mid-a", "srv-b": "mid-b" },
  managedSetRevision: "7",
};

test("healthProbe maps live attestation to one-incarnation evidence and closes the socket", async () => {
  const log = { closed: 0 };
  const adapter = createKHostAdapter(HOME, { connectServiceFn: fakeConnect([ATT], log) });
  const evidence = await adapter.healthProbe();
  assert.deepEqual(evidence, { version: "1.0.16", pid: 4242, startId: "gen-aaaa" });
  assert.equal(log.closed, 1, "the probe socket must be closed");
});

test("healthProbe never caches: a restart (incl. rollback) yields a NEW startId on the next probe", async () => {
  // The discriminator lancer asked for (#wg-k:dcb90856 5c979b1b): an adapter
  // that memoized evidence would satisfy every other tooth here. Two probes
  // around a restart must each come from the live socket of THAT moment —
  // same managed world, different incarnation, different startId.
  const adapter = createKHostAdapter(HOME, {
    connectServiceFn: fakeConnect([
      ATT,
      { ...ATT, computerVersion: "0.9.9", serviceGeneration: "gen-bbbb", servicePid: 5151 },
    ]),
  });
  const before = await adapter.healthProbe();
  const after = await adapter.healthProbe(); // service restarted (rolled back) in between
  assert.equal(before.startId, "gen-aaaa");
  assert.equal(after.startId, "gen-bbbb");
  assert.notEqual(before.startId, after.startId, "a new incarnation must present a new startId");
  assert.notEqual(before.pid, after.pid);
});

test("healthProbe refuses to answer from anything but a live socket", async () => {
  const adapter = createKHostAdapter(HOME, {
    connectServiceFn: fakeConnect([new Error("ECONNREFUSED")]),
  });
  await assert.rejects(adapter.healthProbe(), (err: unknown) => {
    assert.ok(err instanceof ComputerServiceError);
    assert.equal(err.code, "K_HOST_PROBE_UNAVAILABLE");
    return true;
  });
});

test("quiesce durably pins a canonical complete managed snapshot and is idempotent", async () => {
  const store = memoryParkStore();
  const writes: Array<{ path: string; value: string }> = [];
  const adapter = createKHostAdapter(HOME, {
    listManagedServerIdsFn: async () => ["srv-b", "srv-a"],
    // Reverse insertion order too: the durable bytes must still be canonical.
    readManagedMachineIdentitiesFn: async () => ({ "srv-b": "mid-b", "srv-a": "mid-a" }),
    ...store.deps,
    writeDurableTextFileFn: async (filePath, value) => {
      writes.push({ path: filePath, value });
      await store.deps.writeDurableTextFileFn!(filePath, value);
    },
  });
  await adapter.quiesce();
  await adapter.quiesce(); // idempotent
  const expected = `${JSON.stringify({
    formatVersion: 1,
    managedServerIds: ["srv-a", "srv-b"],
    managedMachineIdentities: { "srv-a": "mid-a", "srv-b": "mid-b" },
  })}\n`;
  const hold = `${JSON.stringify({ formatVersion: 1, held: true })}\n`;
  assert.deepEqual(writes, [
    { path: kParkedSnapshotPath(HOME), value: expected },
    { path: kRunnerHoldPath(HOME), value: hold },
    { path: kParkedSnapshotPath(HOME), value: expected },
    { path: kRunnerHoldPath(HOME), value: hold },
  ]);
  assert.equal(store.read(), expected);
  assert.equal(store.has(kRunnerHoldPath(HOME)), true);
});

test("quiesce fail-closes on an incomplete identity snapshot", async () => {
  const adapter = createKHostAdapter(HOME, {
    listManagedServerIdsFn: async () => ["srv-a", "srv-b"],
    readManagedMachineIdentitiesFn: async () => ({ "srv-a": "mid-a" }), // srv-b missing
  });
  await assert.rejects(adapter.quiesce(), (err: unknown) => {
    assert.ok(err instanceof ComputerServiceError);
    assert.equal(err.code, "K_HOST_QUIESCE_INCOMPLETE");
    return true;
  });
});

test("quiesce fails before handoff when the exact park snapshot is not durable", async () => {
  const adapter = createKHostAdapter(HOME, {
    listManagedServerIdsFn: async () => ["srv-a"],
    readManagedMachineIdentitiesFn: async () => ({ "srv-a": "mid-a" }),
    writeDurableTextFileFn: async () => {
      throw new Error("disk full");
    },
  });
  await assert.rejects(adapter.quiesce(), (err: unknown) => {
    assert.ok(err instanceof ComputerServiceError);
    assert.equal(err.code, "K_HOST_PARK_PERSIST_FAILED");
    return true;
  });
});

test("resume passes when the successor serves the parked set — INCLUDING after rollback", async () => {
  const clock = manualClock();
  const store = memoryParkStore();
  const adapter = createKHostAdapter(HOME, {
    listManagedServerIdsFn: async () => ["srv-a", "srv-b"],
    readManagedMachineIdentitiesFn: async () => ({ "srv-a": "mid-a", "srv-b": "mid-b" }),
    // Rolled-back binary: OLDER version, NEW incarnation, same managed set.
    connectServiceFn: fakeConnect([
      new Error("not up yet"),
      { ...ATT, computerVersion: "0.9.9", serviceGeneration: "gen-bbbb" },
    ]),
    ...store.deps,
    ...clock.deps,
  });
  await adapter.quiesce();
  assert.equal(store.has(kRunnerHoldPath(HOME)), true);
  await adapter.resume(); // version difference must NOT fail the gate
  assert.equal(store.has(kRunnerHoldPath(HOME)), false);
});

test("upgrade resume re-verifies the one enabled CLI login carrier without changing owner", async () => {
  const store = memoryParkStore();
  const convergences: string[] = [];
  const adapter = createKHostAdapter(HOME, {
    connectServiceFn: fakeConnect([ATT, ATT]),
    listManagedServerIdsFn: async () => ATT.managedServerIds,
    readManagedMachineIdentitiesFn: async () => ATT.managedMachineIdentities!,
    ...store.deps,
    resolveSlotBinaryFn: () => process.execPath,
    spawnSlotServiceFn: async () => process.pid,
    isProcessAliveFn: () => true,
    now: () => 0,
    refreshHostLifecycleFn: async (home, deadlineAtMs, refreshDeps) => {
      assert.equal(home, HOME);
      assert.equal(deadlineAtMs, 30_000);
      assert.equal(refreshDeps?.now?.(), 0);
      convergences.push("enabled");
    },
  });
  await adapter.quiesce();
  await adapter.start("experiment");
  await adapter.resume();
  assert.deepEqual(convergences, ["enabled"]);
});

test("login-carrier refresh aborts inside the remaining shared deadline", async () => {
  let scheduledMs: number | null = null;
  let lateMutation = false;
  let aborted = false;
  await assert.rejects(refreshHostLifecycleWithinDeadline(HOME, 25, {
    now: () => 20,
    setTimeoutFn: (fn, ms) => {
      scheduledMs = ms;
      queueMicrotask(fn);
      return Symbol("refresh-deadline");
    },
    clearTimeoutFn: () => undefined,
    refreshFn: async (_home, hostDeps) =>
      new Promise<void>((resolve, reject) => {
        const signal = hostDeps!.signal!;
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
        queueMicrotask(() => {
          if (!signal.aborted) lateMutation = true;
          resolve();
        });
      }),
  }), (error: unknown) => {
    assert.ok(error instanceof ComputerServiceError);
    assert.equal(error.code, "K_HOST_RESUME_REFRESH_TIMEOUT");
    return true;
  });
  await Promise.resolve();
  assert.equal(scheduledMs, 5, "refresh must receive only the attestation deadline remainder");
  assert.equal(aborted, true, "deadline must abort the actual refresh seam");
  assert.equal(lateMutation, false, "timeout must prevent late refresh mutation");
});

test("resume diverges loudly when the successor serves a different managed set", async () => {
  const clock = manualClock();
  clock.advanceOnSleep(10_000);
  const store = memoryParkStore();
  const adapter = createKHostAdapter(HOME, {
    listManagedServerIdsFn: async () => ["srv-a", "srv-b"],
    readManagedMachineIdentitiesFn: async () => ({ "srv-a": "mid-a", "srv-b": "mid-b" }),
    connectServiceFn: fakeConnect([
      { ...ATT, managedServerIds: ["srv-a"], managedMachineIdentities: { "srv-a": "mid-a" } },
    ]),
    ...store.deps,
    ...clock.deps,
  });
  await adapter.quiesce();
  await assert.rejects(adapter.resume(), (err: unknown) => {
    assert.ok(err instanceof ComputerServiceError);
    assert.equal(err.code, "K_HOST_RESUME_DIVERGED");
    return true;
  });
});

test("resume times out with the unreachable code when no service ever answers", async () => {
  const clock = manualClock();
  clock.advanceOnSleep(10_000);
  const store = memoryParkStore();
  const adapter = createKHostAdapter(HOME, {
    connectServiceFn: fakeConnect([new Error("ECONNREFUSED")]),
    listManagedServerIdsFn: async () => ["srv-a"],
    readManagedMachineIdentitiesFn: async () => ({ "srv-a": "mid-a" }),
    ...store.deps,
    ...clock.deps,
  });
  await adapter.quiesce();
  await assert.rejects(adapter.resume(), (err: unknown) => {
    assert.ok(err instanceof ComputerServiceError);
    assert.equal(err.code, "K_HOST_RESUME_TIMEOUT");
    return true;
  });
});

test("a fresh successor driver reloads the exact durable park set", async () => {
  const store = memoryParkStore();
  const first = createKHostAdapter(HOME, {
    listManagedServerIdsFn: async () => ["srv-b", "srv-a"],
    readManagedMachineIdentitiesFn: async () => ({ "srv-a": "mid-a", "srv-b": "mid-b" }),
    ...store.deps,
  });
  await first.quiesce();

  // New adapter instance = driver crashed/restarted; the in-memory park is gone.
  const clock = manualClock();
  const successor = createKHostAdapter(HOME, {
    connectServiceFn: fakeConnect([ATT]),
    ...store.deps,
    ...clock.deps,
  });
  await successor.resume();
});

test("a fresh successor rejects a complete live set that differs from the durable park", async () => {
  const store = memoryParkStore();
  const first = createKHostAdapter(HOME, {
    listManagedServerIdsFn: async () => ["srv-a", "srv-b"],
    readManagedMachineIdentitiesFn: async () => ({ "srv-a": "mid-a", "srv-b": "mid-b" }),
    ...store.deps,
  });
  await first.quiesce();

  const clock = manualClock();
  clock.advanceOnSleep(10_000);
  const successor = createKHostAdapter(HOME, {
    connectServiceFn: fakeConnect([
      {
        ...ATT,
        managedServerIds: ["srv-a", "srv-c"],
        managedMachineIdentities: { "srv-a": "mid-a", "srv-c": "mid-c" },
      },
    ]),
    ...store.deps,
    ...clock.deps,
  });
  await assert.rejects(successor.resume(), (err: unknown) => {
    assert.ok(err instanceof ComputerServiceError);
    assert.equal(err.code, "K_HOST_RESUME_DIVERGED");
    return true;
  });
});

test("a fresh successor fails closed when the exact durable park is missing or malformed", async () => {
  for (const initial of [null, "not-json\n", `${JSON.stringify({ formatVersion: 2 })}\n`]) {
    const store = memoryParkStore(initial);
    const successor = createKHostAdapter(HOME, {
      connectServiceFn: fakeConnect([ATT]),
      ...store.deps,
    });
    await assert.rejects(successor.resume(), (err: unknown) => {
      assert.ok(err instanceof ComputerServiceError);
      assert.equal(err.code, "K_HOST_PARK_SNAPSHOT_UNAVAILABLE");
      return true;
    });
  }
});

test("stop delegates to the graceful StopService path", async () => {
  const calls: string[] = [];
  const adapter = createKHostAdapter(HOME, {
    stopServiceFn: (async (input: { slockHome: string }) => {
      calls.push(input.slockHome);
      return { status: "not_running", pid: null };
    }) as unknown as KHostAdapterDeps["stopServiceFn"],
  });
  await adapter.stop("stable");
  assert.deepEqual(calls, [HOME], "stop must target this install root and tolerate not_running");
});

test("start spawns the SLOT's binary and waits until the service ANSWERS the socket", async () => {
  // K's engine probes ONCE right after start() returns — a start that
  // returns at spawn loses the boot race and the seed upgrade rolls back
  // (found live by the k-harness service-tier acceptance).
  const home = await mkdtemp(join(tmpdir(), "k-adapter-"));
  try {
    const binary = kSlotBinaryPath(home, "experiment");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
    const spawned: string[] = [];
    const clock = manualClock();
    const adapter = createKHostAdapter(home, {
      spawnSlotServiceFn: async (_home, binaryPath) => {
        spawned.push(binaryPath);
        return 777;
      },
      // Booting service: refuses twice, then answers.
      connectServiceFn: fakeConnect([new Error("booting"), new Error("booting"), ATT]),
      isProcessAliveFn: () => true,
      ...clock.deps,
    });
    await adapter.start("experiment");
    assert.deepEqual(spawned, [binary]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("crash-on-start: start returns QUIETLY and the probe delivers the verdict", async () => {
  // K's engine turns a probe failure into the tidy rollback ("experiment
  // probe failed"); a start() that throws instead crashes the transaction
  // out of that path. The probe is the sole judge.
  const home = await mkdtemp(join(tmpdir(), "k-adapter-"));
  try {
    const binary = kSlotBinaryPath(home, "stable");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
    const clock = manualClock();
    const adapter = createKHostAdapter(home, {
      spawnSlotServiceFn: async () => 888,
      connectServiceFn: fakeConnect([new Error("never answers")]),
      isProcessAliveFn: () => false, // crash-on-start: child already gone
      ...clock.deps,
    });
    await adapter.start("stable"); // must NOT throw
    await assert.rejects(adapter.healthProbe(), (err: unknown) => {
      assert.ok(err instanceof ComputerServiceError);
      assert.equal(err.code, "K_HOST_PROBE_UNAVAILABLE");
      return true;
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a wedged (alive, never answering) service: start returns quietly after the deadline", async () => {
  const home = await mkdtemp(join(tmpdir(), "k-adapter-"));
  try {
    const binary = kSlotBinaryPath(home, "stable");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
    const clock = manualClock();
    clock.advanceOnSleep(60_000);
    const adapter = createKHostAdapter(home, {
      spawnSlotServiceFn: async () => 999,
      connectServiceFn: fakeConnect([new Error("wedged")]),
      isProcessAliveFn: () => true,
      ...clock.deps,
    });
    await adapter.start("stable"); // deadline passes; quiet return
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an EMPTY slot: start returns quietly without spawning (fresh-world rollback path)", async () => {
  // rollback's start("stable") on a world where nothing was ever installed
  // must complete quietly — rolled-back-with-nothing-running is that
  // world's honest end state; the probe is what refuses afterwards.
  const home = await mkdtemp(join(tmpdir(), "k-adapter-"));
  try {
    let spawned = 0;
    const adapter = createKHostAdapter(home, {
      spawnSlotServiceFn: async () => {
        spawned += 1;
        return null;
      },
      connectServiceFn: fakeConnect([new Error("nothing running")]),
    });
    await adapter.start("stable"); // must NOT throw
    assert.equal(spawned, 0, "an empty slot must not be spawned");
    await assert.rejects(adapter.healthProbe(), (err: unknown) => {
      assert.ok(err instanceof ComputerServiceError);
      assert.equal(err.code, "K_HOST_PROBE_UNAVAILABLE");
      return true;
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resume after a SILENT start is a quiet no-op (fresh-world rollback end state)", async () => {
  // K's rollback calls start("stable") then resume(). On a world where
  // nothing was ever installed, start is silent — resume must not wait for
  // a successor that can never exist (the parked set stays durably parked).
  const home = await mkdtemp(join(tmpdir(), "k-adapter-"));
  try {
    const clock = manualClock();
    const store = memoryParkStore();
    const adapter = createKHostAdapter(home, {
      connectServiceFn: fakeConnect([new Error("nothing running")]),
      listManagedServerIdsFn: async () => ["srv-a"],
      readManagedMachineIdentitiesFn: async () => ({ "srv-a": "mid-a" }),
      spawnSlotServiceFn: async () => null,
      ...store.deps,
      ...clock.deps,
    });
    await adapter.quiesce();
    await adapter.start("stable"); // empty slot → silent
    await adapter.resume(); // must return quietly, not K_HOST_RESUME_TIMEOUT
    assert.equal(store.has(kRunnerHoldPath(home)), true, "silent rollback keeps runners durably held");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("K slot layout mirrors k-carrier's slotArtifactPath under the computer dir", () => {
  assert.equal(kStateDir("/x"), join("/x", "computer", "k"));
  // Byte-pinned to K's fileEffects layout: <stateDir>/slots/<slot>/artifact.bin.
  // K's engine stages there and start(slot) must launch exactly that file —
  // an invented filename means K_HOST_SLOT_BINARY_MISSING on every real
  // transaction.
  assert.equal(
    kSlotBinaryPath("/x", "stable"),
    join("/x", "computer", "k", "slots", "stable", "artifact.bin"),
  );
  assert.equal(
    kSlotBinaryPath("/x", "experiment"),
    join("/x", "computer", "k", "slots", "experiment", "artifact.bin"),
  );
  assert.equal(kRunnerHoldPath("/x"), join("/x", "computer", "k", "host-runner-hold.json"));
});
