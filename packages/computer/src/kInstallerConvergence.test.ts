import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "vitest";
import type {
  OperationRead,
  OperationRecord,
  ReleaseSource,
  Upgrader,
  UpgradeOutcome,
} from "@botiverse/k-carrier";

import {
  convergeKInitializedInstaller,
  type KInstallerHostAdapter,
  type KInstallerServiceState,
} from "./kInstallerConvergence.js";

const SHA = "a".repeat(64);
const TARGET = "1.0.18";

function terminalOperation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    formatVersion: 1,
    id: "old-operation",
    startedAtMs: 1,
    updatedAtMs: 2,
    fromVersion: "1.0.17",
    targetVersion: TARGET,
    previousStableVersion: "1.0.17",
    phase: "promoted",
    outcome: "promoted",
    reason: null,
    provenance: { who: "local", carrier: "installer" },
    metadata: {},
    acknowledgedAtMs: 3,
    ...overrides,
  };
}

interface FakeOptions {
  operation?: OperationRead;
  stableVersion?: string;
  phase?: "idle" | "promoted" | "rolled-back" | "staged";
  receiptMutation?: (record: OperationRecord) => OperationRecord;
  outcome?: UpgradeOutcome;
  upgradeErrorAfterReceipt?: Error;
  quarantineError?: Error;
}

function fixture(options: FakeOptions = {}) {
  let operation: OperationRead = options.operation ?? {
    kind: "observed",
    operation: terminalOperation(),
  };
  let stableVersion = options.stableVersion ?? "1.0.17";
  let phase = options.phase ?? "promoted";
  const upgradeCalls: Array<{ version: string; opts: Parameters<Upgrader["upgradeTo"]>[1] }> = [];
  const hostCalls: string[] = [];
  const acknowledgements: string[] = [];
  const quarantineCalls: Array<{ destination: string; timestampMs: number }> = [];
  const sourceReads: string[] = [];
  const upgraderSources: ReleaseSource[] = [];
  const serviceStates: KInstallerServiceState[] = [];
  const bootstraps: string[] = [];
  const host: KInstallerHostAdapter = {
    quiesce: async () => { hostCalls.push("quiesce"); },
    stop: async (slot) => { hostCalls.push(`stop:${slot}`); },
    start: async (slot) => { hostCalls.push(`start:${slot}`); },
    resume: async () => { hostCalls.push("resume"); },
    healthProbe: async () => ({ version: TARGET, pid: 123, startId: "live-target" }),
  };
  const source: ReleaseSource = {
    checkForUpdate: async () => null,
    fetchRelease: async (version) => {
      sourceReads.push(version);
      return { version: TARGET, url: "http://127.0.0.1/exact", sha256: SHA, size: 123 };
    },
  };
  const upgrader: Upgrader = {
    recover: async () => {},
    check: async () => ({ current: stableVersion, target: TARGET }),
    upgrade: async () => ({ result: "up-to-date" }),
    upgradeTo: async (version, opts) => {
      upgradeCalls.push({ version, opts });
      await source.fetchRelease(version, { currentVersion: stableVersion, platformKey: "test" });
      const outcome = options.outcome ?? {
        result: "promoted" as const,
        report: {
          version,
          binaryAtTarget: { passed: true, source: "live" as const, observedAtMs: 4, detail: {} },
          hostLifecycleConverged: null,
        },
      };
      stableVersion = outcome.result === "promoted" || outcome.result === "up-to-date"
        ? version
        : stableVersion;
      phase = outcome.result === "rolled-back" ? "rolled-back" : "promoted";
      const receipt = terminalOperation({
        id: opts?.operation?.id ?? "missing",
        targetVersion: version,
        outcome: outcome.result === "up-to-date" ? "up-to-date" : outcome.result,
        phase: outcome.result === "up-to-date" ? "up-to-date" : outcome.result,
        provenance: opts?.provenance ?? null,
        metadata: opts?.operation?.metadata ?? {},
        acknowledgedAtMs: null,
      });
      operation = {
        kind: "observed",
        operation: options.receiptMutation?.(receipt) ?? receipt,
      };
      if (options.upgradeErrorAfterReceipt) throw options.upgradeErrorAfterReceipt;
      return outcome;
    },
    rollback: async () => "rolled-back",
    retireLegacyManager: async () => "retired",
    state: async () => {
      if (phase === "staged") {
        return {
          phase,
          stableVersion,
          experimentVersion: TARGET,
          rollbackReason: null,
        };
      }
      return {
        phase,
        stableVersion,
        experimentVersion: null,
        rollbackReason: null,
      };
    },
    status: async () => ({
      phase: "idle",
      stable: stableVersion,
      experiment: null,
      predicates: { kind: "genesis" },
      policy: "confirm",
      provenance: null,
    }),
    operation: async () => operation,
    acknowledgeOperation: async (id) => {
      acknowledgements.push(id);
      if (operation.kind === "observed" && operation.operation.id === id) {
        operation = {
          kind: "observed",
          operation: { ...operation.operation, acknowledgedAtMs: 5 },
        };
        return "acknowledged";
      }
      return "changed";
    },
    quarantineState: async (opts) => {
      if (options.quarantineError) throw options.quarantineError;
      quarantineCalls.push({ destination: opts.destination, timestampMs: opts.timestampMs });
      hostCalls.push("quarantine");
      operation = { kind: "genesis" };
      stableVersion = TARGET;
      phase = "promoted";
      return {
        status: "quarantined",
        sourcePath: "/home/computer/k",
        quarantinePath: opts.destination,
        operationId: "old-operation",
        timestampMs: opts.timestampMs,
      };
    },
  };
  return {
    upgrader,
    upgradeCalls,
    acknowledgements,
    quarantineCalls,
    source,
    sourceReads,
    upgraderSources,
    host,
    hostCalls,
    serviceStates,
    bootstraps,
  };
}

/**
 * A resident service whose attestation answer depends on whether the
 * installer has restarted it onto stable yet: `before` until `start:stable`
 * is driven, `after` from then on. `null` = no service answers the probe.
 */
function residentService(
  f: ReturnType<typeof fixture>,
  before: string | null,
  after: string | null,
  livePid: number | null = before === null ? null : 4242,
) {
  return {
    healthProbeFn: async () => {
      const restarted = f.hostCalls.includes("start:stable");
      const version = restarted ? after : before;
      if (version === null) throw new Error("K_HOST_PROBE_UNAVAILABLE: no live service answered the attestation probe");
      return { version, pid: restarted ? 9001 : (livePid ?? 4242), startId: restarted ? "successor" : "resident" };
    },
    findLiveServicePidFn: async () => ({ pid: f.hostCalls.includes("start:stable") ? 9001 : livePid }),
  };
}

function deps(f: ReturnType<typeof fixture>) {
  return {
    currentBinaryPath: "/verified/candidate",
    computerVersion: TARGET,
    statFn: (async () => ({ isFile: () => true, size: 123 })) as never,
    sha256FileFn: async () => SHA,
    healthProbeFn: async () => ({ version: TARGET, pid: 123, startId: "live-target" }),
    accessFn: (async () => {}) as never,
    randomIdFn: () => "fixed",
    nowMs: () => 10,
    startArtifactServerFn: async () => ({ source: f.source, close: async () => {} }),
    bootstrapStableFn: (async (opts: { version: string }) => {
      f.bootstraps.push(opts.version);
      f.hostCalls.push("bootstrap");
      return "bootstrapped" as const;
    }) as never,
    hostAdapterFn: () => f.host,
    platform: "linux" as NodeJS.Platform,
    env: {} as NodeJS.ProcessEnv,
    findLiveServicePidFn: async () => ({ pid: 4242 }),
    onServiceState: (state: KInstallerServiceState) => { f.serviceStates.push(state); },
    createUpgraderFn: (_home: string, source: ReleaseSource) => {
      f.upgraderSources.push(source);
      return f.upgrader;
    },
  };
}

test("official installer drives the exact verified candidate through K and binds its receipt", async () => {
  const f = fixture();
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, deps(f)),
    "converged",
  );
  assert.deepEqual(f.sourceReads, [TARGET]);
  assert.deepEqual(f.upgraderSources, [f.source]);
  assert.equal(f.upgradeCalls.length, 1);
  assert.deepEqual(f.upgradeCalls[0], {
    version: TARGET,
    opts: {
      consented: true,
      provenance: { who: "local", carrier: "installer" },
      operation: {
        id: "installer-fixed",
        startedAtMs: 10,
        metadata: {
          trigger: "cli",
          installer: "official",
          targetVersion: TARGET,
          artifactSha256: SHA,
          artifactSize: "123",
        },
      },
    },
  });
  assert.deepEqual(f.acknowledgements, ["installer-fixed"]);
});

test("candidate hash mismatch fails before K or its exact-byte source", async () => {
  const f = fixture();
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      sha256FileFn: async () => "b".repeat(64),
    }),
    /K_INSTALLER_SHA256_MISMATCH/u,
  );
  assert.equal(f.upgradeCalls.length, 0);
  assert.deepEqual(f.sourceReads, []);
});

test("default artifact source serves only the verified local candidate bytes", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "raft-installer-candidate-"));
  t.onTestFinished(async () => rm(root, { recursive: true, force: true }));
  const candidate = resolve(root, "raft-computer");
  const bytes = Buffer.from("exact verified installer candidate\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(candidate, bytes);
  const f = fixture();
  const originalUpgradeTo = f.upgrader.upgradeTo.bind(f.upgrader);

  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, sha256, {}, {
      ...deps(f),
      currentBinaryPath: candidate,
      statFn: undefined,
      startArtifactServerFn: undefined,
      sha256FileFn: async (path) => path === candidate
        ? createHash("sha256").update(await readFile(path)).digest("hex")
        : sha256,
      createUpgraderFn: (_home, source) => ({
        ...f.upgrader,
        upgradeTo: async (version, opts) => {
          const release = await source.fetchRelease(version, {
            currentVersion: "1.0.17",
            platformKey: "test",
          });
          assert.equal(release.version, TARGET);
          assert.equal(release.sha256, sha256);
          assert.equal(release.size, bytes.length);
          assert.match(release.url, /^http:\/\/127\.0\.0\.1:\d+\//u);
          const response = await fetch(release.url);
          assert.equal(response.status, 200);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
          return originalUpgradeTo(version, opts);
        },
      }),
    }),
    "converged",
  );
});

test("active K operation rejects, while a terminal receipt is quarantined", async () => {
  const active = fixture({
    operation: {
      kind: "observed",
      operation: terminalOperation({ outcome: null, phase: "staging", acknowledgedAtMs: null }),
    },
  });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, deps(active)),
    /K_INSTALLER_OPERATION_ACTIVE/u,
  );
  assert.equal(active.upgradeCalls.length, 0);

  const terminal = fixture({
    operation: {
      kind: "observed",
      operation: terminalOperation({ outcome: "promoted", phase: "promoted", acknowledgedAtMs: null }),
    },
  });
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, deps(terminal)),
    "converged",
  );
  assert.equal(terminal.quarantineCalls.length, 1);
});

test("automatic recovery preserves every local terminal outcome before reinstall", async () => {
  for (const outcome of ["rolled-back", "failed", "promoted", "held", "up-to-date"] as const) {
    const f = fixture({ operation: { kind: "observed", operation: terminalOperation({
      outcome, phase: outcome, acknowledgedAtMs: null,
    }) } });
    assert.equal(
      await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
        ...deps(f), nowMs: () => 1234,
      }),
      "converged",
    );
    assert.deepEqual(f.quarantineCalls, [{
      destination: "/home/computer/k-quarantine/old-operation-1234", timestampMs: 1234,
    }], `${outcome}: preserve old state instead of acknowledging it as delivered`);
    assert.deepEqual(f.acknowledgements, ["installer-fixed"]);
    assert.equal(f.upgradeCalls.length, 1);
  }
});

test("default reinstall quarantines an unacknowledged terminal failed receipt before convergence", async () => {
  const f = fixture({
    operation: {
      kind: "observed",
      operation: terminalOperation({
        outcome: "failed",
        phase: "failed",
        acknowledgedAtMs: null,
        provenance: { who: "local", carrier: "installer" },
        metadata: { trigger: "cli", installer: "official" },
      }),
    },
  });
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      nowMs: () => 1234,
    }),
    "converged",
  );
  assert.deepEqual(f.quarantineCalls, [{
    destination: "/home/computer/k-quarantine/old-operation-1234",
    timestampMs: 1234,
  }]);
});

test("default reinstall does not quarantine a remote terminal receipt", async () => {
  const f = fixture({
    operation: {
      kind: "observed",
      operation: terminalOperation({
        outcome: "failed",
        phase: "failed",
        acknowledgedAtMs: null,
        provenance: { who: "server-1", carrier: "web" },
        metadata: { originServerId: "server-1" },
      }),
    },
  });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, deps(f)),
    /K_INSTALLER_RECOVERY_SCOPE_MISMATCH/u,
  );
  assert.equal(f.quarantineCalls.length, 0);
  assert.equal(f.upgradeCalls.length, 0);
});

test("default reinstall rejects a terminal receipt while its coordinator is alive", async () => {
  const f = fixture({
    operation: {
      kind: "observed",
      operation: terminalOperation({
        outcome: "failed",
        phase: "failed",
        acknowledgedAtMs: null,
        provenance: { who: "local", carrier: "installer" },
        metadata: { coordinatorPid: "123" },
      }),
    },
  });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      isProcessAliveFn: (pid: number) => pid === 123,
    }),
    /K_INSTALLER_RECOVERY_ACTIVE/u,
  );
  assert.equal(f.quarantineCalls.length, 0);
  assert.equal(f.upgradeCalls.length, 0);
});

test("automatic recovery never bypasses an active operation", async () => {
  for (const operation of [
    terminalOperation({ outcome: null, phase: "staging", acknowledgedAtMs: null }),
  ]) {
    const f = fixture({ operation: { kind: "observed", operation } });
    await assert.rejects(
      convergeKInitializedInstaller("/home", TARGET, SHA, {}, deps(f)),
      /K_INSTALLER_OPERATION_ACTIVE/u,
    );
    assert.equal(f.upgradeCalls.length, 0);
  }
});

test("automatic recovery does not consume a remote failed receipt", async () => {
  const f = fixture({
    operation: {
      kind: "observed",
      operation: terminalOperation({
        outcome: "failed",
        phase: "failed",
        acknowledgedAtMs: null,
        provenance: { who: "server-1", carrier: "web" },
        metadata: { originServerId: "server-1" },
      }),
    },
  });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, { ...deps(f), ...residentService(f, "1.0.17", TARGET) }),
    /K_INSTALLER_RECOVERY_SCOPE_MISMATCH/u,
  );
  assert.deepEqual(f.hostCalls, [], "refusal must not stop the resident");
  assert.deepEqual(f.acknowledgements, []);
  assert.equal(f.upgradeCalls.length, 0);
});

test("automatic recovery rejects a failed receipt while its coordinator is still alive", async () => {
  const f = fixture({
    operation: {
      kind: "observed",
      operation: terminalOperation({
        outcome: "failed",
        phase: "failed",
        acknowledgedAtMs: null,
        provenance: { who: "local", carrier: "installer" },
        metadata: { trigger: "cli", installer: "official", coordinatorPid: "123" },
      }),
    },
  });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      ...residentService(f, "1.0.17", TARGET),
      isProcessAliveFn: (pid: number) => pid === 123,
    }),
    /K_INSTALLER_RECOVERY_ACTIVE/u,
  );
  assert.deepEqual(f.hostCalls, [], "refusal must not stop the resident");
  assert.deepEqual(f.acknowledgements, []);
  assert.equal(f.upgradeCalls.length, 0);
});

test("unreadable or in-flight K state rejects before a new drive", async () => {
  const unreadable = fixture({ operation: { kind: "unreadable", reason: "corrupt operation" } });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, deps(unreadable)),
    /K_INSTALLER_STATE_UNREADABLE/u,
  );
  assert.equal(unreadable.upgradeCalls.length, 0);

  const inFlight = fixture({ phase: "staged" });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, deps(inFlight)),
    /K_INSTALLER_OPERATION_ACTIVE/u,
  );
  assert.equal(inFlight.upgradeCalls.length, 0);
});

test("an empty K directory is not treated as initialized stable state", async () => {
  const f = fixture({
    operation: { kind: "genesis" },
    stableVersion: "0.0.0",
    phase: "idle",
  });
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      accessFn: (async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }) as never,
    }),
    "not-initialized",
  );
  assert.equal(f.upgradeCalls.length, 0);
});

test("newer K stable refuses downgrade unless the installer force flag is explicit", async () => {
  const held = fixture({ stableVersion: "1.0.19" });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, deps(held)),
    /K_INSTALLER_DOWNGRADE_REFUSED/u,
  );
  assert.equal(held.upgradeCalls.length, 0);

  const forced = fixture({ stableVersion: "1.0.19" });
  assert.equal(
    await convergeKInitializedInstaller(
      "/home",
      TARGET,
      SHA,
      { forceDowngrade: true },
      deps(forced),
    ),
    "converged",
  );
});

test("receipt must preserve exact candidate identity and final stable readback", async () => {
  const changedReceipt = fixture({
    receiptMutation: (receipt) => ({
      ...receipt,
      metadata: { ...receipt.metadata, artifactSha256: "b".repeat(64) },
    }),
  });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, deps(changedReceipt)),
    /K_INSTALLER_RECEIPT_MISMATCH/u,
  );

  const changedTrigger = fixture({
    receiptMutation: (receipt) => ({
      ...receipt,
      metadata: { ...receipt.metadata, trigger: "tray" },
    }),
  });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, deps(changedTrigger)),
    /K_INSTALLER_RECEIPT_MISMATCH/u,
  );

  const staleReadback = fixture({
    outcome: {
      result: "held",
      reason: "test held",
    },
  });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, deps(staleReadback)),
    /K_INSTALLER_CONVERGENCE_FAILED/u,
  );
  assert.deepEqual(
    staleReadback.acknowledgements,
    [],
    "a held terminal outcome must remain unacknowledged without stable/live proof",
  );

  const staleBytes = fixture();
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(staleBytes),
      sha256FileFn: async (path) => path === "/verified/candidate" ? SHA : "b".repeat(64),
    }),
    /K_INSTALLER_STABLE_BYTES_MISMATCH/u,
  );
  assert.deepEqual(
    staleBytes.acknowledgements,
    [],
    "a version-only promote must not acknowledge an exact-byte convergence receipt",
  );

  const staleLive = fixture();
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(staleLive),
      healthProbeFn: async () => ({ version: "1.0.17", pid: 123, startId: "stale-live" }),
    }),
    /K_INSTALLER_LIVE_VERSION_MISMATCH/u,
  );
  assert.deepEqual(
    staleLive.acknowledgements,
    [],
    "a promoted slot must not acknowledge until its live service reports the exact target",
  );
});

test("a coordinator throw after publishing a promoted receipt remains unacknowledged", async () => {
  const failedCoordinator = fixture({
    upgradeErrorAfterReceipt: new Error("coordinator failed after receipt publication"),
  });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, deps(failedCoordinator)),
    /coordinator failed after receipt publication/u,
  );
  assert.deepEqual(
    failedCoordinator.acknowledgements,
    [],
    "a promoted receipt is not sufficient without coordinator success and stable/live proof",
  );
});

test("fresh install with no resident service converges and reports not-running instead of demanding a live probe", async () => {
  const f = fixture();
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      ...residentService(f, null, null),
    }),
    "converged",
  );
  assert.equal(f.quarantineCalls.length, 1);
  assert.deepEqual(f.bootstraps, [TARGET]);
  assert.deepEqual(f.hostCalls, ["quarantine", "bootstrap"], "nothing was alive, so nothing may be stopped or started");
  assert.deepEqual(f.serviceStates, [{ kind: "not-running" }]);
  assert.deepEqual(f.acknowledgements, ["installer-fixed"]);
});

test("fresh install hands a live old service over to the new stable and requires the successor to attest the target", async () => {
  const f = fixture();
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      ...residentService(f, "1.0.17", TARGET),
    }),
    "converged",
  );
  assert.equal(f.quarantineCalls.length, 1);
  assert.deepEqual(
    f.hostCalls,
    ["quiesce", "stop:stable", "quarantine", "bootstrap", "start:stable", "resume"],
    "the resident is parked and stopped before its slot is renamed, and started from the new stable after bootstrap",
  );
  assert.deepEqual(f.serviceStates, [{ kind: "restarted", version: TARGET, pid: 9001 }]);
  assert.deepEqual(f.acknowledgements, ["installer-fixed"]);
});

test("fresh install restarts a resident that already attests the target: it was started from the slot being quarantined", async () => {
  const f = fixture();
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      ...residentService(f, TARGET, TARGET),
    }),
    "converged",
  );
  assert.deepEqual(f.hostCalls, ["quiesce", "stop:stable", "quarantine", "bootstrap", "start:stable", "resume"]);
  assert.deepEqual(f.serviceStates, [{ kind: "restarted", version: TARGET, pid: 9001 }]);
});

test("fresh install gives the old stable service back when quarantine fails after the stop", async () => {
  const f = fixture({ quarantineError: new Error("QUARANTINE_ACTIVE_LOCK: another writer holds the K lock") });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      ...residentService(f, "1.0.17", "1.0.17"),
    }),
    /QUARANTINE_ACTIVE_LOCK/u,
  );
  assert.deepEqual(f.hostCalls, ["quiesce", "stop:stable", "start:stable"], "the stopped resident is restarted from the untouched old slot");
  assert.deepEqual(f.bootstraps, []);
  assert.deepEqual(f.acknowledgements, []);
});

test("fresh install hands over a service that is alive but predates the attestation probe", async () => {
  const f = fixture();
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      ...residentService(f, null, TARGET, 777),
    }),
    "converged",
  );
  assert.deepEqual(f.hostCalls, ["quiesce", "stop:stable", "quarantine", "bootstrap", "start:stable", "resume"]);
  assert.deepEqual(f.serviceStates, [{ kind: "restarted", version: TARGET, pid: 9001 }]);
});

test("fresh install fails closed and acknowledges nothing when the handed-over service does not attest the target", async () => {
  const stale = fixture();
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(stale),
      ...residentService(stale, "1.0.17", "1.0.17"),
    }),
    /K_INSTALLER_LIVE_VERSION_MISMATCH/u,
  );
  assert.deepEqual(stale.acknowledgements, []);

  const silent = fixture();
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(silent),
      ...residentService(silent, "1.0.17", null),
    }),
    /K_INSTALLER_HANDOFF_FAILED/u,
  );
  assert.deepEqual(silent.acknowledgements, []);
});

test("reinstall at the exact settled stable target touches no K state and keeps a live target service", async () => {
  const f = fixture({ stableVersion: TARGET });
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f), ...residentService(f, TARGET, TARGET),
    }),
    "converged",
  );
  assert.deepEqual(f.quarantineCalls, []);
  assert.deepEqual(f.bootstraps, []);
  assert.deepEqual(f.upgradeCalls, []);
  assert.deepEqual(f.acknowledgements, []);
  assert.deepEqual(f.hostCalls, []);
  assert.deepEqual(f.serviceStates, [{ kind: "live", version: TARGET, pid: 4242 }]);
});

test("reinstall at the exact settled stable target restarts a stale resident onto stable", async () => {
  const f = fixture({ stableVersion: TARGET });
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      ...residentService(f, "1.0.17", TARGET),
    }),
    "converged",
  );
  assert.deepEqual(f.quarantineCalls, []);
  assert.deepEqual(f.upgradeCalls, []);
  assert.deepEqual(f.hostCalls, ["quiesce", "stop:stable", "start:stable", "resume"]);
  assert.deepEqual(f.serviceStates, [{ kind: "restarted", version: TARGET, pid: 9001 }]);
});

test("reinstall at the exact target with stopped service reports not-running without quarantine", async () => {
  const f = fixture({ stableVersion: TARGET });
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      ...residentService(f, null, null),
    }),
    "converged",
  );
  assert.deepEqual(f.quarantineCalls, []);
  assert.deepEqual(f.serviceStates, [{ kind: "not-running" }]);
});

test("reinstall at the exact target with different stable bytes is not a no-op", async () => {
  const f = fixture({ stableVersion: TARGET });
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      ...residentService(f, null, null),
      sha256FileFn: async (path) => path === "/verified/candidate" || f.bootstraps.length > 0 ? SHA : "b".repeat(64),
    }),
    "converged",
  );
  assert.equal(f.quarantineCalls.length, 1, "version-equal but byte-different stable must be replaced");
  assert.deepEqual(f.bootstraps, [TARGET]);
});

test("an unacknowledged installer receipt at the exact target still runs a fresh install (no silent adoption)", async () => {
  const f = fixture({
    stableVersion: TARGET,
    operation: {
      kind: "observed",
      operation: terminalOperation({
        id: "installer-previous",
        fromVersion: TARGET,
        outcome: "up-to-date",
        phase: "up-to-date",
        acknowledgedAtMs: null,
        provenance: { who: "local", carrier: "installer" },
        metadata: { trigger: "cli", installer: "official" },
      }),
    },
  });
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      ...residentService(f, null, null),
    }),
    "converged",
  );
  assert.equal(f.quarantineCalls.length, 1);
  assert.deepEqual(f.serviceStates, [{ kind: "not-running" }]);
  assert.deepEqual(f.acknowledgements, ["installer-fixed"]);
});

test("macOS handoff refuses before stopping anything when the stable dispatcher path is not in the environment", async () => {
  const fresh = fixture();
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(fresh),
      ...residentService(fresh, "1.0.17", TARGET),
      platform: "darwin",
      env: {},
    }),
    /K_INSTALLER_DISPATCHER_UNBOUND/u,
  );
  assert.deepEqual(fresh.hostCalls, [], "the resident must not be parked, stopped, or have its slot renamed");
  assert.deepEqual(fresh.quarantineCalls, []);
  assert.deepEqual(fresh.acknowledgements, []);

  const exact = fixture({ stableVersion: TARGET });
  await assert.rejects(
    convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(exact),
      ...residentService(exact, "1.0.17", TARGET),
      platform: "darwin",
      env: { RAFT_COMPUTER_DISPATCHER_PATH: "relative/raft-computer" },
    }),
    /K_INSTALLER_DISPATCHER_UNBOUND/u,
  );
  assert.deepEqual(exact.hostCalls, []);
});

test("macOS handoff proceeds with an absolute stable dispatcher path in the environment", async () => {
  const f = fixture();
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      ...residentService(f, "1.0.17", TARGET),
      platform: "darwin",
      env: { RAFT_COMPUTER_DISPATCHER_PATH: "/Users/artin/.local/bin/raft-computer" },
    }),
    "converged",
  );
  assert.deepEqual(f.hostCalls, ["quiesce", "stop:stable", "quarantine", "bootstrap", "start:stable", "resume"]);
});

test("macOS fresh install with no resident needs no dispatcher path: nothing is handed off", async () => {
  const f = fixture();
  assert.equal(
    await convergeKInitializedInstaller("/home", TARGET, SHA, {}, {
      ...deps(f),
      ...residentService(f, null, null),
      platform: "darwin",
      env: {},
    }),
    "converged",
  );
  assert.deepEqual(f.serviceStates, [{ kind: "not-running" }]);
});
