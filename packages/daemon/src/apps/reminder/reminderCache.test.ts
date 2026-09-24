import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import type { ReminderJob } from "@botiverse/raft-shared";

import { createAgentAppInboxStore, type AgentAppInboxStore } from "../../agentAppInbox.js";
import { createScopedAppStorageFactory } from "../../scopedAppStorage.js";
import {
  REMINDER_AGENT_INBOX_REGISTRY,
  REMINDER_DUE_NOTIFICATION_CLASS,
  REMINDER_INBOX_APP_ID,
} from "./inboxDefinition.js";
import {
  createReminderDueIdentity,
  createReminderPhaseTruth,
  REMINDER_BOUNDED_ALERT_PHASES,
  ReminderCache,
} from "./reminderCache.js";
import { FakeClock } from "../../testing/fakeClock.js";
import type { ScopedAppStorage } from "../../scopedAppStorage.js";

function createTestReminderStorage(filePath: string): ScopedAppStorage {
  return {
    assertActive: () => {},
    readText: () => {
      try {
        return readFileSync(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    writeTextAtomic: (contents) => {
      mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.test-tmp`;
      writeFileSync(temporary, contents);
      renameSync(temporary, filePath);
    },
    reportDataFailure: () => {},
  };
}

function createInboxStorage(root: string, agentId = "agentA") {
  return createScopedAppStorageFactory({
    slockHome: root,
    owner: { machineId: "machine-test", serverId: "server-test" },
  }).open({ appId: "system.agent-inbox", agentId });
}

function makeJob(overrides: Partial<ReminderJob> & Pick<ReminderJob, "reminderId" | "ownerAgentId">): ReminderJob {
  return {
    reminderId: overrides.reminderId,
    ownerAgentId: overrides.ownerAgentId,
    msgId: overrides.msgId ?? null,
    title: overrides.title ?? "t",
    fireAt: overrides.fireAt ?? new Date(60_000).toISOString(),
    version: overrides.version ?? 1,
    recurrence: overrides.recurrence ?? null,
  };
}

function makePersistedReceipt(job: ReminderJob) {
  const requestId = "request-test";
  const firedAtClient = new Date(10_000).toISOString();
  return {
    job,
    requestId,
    firedAtClient,
    catchup: false,
    wakeEnqueued: false,
    serverAcked: false,
    serverFired: false,
    itemConsumed: false,
    retryAttempt: 0,
    retryNextAttemptAt: null,
    retryDeadlineAt: new Date(910_000).toISOString(),
    retryTerminal: null,
    phaseTruth: createReminderPhaseTruth({ occurrenceId: requestId, firedAtClient }),
  };
}

function mintReminderItem(store: AgentAppInboxStore, job: ReminderJob) {
  const result = store.mint({
    appId: REMINDER_INBOX_APP_ID,
    notificationClass: REMINDER_DUE_NOTIFICATION_CLASS,
    sourceRef: { kind: "reminder", id: job.reminderId, revision: String(job.version) },
    title: job.title,
    summary: "Reminder due",
  });
  if (!result.ok) throw new Error(result.message);
  return result.item;
}

async function fireAndConvergeReceipt(
  cache: ReminderCache,
  clock: FakeClock,
  job: ReminderJob,
  advanceByMs: number,
) {
  assert.equal(cache.upsert(job), "applied");
  clock.advanceBy(advanceByMs);
  await new Promise((resolve) => setImmediate(resolve));
  const receipt = cache.pendingFireReceipts().find((pending) =>
    pending.job.ownerAgentId === job.ownerAgentId
    && pending.job.reminderId === job.reminderId
    && pending.job.version === job.version
  );
  assert.ok(receipt, `receipt v${job.version} should be pending before Server ack`);
  assert.equal(receipt.wakeEnqueued, true, `receipt v${job.version} should have local wake completion`);
  assert.equal(receipt.serverAcked, false);
  assert.equal(cache.ackFireReceipt(createReminderDueIdentity({
    ownerAgentId: job.ownerAgentId,
    reminderId: job.reminderId,
    version: job.version,
  })), true);
  assert.equal(receipt.serverAcked, true, `receipt v${job.version} should have Server convergence`);
  return receipt;
}

// Compile-time guard: ownerAgentId is mandatory at the sole identity
// constructor. Not executed — the ts-expect-error directive is the check,
// enforced by `pnpm --filter @botiverse/raft-daemon typecheck`.
function _ownerBoundIdentityTypeGuard(): void {
  // @ts-expect-error ownerAgentId is mandatory at the sole identity constructor.
  createReminderDueIdentity({ reminderId: "r-ownerless", version: 1 });
}
void _ownerBoundIdentityTypeGuard;

test("upsert applies newer version, ignores stale", () => {
  const clock = new FakeClock();
  const fired: string[] = [];
  const cache = new ReminderCache({ clock, onFire: (j) => { fired.push(j.reminderId); } });
  cache.start();
  cache.snapshot("a1", []);

  cache.upsert(makeJob({ reminderId: "r1", ownerAgentId: "a1", version: 2, fireAt: new Date(120_000).toISOString() }));
  // Stale (v1) should be ignored — cached is v2.
  cache.upsert(makeJob({ reminderId: "r1", ownerAgentId: "a1", version: 1, fireAt: new Date(10_000).toISOString() }));

  clock.advanceBy(30_000);
  assert.deepEqual(fired, []); // v2 fires at 120s, not yet
  clock.advanceBy(100_000);
  assert.deepEqual(fired, ["r1"]);
});

test("an occurrence observer failure is loud but cannot suppress the due side effect", () => {
  const clock = new FakeClock();
  const fired: string[] = [];
  let observed = 0;
  const cache = new ReminderCache({
    clock,
    onOccurrenceFired: () => {
      observed += 1;
      throw new Error("observer unavailable");
    },
    onFire: (job) => { fired.push(job.reminderId); },
  });
  cache.start();
  cache.snapshot("a1", []);
  cache.upsert(makeJob({
    reminderId: "observer-failure",
    ownerAgentId: "a1",
    fireAt: new Date(5).toISOString(),
  }));

  clock.advanceBy(5);
  assert.equal(observed, 1);
  assert.deepEqual(fired, ["observer-failure"]);
  assert.equal(cache.pendingFireReceipts().length, 1);
  assert.deepEqual(cache.pendingFireReceipts()[0]!.phaseTruth.fired, {
    state: true,
    evidence: "transition_provenance_missing",
    transition: null,
  });
});

test("cancel clears the timer", () => {
  const clock = new FakeClock();
  const fired: string[] = [];
  const cache = new ReminderCache({ clock, onFire: (j) => { fired.push(j.reminderId); } });
  cache.start();
  cache.snapshot("a1", []);

  cache.upsert(makeJob({ reminderId: "r1", ownerAgentId: "a1", version: 1, fireAt: new Date(60_000).toISOString() }));
  cache.cancel("r1", 1);
  clock.advanceBy(120_000);
  assert.deepEqual(fired, []);
  assert.equal(cache.size(), 0);
});

test("long-horizon timer re-arms at the bounded delay instead of firing early", () => {
  const clock = new FakeClock();
  const fired: string[] = [];
  const cache = new ReminderCache({
    clock,
    maxDelayMs: 100,
    onFire: (job) => { fired.push(job.reminderId); },
  });
  cache.start();
  cache.snapshot("agentA", []);
  cache.upsert(makeJob({
    reminderId: "r-long-horizon",
    ownerAgentId: "agentA",
    fireAt: new Date(250).toISOString(),
  }));

  clock.advanceBy(100);
  assert.deepEqual(fired, []);
  clock.advanceBy(100);
  assert.deepEqual(fired, []);
  clock.advanceBy(50);
  assert.deepEqual(fired, ["r-long-horizon"]);
});

test("newer upsert or cancel committed before fire intent makes old revision a zero-item no-op", () => {
  const clock = new FakeClock();
  const fired: number[] = [];
  const cache = new ReminderCache({ clock, onFire: (job) => { fired.push(job.version); } });
  cache.start();
  cache.snapshot("agentA", []);

  cache.upsert(makeJob({
    reminderId: "r-updated-before-due",
    ownerAgentId: "agentA",
    version: 1,
    fireAt: new Date(10_000).toISOString(),
  }));
  cache.upsert(makeJob({
    reminderId: "r-updated-before-due",
    ownerAgentId: "agentA",
    version: 2,
    fireAt: new Date(30_000).toISOString(),
  }));
  cache.upsert(makeJob({
    reminderId: "r-canceled-before-due",
    ownerAgentId: "agentA",
    version: 1,
    fireAt: new Date(10_000).toISOString(),
  }));
  cache.cancel("r-canceled-before-due", 2);

  clock.advanceBy(20_000);
  assert.deepEqual(fired, [], "superseded revision N produces zero local due item");
  assert.equal(cache.pendingFireReceipts().length, 0);
  clock.advanceBy(10_000);
  assert.deepEqual(fired, [2], "only the future replacement revision may fire");
});

test("fire intent committed before newer revision preserves historical item and arms the new identity", async () => {
  const clock = new FakeClock();
  const fired: number[] = [];
  const cache = new ReminderCache({ clock, onFire: (job) => { fired.push(job.version); } });
  cache.start();
  cache.snapshot("agentA", []);
  cache.upsert(makeJob({
    reminderId: "r-fire-before-update",
    ownerAgentId: "agentA",
    version: 1,
    fireAt: new Date(10_000).toISOString(),
  }));

  clock.advanceBy(10_000);
  assert.deepEqual(fired, [1]);
  assert.deepEqual(cache.pendingFireReceipts().map((receipt) => receipt.job.version), [1]);

  cache.upsert(makeJob({
    reminderId: "r-fire-before-update",
    ownerAgentId: "agentA",
    version: 2,
    fireAt: new Date(30_000).toISOString(),
  }));
  assert.deepEqual(
    cache.pendingFireReceipts().map((receipt) => receipt.job.version),
    [1],
    "new revision does not retroactively erase the committed N due fact",
  );
  clock.advanceBy(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fired, [1, 2]);
  assert.deepEqual(cache.pendingFireReceipts().map((receipt) => receipt.job.version), [1, 2]);
});

test("snapshot replaces entries only for the named agent", () => {
  // Regression: the previous impl called `entries.clear()` unconditionally,
  // so a daemon hosting agents A and B would have B's snapshot wipe A's
  // timers (and vice versa) after reconnect. snapshot() is now scoped
  // per-agent — the server sends one request per agent and each only
  // replaces that agent's slice of the cache.
  const clock = new FakeClock();
  const fired: string[] = [];
  const cache = new ReminderCache({ clock, onFire: (j) => { fired.push(j.reminderId); } });
  cache.start();
  cache.snapshot("agentA", []);
  cache.snapshot("agentB", []);

  cache.upsert(makeJob({ reminderId: "rA", ownerAgentId: "agentA", fireAt: new Date(60_000).toISOString() }));
  cache.upsert(makeJob({ reminderId: "rB", ownerAgentId: "agentB", fireAt: new Date(60_000).toISOString() }));
  assert.equal(cache.size(), 2);

  // Snapshot for agentA replaces rA with rA' but must leave rB intact.
  cache.snapshot("agentA", [
    makeJob({ reminderId: "rA2", ownerAgentId: "agentA", fireAt: new Date(60_000).toISOString() }),
  ]);
  assert.equal(cache.size(), 2);
  assert.equal(cache.getJob("rA"), null);
  assert.ok(cache.getJob("rA2"));
  assert.ok(cache.getJob("rB"));

  clock.advanceBy(120_000);
  assert.deepEqual(fired.sort(), ["rA2", "rB"]);
});

test("snapshot with empty job list still only clears the named agent's entries", () => {
  const clock = new FakeClock();
  const cache = new ReminderCache({ clock, onFire: () => {} });
  cache.start();

  cache.upsert(makeJob({ reminderId: "rA", ownerAgentId: "agentA" }));
  cache.upsert(makeJob({ reminderId: "rB", ownerAgentId: "agentB" }));
  cache.snapshot("agentA", []);
  assert.equal(cache.size(), 1);
  assert.ok(cache.getJob("rB"));
});

test("authoritative snapshot omission preserves the revision fence", () => {
  const clock = new FakeClock();
  const fired: number[] = [];
  const cache = new ReminderCache({ clock, onFire: (job) => { fired.push(job.version); } });
  cache.start();

  const current = makeJob({
    reminderId: "snapshot-fence",
    ownerAgentId: "agentA",
    version: 2,
    fireAt: new Date(10_000).toISOString(),
  });
  assert.equal(cache.upsert(current), "applied");
  cache.snapshot("agentA", []);
  assert.equal(cache.getJob(current.reminderId), null);
  assert.equal(cache.upsert(current), "stale", "same revision cannot resurrect an authoritative omission");
  assert.equal(cache.upsert({ ...current, version: 1 }), "stale", "older revision cannot resurrect an authoritative omission");
  clock.advanceBy(20_000);
  assert.deepEqual(fired, []);

  const newer = { ...current, version: 3, fireAt: new Date(30_000).toISOString() };
  assert.equal(cache.upsert(newer), "applied");
  clock.advanceBy(10_000);
  assert.deepEqual(fired, [3], "a genuinely newer revision may restore the schedule");
});

test("snapshot ignores jobs whose ownerAgentId doesn't match the snapshot's agentId", () => {
  // Defensive: the server only sends a given agent's reminders in its
  // snapshot, but if protocol drifted we'd rather skip mis-routed jobs
  // than plant them under the wrong owner.
  const clock = new FakeClock();
  const cache = new ReminderCache({ clock, onFire: () => {} });
  cache.start();
  cache.snapshot("agentA", [
    makeJob({ reminderId: "rA", ownerAgentId: "agentA" }),
    makeJob({ reminderId: "rBogus", ownerAgentId: "agentB" }),
  ]);
  assert.equal(cache.size(), 1);
  assert.ok(cache.getJob("rA"));
  assert.equal(cache.getJob("rBogus"), null);
});

test("pre-snapshot upsert stays inert and the matching first snapshot arms it", async () => {
  const clock = new FakeClock();
  const fired: string[] = [];
  const cache = new ReminderCache({
    clock,
    onFire: (job) => { fired.push(job.reminderId); },
  });
  const job = makeJob({
    reminderId: "pre-snapshot-upsert",
    ownerAgentId: "agentA",
    fireAt: new Date(10_000).toISOString(),
  });
  cache.start();
  assert.equal(cache.upsert(job), "applied");
  assert.equal(cache.isSynchronized("agentA"), false);
  assert.equal(clock.pendingTimerCount(), 0);
  clock.advanceBy(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fired, []);

  cache.snapshot("agentA", [job]);
  assert.equal(cache.isSynchronized("agentA"), true);
  assert.equal(clock.pendingTimerCount(), 1);
  clock.advanceBy(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fired, [job.reminderId]);
});

test("restart stays empty until an authoritative snapshot replaces legacy schedules", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-snapshot-before-arm-"));
  const persistencePath = path.join(dir, "mirror.json");
  const legacyJob = makeJob({
    reminderId: "legacy-stale-schedule",
    ownerAgentId: "agentA",
    version: 4,
    fireAt: new Date(10_000).toISOString(),
  });
  try {
    writeFileSync(persistencePath, `${JSON.stringify({
      version: 5,
      records: [{
        reminderId: legacyJob.reminderId,
        ownerAgentId: legacyJob.ownerAgentId,
        version: legacyJob.version,
        job: legacyJob,
        receipts: [],
      }],
    })}\n`);

    const restartClock = new FakeClock();
    restartClock.advanceBy(60_000);
    const fired: string[] = [];
    const restarted = new ReminderCache({
      clock: restartClock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      onFire: (job) => { fired.push(job.reminderId); },
    });

    restarted.start();
    assert.equal(restarted.size(), 0, "restored schedules are not locally rehydrated");
    assert.equal(restartClock.pendingTimerCount(), 0, "snapshot-before-arm leaves zero timer intents");
    restartClock.advanceBy(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fired, [], "a stale legacy schedule never catches up before sync");
    restarted.snapshot("agentA", []);
    restartClock.advanceBy(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fired, [], "an omitted legacy schedule never fires after sync either");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scoped persistence contains pending receipts only, never schedules or tombstones", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-receipt-only-"));
  const persistencePath = path.join(dir, "agentA.json");
  const clock = new FakeClock();
  const job = makeJob({
    reminderId: "receipt-only",
    ownerAgentId: "agentA",
    version: 5,
    fireAt: new Date(10_000).toISOString(),
  });
  try {
    const cache = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      onFire: () => ({ wakeEnqueued: false }),
    });
    cache.start();
    cache.snapshot("agentA", [job]);
    assert.deepEqual(
      JSON.parse(readFileSync(persistencePath, "utf8")),
      { version: 6, records: [] },
      "an authoritative schedule alone produces no durable record",
    );

    clock.advanceBy(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    const nextJob = makeJob({
      ...job,
      version: job.version + 1,
      fireAt: new Date(20_000).toISOString(),
    });
    assert.equal(cache.upsert(nextJob), "applied");
    cache.snapshot("agentA", [nextJob]);
    const persisted = JSON.parse(readFileSync(persistencePath, "utf8")) as {
      version: number;
      records: Array<Record<string, unknown> & { receipts: Array<{ job: ReminderJob }> }>;
    };
    assert.equal(persisted.version, 6);
    assert.equal(persisted.records.length, 1);
    assert.deepEqual(
      Object.keys(persisted.records[0]!).sort(),
      ["job", "ownerAgentId", "receipts", "reminderId", "version"],
    );
    assert.equal(persisted.records[0]!.job, null, "outer schedule/tombstone state is never persisted");
    assert.equal(persisted.records[0]!.receipts.length, 1);
    assert.deepEqual(persisted.records[0]!.receipts[0]!.job, job);
    cache.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scoped receipt restore rejects a cross-owner payload and reports it exactly once", () => {
  const ownerJob = makeJob({
    reminderId: "cross-owner-receipt",
    ownerAgentId: "agentB",
    version: 1,
  });
  const payload = `${JSON.stringify({
    version: 5,
    records: [{
      reminderId: ownerJob.reminderId,
      ownerAgentId: ownerJob.ownerAgentId,
      version: ownerJob.version,
      job: null,
      receipts: [makePersistedReceipt(ownerJob)],
    }],
  })}\n`;
  let reports = 0;
  const storage: ScopedAppStorage = {
    assertActive: () => {},
    readText: () => payload,
    writeTextAtomic: () => {},
    reportDataFailure: (reason) => {
      assert.equal(reason, "invalid_payload");
      reports += 1;
    },
  };
  const cache = new ReminderCache({
    storageForAgent: (agentId) => {
      assert.equal(agentId, "agentA");
      return storage;
    },
    onFire: () => {},
  });
  cache.start();
  assert.throws(
    () => cache.snapshot("agentA", []),
    /owner scope invalid/,
  );
  assert.equal(reports, 1);
  assert.throws(
    () => cache.snapshot("agentA", []),
    /owner scope invalid/,
    "a rejected payload must not mark its Agent as restored",
  );
  assert.equal(reports, 2, "each rejected restore attempt emits exactly one failure event");
  assert.equal(cache.size(), 0);
  assert.equal(cache.pendingFireReceipts().length, 0);
});

const validPrefixJob = makeJob({
  reminderId: "valid-prefix",
  ownerAgentId: "agentA",
  version: 1,
});
const malformedReceiptPayloads: Array<[string, string]> = [
  ["json", "{"],
  ["envelope", `${JSON.stringify({ version: 99, records: [] })}\n`],
  ["records", `${JSON.stringify({ version: 5, records: {} })}\n`],
  ["record semantics", `${JSON.stringify({ version: 5, records: [{ reminderId: 42 }] })}\n`],
  ["valid prefix then invalid record", `${JSON.stringify({
    version: 5,
    records: [{
      reminderId: validPrefixJob.reminderId,
      ownerAgentId: validPrefixJob.ownerAgentId,
      version: validPrefixJob.version,
      job: null,
      receipts: [makePersistedReceipt(validPrefixJob)],
    }, { reminderId: 42 }],
  })}\n`],
];

test.each(malformedReceiptPayloads)("scoped receipt decode rejects %s exactly once per attempt", (name, payload) => {
  let reports = 0;
  const storage: ScopedAppStorage = {
    assertActive: () => {},
    readText: () => payload,
    writeTextAtomic: () => {},
    reportDataFailure: (reason) => {
      assert.equal(reason, "invalid_payload");
      reports += 1;
    },
  };
  const cache = new ReminderCache({
    storageForAgent: () => storage,
    onFire: () => {},
  });
  cache.start();
  assert.throws(() => cache.snapshot("agentA", []));
  assert.equal(reports, 1, `${name} must emit exactly one typed data-failure event`);
  assert.throws(
    () => cache.snapshot("agentA", []),
    `${name} must remain fail-closed on a second snapshot attempt`,
  );
  assert.equal(reports, 2, `${name} must emit exactly one event per rejected attempt`);
  assert.equal(cache.size(), 0);
  assert.equal(cache.pendingFireReceipts().length, 0);
});

const invalidPhaseJob = makeJob({ reminderId: "phase-provenance-invalid", ownerAgentId: "agentA" });
const invalidPhaseMutations: Array<[
  string,
  (receipt: ReturnType<typeof makePersistedReceipt>) => void,
]> = [
  ["wrong occurrence", (receipt) => {
    const fired = receipt.phaseTruth.fired;
    assert.ok(fired.transition);
    fired.transition.occurrenceId = "another-occurrence";
  }],
  ["wrong source", (receipt) => {
    const fired = receipt.phaseTruth.fired;
    assert.ok(fired.transition);
    fired.transition.source = "notify_inbox" as typeof fired.transition.source;
  }],
  ["future alert-fed phase", (receipt) => {
    Object.assign(receipt.phaseTruth, {
      turn_started: { state: false, evidence: "not_reached", transition: null },
    });
  }],
];

test.each(invalidPhaseMutations)("v6 phase provenance rejects %s", (name, mutate) => {
  const receipt = makePersistedReceipt(invalidPhaseJob);
  mutate(receipt);
  let reports = 0;
  const payload = `${JSON.stringify({
    version: 6,
    records: [{
      reminderId: invalidPhaseJob.reminderId,
      ownerAgentId: invalidPhaseJob.ownerAgentId,
      version: invalidPhaseJob.version,
      job: null,
      receipts: [receipt],
    }],
  })}\n`;
  const storage: ScopedAppStorage = {
    assertActive: () => {},
    readText: () => payload,
    writeTextAtomic: () => {},
    reportDataFailure: (reason) => {
      assert.equal(reason, "invalid_payload");
      reports += 1;
    },
  };
  const cache = new ReminderCache({ storageForAgent: () => storage, onFire: () => {} });
  cache.start();
  assert.throws(() => cache.snapshot("agentA", []), /receipt_invalid/, name);
  assert.equal(reports, 1, name);
});

test("legacy receipt state stays true with typed missing provenance and no invented time", () => {
  const job = makeJob({ reminderId: "legacy-phase-truth", ownerAgentId: "agentA" });
  const current = makePersistedReceipt(job);
  const { phaseTruth: _discarded, ...legacyReceipt } = current;
  legacyReceipt.wakeEnqueued = true;
  const payload = `${JSON.stringify({
    version: 5,
    records: [{
      reminderId: job.reminderId,
      ownerAgentId: job.ownerAgentId,
      version: job.version,
      job: null,
      receipts: [legacyReceipt],
    }],
  })}\n`;
  const storage: ScopedAppStorage = {
    assertActive: () => {},
    readText: () => payload,
    writeTextAtomic: () => {},
    reportDataFailure: () => assert.fail("valid legacy receipt must restore"),
  };
  const cache = new ReminderCache({
    clock: new FakeClock(),
    storageForAgent: () => storage,
    onFire: () => ({ wakeEnqueued: false }),
  });
  cache.start();
  cache.snapshot("agentA", []);
  const [receipt] = cache.pendingFireReceipts();
  assert.ok(receipt);
  for (const phase of REMINDER_BOUNDED_ALERT_PHASES) {
    assert.deepEqual(receipt.phaseTruth[phase], {
      state: true,
      evidence: "transition_provenance_missing",
      transition: null,
    });
  }
  assert.notEqual(
    receipt.phaseTruth.fired.evidence,
    "NOT_OBSERVED_BY_THIS_SEAT",
    "producer-known missing provenance must not collapse into observer query absence",
  );
});

test("authoritative snapshot opens only its named Agent receipt store", () => {
  const opened: string[] = [];
  const cache = new ReminderCache({
    storageForAgent: (agentId) => {
      opened.push(agentId);
      return {
        assertActive: () => {},
        readText: () => null,
        writeTextAtomic: () => {},
        reportDataFailure: () => {},
      };
    },
    onFire: () => {},
  });
  cache.start();
  cache.snapshot("agentA", []);
  assert.deepEqual(opened, ["agentA", "agentA"], "restore and receipt-only persist stay in agentA scope");
  assert.equal(opened.includes("agentB"), false);
});

test("authoritative snapshot rehydrates an overdue current schedule exactly once", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-cache-"));
  const persistencePath = path.join(dir, "mirror.json");
  const job = makeJob({
    reminderId: "r-durable",
    ownerAgentId: "agentA",
    version: 3,
    fireAt: new Date(30_000).toISOString(),
  });
  try {
    const secondClock = new FakeClock();
    secondClock.advanceBy(60_000);
    const receipts: Array<{ id: string; catchup: boolean }> = [];
    const restored = new ReminderCache({
      clock: secondClock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      onFire: (fired, context) => { receipts.push({ id: fired.reminderId, catchup: context.catchup }); },
    });
    restored.start();
    restored.snapshot("agentA", [job]);
    secondClock.advanceBy(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(receipts, [{ id: "r-durable", catchup: true }]);
    assert.equal(restored.ackFireReceipt(createReminderDueIdentity({
      ownerAgentId: "agentA",
      reminderId: "r-durable",
      version: 3,
    })), true);

    const thirdClock = new FakeClock();
    thirdClock.advanceBy(120_000);
    const replayed: string[] = [];
    const third = new ReminderCache({
      clock: thirdClock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      onFire: (fired) => { replayed.push(fired.reminderId); },
    });
    third.start();
    third.snapshot("agentA", [job]);
    thirdClock.advanceBy(0);
    assert.deepEqual(replayed, []);
    assert.equal(third.upsert(job), "stale");
    thirdClock.advanceBy(0);
    assert.deepEqual(replayed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graceful stop still requires a fresh snapshot before rearming", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-cache-stop-"));
  const persistencePath = path.join(dir, "mirror.json");
  const job = makeJob({
    reminderId: "r-graceful-stop",
    ownerAgentId: "agentA",
    version: 2,
    fireAt: new Date(30_000).toISOString(),
  });
  try {
    const firstClock = new FakeClock();
    const first = new ReminderCache({
      clock: firstClock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      onFire: () => {},
    });
    first.start();
    first.snapshot("agentA", [job]);
    first.stop();

    const restartClock = new FakeClock();
    restartClock.advanceBy(60_000);
    const fired: string[] = [];
    const restarted = new ReminderCache({
      clock: restartClock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      onFire: (due) => { fired.push(due.reminderId); },
    });
    restarted.start();
    restartClock.advanceBy(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fired, [], "offline restart cannot restore the old schedule");
    restarted.snapshot("agentA", [job]);
    restartClock.advanceBy(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fired, [job.reminderId], "fresh Server snapshot rehydrates the current schedule");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crash after durable pending-fire commit but before item mint recovers materialization", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-fire-outbox-"));
  const persistencePath = path.join(dir, "mirror.json");
  const job = makeJob({
    reminderId: "11111111-1111-4111-8111-111111111111",
    ownerAgentId: "agentA",
    version: 9,
    fireAt: new Date(10_000).toISOString(),
  });
  try {
    const clock = new FakeClock();
    let firstMaterializations = 0;
    const first = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      onFire: () => { firstMaterializations += 1; },
      afterFireCommitForTesting: () => { throw new Error("CRASH_AFTER_FIRE_COMMIT"); },
    });
    first.start();
    first.snapshot(job.ownerAgentId, []);
    first.upsert(job);
    assert.throws(() => clock.advanceBy(10_000), /CRASH_AFTER_FIRE_COMMIT/);
    assert.equal(firstMaterializations, 0);
    assert.equal(first.pendingFireReceipts().length, 1);

    const inbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      storage: createInboxStorage(dir),
    });
    let recoveredWakes = 0;
    const restarted = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      onFire: (fired) => {
        mintReminderItem(inbox, fired);
        recoveredWakes += 1;
      },
    });
    restarted.start();
    restarted.snapshot(job.ownerAgentId, []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recoveredWakes, 1, "restart recovery emits an eventual local wake");
    assert.deepEqual(inbox.list().map((item) => item.itemId), [
      "reminder:11111111-1111-4111-8111-111111111111:9",
    ]);
    assert.equal(restarted.pendingFireReceipts().length, 1, "receipt remains until Server ack");
    assert.equal(restarted.ackFireReceipt(createReminderDueIdentity({
      ownerAgentId: job.ownerAgentId,
      reminderId: job.reminderId,
      version: 9,
    })), true);
    assert.equal(restarted.pendingFireReceipts().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crash after item mint but before wake completion replays one item and eventually wakes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-fire-idempotency-"));
  const mirrorPath = path.join(dir, "mirror.json");
  const job = makeJob({
    reminderId: "22222222-2222-4222-8222-222222222222",
    ownerAgentId: "agentA",
    version: 7,
    fireAt: new Date(10_000).toISOString(),
  });
  try {
    const clock = new FakeClock();
    const firstInbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      storage: createInboxStorage(dir),
    });
    const first = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(mirrorPath),
      onFire: (fired) => {
        mintReminderItem(firstInbox, fired);
        throw new Error("CRASH_AFTER_ITEM_MINT");
      },
    });
    first.start();
    first.snapshot(job.ownerAgentId, []);
    first.upsert(job);
    clock.advanceBy(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(firstInbox.list().map((item) => item.itemId), [
      "reminder:22222222-2222-4222-8222-222222222222:7",
    ]);
    assert.equal(first.pendingFireReceipts().length, 1, "simulated crash leaves local wake incomplete");

    // A new process restores both durable stores. Pending-fire recovery mints
    // again, but the app-owned itemId converges to the already persisted item.
    const restartedInbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      storage: createInboxStorage(dir),
    });
    let recoveryMaterializations = 0;
    let recoveryWakes = 0;
    const restarted = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(mirrorPath),
      onFire: (fired, context) => {
        mintReminderItem(restartedInbox, fired);
        recoveryMaterializations += 1;
        if (!context.wakeEnqueued) recoveryWakes += 1;
        return { wakeEnqueued: true };
      },
    });
    restarted.start();
    restarted.snapshot(job.ownerAgentId, []);
    clock.advanceBy(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recoveryMaterializations, 1);
    assert.equal(recoveryWakes, 1, "pending local wake is replayed after restart");
    assert.deepEqual(restartedInbox.list().map((item) => item.itemId), [
      "reminder:22222222-2222-4222-8222-222222222222:7",
    ]);
    await new Promise((resolve) => setImmediate(resolve));

    const thirdInbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      storage: createInboxStorage(dir),
    });
    let thirdWakeAttempts = 0;
    const third = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(mirrorPath),
      onFire: (fired, context) => {
        mintReminderItem(thirdInbox, fired);
        if (!context.wakeEnqueued) thirdWakeAttempts += 1;
        return { wakeEnqueued: true };
      },
    });
    third.start();
    third.snapshot(job.ownerAgentId, []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(thirdWakeAttempts, 0, "durable local wake receipt bounds replay");
    assert.deepEqual(thirdInbox.list().map((item) => item.itemId), [
      "reminder:22222222-2222-4222-8222-222222222222:7",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Server ack cannot discard a still-pending local wake, which retries without restart", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-wake-retry-"));
  const persistencePath = path.join(dir, "mirror.json");
  const clock = new FakeClock();
  const job = makeJob({
    reminderId: "33333333-3333-4333-8333-333333333333",
    ownerAgentId: "agentA",
    version: 4,
    fireAt: new Date(10_000).toISOString(),
  });
  let attempts = 0;
  try {
    const cache = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      fireRetryDelayMs: 1_000,
      onFire: (_fired, context) => {
        attempts += 1;
        assert.equal(context.serverAcked, attempts > 1);
        return { wakeEnqueued: attempts > 1 };
      },
    });
    cache.start();
    cache.snapshot(job.ownerAgentId, []);
    cache.upsert(job);
    clock.advanceBy(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);

    assert.equal(cache.ackFireReceipt(createReminderDueIdentity({
      ownerAgentId: job.ownerAgentId,
      reminderId: job.reminderId,
      version: job.version,
    })), true);
    assert.equal(cache.pendingFireReceipts().length, 0, "remote replay stops after Server ack");

    clock.advanceBy(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2, "local wake retries even though remote convergence is already acked");
    assert.equal(cache.ackLocalItem(createReminderDueIdentity({
      ownerAgentId: job.ownerAgentId,
      reminderId: job.reminderId,
      version: job.version,
    })), true, "source read retires the fully-converged durable receipt");
    assert.equal(cache.ackFireReceipt(createReminderDueIdentity({
      ownerAgentId: job.ownerAgentId,
      reminderId: job.reminderId,
      version: job.version,
    })), false, "receipt retires after both sides complete");

    const restarted = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      onFire: () => { throw new Error("completed receipt must not replay"); },
    });
    restarted.start();
    restarted.snapshot(job.ownerAgentId, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source-read ack survives restart while Server receipt remains blocked", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-source-ack-"));
  const mirrorPath = path.join(dir, "mirror.json");
  const clock = new FakeClock();
  const job = makeJob({
    reminderId: "55555555-5555-4555-8555-555555555555",
    ownerAgentId: "agentA",
    version: 6,
    fireAt: new Date(10_000).toISOString(),
  });
  try {
    let first!: ReminderCache;
    const firstInbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      storage: createInboxStorage(dir),
      beforeAck: (item) => {
        first.ackLocalItem(createReminderDueIdentity({
          ownerAgentId: job.ownerAgentId,
          reminderId: item.sourceRef.id,
          version: Number(item.sourceRef.revision),
        }));
      },
    });
    first = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(mirrorPath),
      onFire: (fired) => {
        mintReminderItem(firstInbox, fired);
        return { wakeEnqueued: true };
      },
    });
    first.start();
    first.snapshot(job.ownerAgentId, []);
    first.upsert(job);
    clock.advanceBy(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    const [item] = firstInbox.list();
    assert.ok(item);
    assert.equal(firstInbox.ack(item.itemId), true, "successful source read acknowledges the item");
    assert.deepEqual(firstInbox.list(), []);
    assert.equal(first.pendingFireReceipts().length, 1, "Server receipt is still blocked");
    first.stop();

    let rematerialized = 0;
    const restartedInbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      storage: createInboxStorage(dir),
    });
    const restarted = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(mirrorPath),
      onFire: (fired, context) => {
        assert.equal(context.itemConsumed, true);
        restartedInbox.ack(`reminder:${fired.reminderId}:${fired.version}`);
        rematerialized += 1;
        return { wakeEnqueued: true };
      },
    });
    restarted.start();
    restarted.snapshot(job.ownerAgentId, []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rematerialized, 1, "producer receipt still converges remotely after restart");
    assert.deepEqual(restartedInbox.list(), [], "source-read item must not resurrect");
    assert.equal(restarted.ackFireReceipt(createReminderDueIdentity({
      ownerAgentId: job.ownerAgentId,
      reminderId: job.reminderId,
      version: job.version,
    })), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source-read ack retires only its exact converged receipt and preserves the current recurring schedule", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-source-ack-range-"));
  const mirrorPath = path.join(dir, "mirror.json");
  const clock = new FakeClock();
  const reminderId = "77777777-7777-4777-8777-777777777777";
  let cache!: ReminderCache;
  try {
    const inbox = createAgentAppInboxStore({
      registry: REMINDER_AGENT_INBOX_REGISTRY,
      storage: createInboxStorage(dir),
      beforeAck: (item) => {
        assert.equal(cache.ackLocalItem(createReminderDueIdentity({
          ownerAgentId: "agentA",
          reminderId: item.sourceRef.id,
          version: Number(item.sourceRef.revision),
        })), true);
      },
    });
    cache = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(mirrorPath),
      onFire: (fired) => {
        mintReminderItem(inbox, fired);
        return { wakeEnqueued: true };
      },
    });
    cache.start();
    cache.snapshot("agentA", []);

    const first = makeJob({
      reminderId,
      ownerAgentId: "agentA",
      version: 1,
      fireAt: new Date(10_000).toISOString(),
    });
    const second = makeJob({
      reminderId,
      ownerAgentId: "agentA",
      version: 2,
      fireAt: new Date(20_000).toISOString(),
    });
    const current = makeJob({
      reminderId,
      ownerAgentId: "agentA",
      version: 3,
      fireAt: new Date(120_000).toISOString(),
      recurrence: { kind: "daily", description: "daily" },
    });

    const firstReceipt = await fireAndConvergeReceipt(cache, clock, first, 10_000);
    const secondReceipt = await fireAndConvergeReceipt(cache, clock, second, 10_000);
    assert.equal(firstReceipt.serverAcked && firstReceipt.wakeEnqueued, true);
    assert.equal(secondReceipt.serverAcked && secondReceipt.wakeEnqueued, true);
    assert.deepEqual(inbox.list().map((item) => item.itemId).sort(), [
      `reminder:${reminderId}:1`,
      `reminder:${reminderId}:2`,
    ]);

    assert.equal(cache.upsert(current), "applied");
    assert.deepEqual(cache.getJob(reminderId), current);

    assert.equal(inbox.ack(`reminder:${reminderId}:1`), true);
    assert.deepEqual(inbox.list().map((item) => item.itemId), [
      `reminder:${reminderId}:2`,
    ]);
    assert.deepEqual(cache.getJob(reminderId), current, "ACK must not move the current recurring schedule");
    assert.equal(cache.ackLocalItem(createReminderDueIdentity({
      ownerAgentId: second.ownerAgentId,
      reminderId: second.reminderId,
      version: second.version,
    })), true, "sibling converged receipt remains independently acknowledgeable");
    assert.deepEqual(cache.getJob(reminderId), current, "sibling ACK also leaves the current recurring schedule intact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pending historical receipt survives owner rebind and durable restart", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-owner-rebind-"));
  const storageForAgent = (agentId: string) =>
    createTestReminderStorage(path.join(dir, `${agentId}.json`));
  const clock = new FakeClock();
  const reminderId = "44444444-4444-4444-8444-444444444444";
  try {
    const cache = new ReminderCache({
      clock,
      storageForAgent,
      onFire: () => {},
    });
    cache.start();
    cache.snapshot("old-owner", []);
    cache.snapshot("new-owner", []);
    cache.upsert(makeJob({
      reminderId,
      ownerAgentId: "old-owner",
      version: 1,
      fireAt: new Date(10_000).toISOString(),
    }));
    clock.advanceBy(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    cache.upsert(makeJob({
      reminderId,
      ownerAgentId: "new-owner",
      version: 2,
      fireAt: new Date(20_000).toISOString(),
    }));
    cache.stop();

    const restored = new ReminderCache({
      clock,
      storageForAgent,
      onFire: () => {},
    });
    restored.start();
    restored.snapshot("old-owner", []);
    restored.snapshot("new-owner", [makeJob({
      reminderId,
      ownerAgentId: "new-owner",
      version: 2,
      fireAt: new Date(20_000).toISOString(),
    })]);
    assert.equal(restored.getJob(reminderId)?.ownerAgentId, "new-owner");
    assert.deepEqual(
      restored.pendingFireReceipts().map((receipt) => [receipt.job.ownerAgentId, receipt.job.version]),
      [["old-owner", 1]],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new-owner snapshot preserves an older committed due receipt", async () => {
  const clock = new FakeClock();
  const fires: Array<{ ownerAgentId: string; version: number }> = [];
  const cache = new ReminderCache({
    clock,
    onFire: async (job) => {
      fires.push({ ownerAgentId: job.ownerAgentId, version: job.version });
      return { wakeEnqueued: false };
    },
  });
  cache.start();
  cache.snapshot("agent-a", []);
  cache.upsert(makeJob({ reminderId: "owner-snapshot", ownerAgentId: "agent-a", version: 7, fireAt: new Date(5).toISOString() }));
  clock.advanceBy(5);
  await new Promise((resolve) => setImmediate(resolve));

  cache.snapshot("agent-b", [
    makeJob({ reminderId: "owner-snapshot", ownerAgentId: "agent-b", version: 8, fireAt: new Date(50).toISOString() }),
  ]);

  assert.deepEqual(cache.pendingFireReceipts().map((receipt) => [receipt.job.ownerAgentId, receipt.job.version]), [
    ["agent-a", 7],
  ]);
  assert.equal(cache.getJob("owner-snapshot")?.ownerAgentId, "agent-b");
  assert.equal(cache.getJob("owner-snapshot")?.version, 8);
  assert.deepEqual(fires, [{ ownerAgentId: "agent-a", version: 7 }]);
});

test("stale prior-owner snapshot cannot overwrite a newer owner rebind", () => {
  const clock = new FakeClock();
  const cache = new ReminderCache({ clock, onFire: () => {} });
  cache.start();
  cache.upsert(makeJob({ reminderId: "owner-snapshot-stale", ownerAgentId: "agent-b", version: 8, fireAt: new Date(50).toISOString() }));

  cache.snapshot("agent-a", [
    makeJob({ reminderId: "owner-snapshot-stale", ownerAgentId: "agent-a", version: 7, fireAt: new Date(10).toISOString() }),
  ]);

  assert.equal(cache.getJob("owner-snapshot-stale")?.ownerAgentId, "agent-b");
  assert.equal(cache.getJob("owner-snapshot-stale")?.version, 8);
});

test("same-Computer owner transfer converges for cancel-then-upsert delivery", () => {
  const clock = new FakeClock();
  const cache = new ReminderCache({ clock, onFire: () => {} });
  cache.start();
  cache.snapshot("agent-a", []);
  cache.upsert(makeJob({
    reminderId: "owner-transfer-a",
    ownerAgentId: "agent-a",
    version: 7,
    fireAt: new Date(50).toISOString(),
  }));

  assert.equal(cache.cancel("owner-transfer-a", 8, "agent-a"), "applied");
  assert.equal(cache.upsert(makeJob({
    reminderId: "owner-transfer-a",
    ownerAgentId: "agent-b",
    version: 8,
    fireAt: new Date(100).toISOString(),
  })), "applied");
  assert.equal(cache.getJob("owner-transfer-a")?.ownerAgentId, "agent-b");
  assert.equal(cache.getJob("owner-transfer-a")?.version, 8);
});

test("same-Computer owner transfer converges for upsert-then-cancel delivery", () => {
  const clock = new FakeClock();
  const cache = new ReminderCache({ clock, onFire: () => {} });
  cache.start();
  cache.snapshot("agent-a", []);
  cache.upsert(makeJob({
    reminderId: "owner-transfer-b",
    ownerAgentId: "agent-a",
    version: 7,
    fireAt: new Date(50).toISOString(),
  }));

  assert.equal(cache.upsert(makeJob({
    reminderId: "owner-transfer-b",
    ownerAgentId: "agent-b",
    version: 8,
    fireAt: new Date(100).toISOString(),
  })), "applied");
  assert.equal(cache.cancel("owner-transfer-b", 8, "agent-a"), "stale");
  assert.equal(cache.getJob("owner-transfer-b")?.ownerAgentId, "agent-b");
  assert.equal(cache.getJob("owner-transfer-b")?.version, 8);
});

test("equal-version owner transfer cannot reuse the prior owner's fire receipt as an armed upsert", async () => {
  const clock = new FakeClock();
  const cache = new ReminderCache({ clock, onFire: () => {} });
  cache.start();
  cache.snapshot("agent-a", []);
  cache.snapshot("agent-b", []);
  cache.upsert(makeJob({
    reminderId: "owner-transfer-receipt-upsert",
    ownerAgentId: "agent-a",
    version: 8,
    fireAt: new Date(5).toISOString(),
  }));
  clock.advanceBy(5);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cache.upsert(makeJob({
    reminderId: "owner-transfer-receipt-upsert",
    ownerAgentId: "agent-b",
    version: 8,
    fireAt: "invalid-fire-at",
  })), "applied");
  assert.equal(cache.getJob("owner-transfer-receipt-upsert")?.ownerAgentId, "agent-b");
  assert.equal(
    cache.isArmed(createReminderDueIdentity({
      ownerAgentId: "agent-b",
      reminderId: "owner-transfer-receipt-upsert",
      version: 8,
    })),
    false,
    "a historical receipt from the old owner cannot arm the new owner's invalid job",
  );
});

test("equal-version owner transfer cannot reuse the prior owner's fire receipt as an armed snapshot", async () => {
  const clock = new FakeClock();
  const cache = new ReminderCache({ clock, onFire: () => {} });
  cache.start();
  cache.snapshot("agent-a", []);
  cache.snapshot("agent-b", []);
  cache.upsert(makeJob({
    reminderId: "owner-transfer-receipt-snapshot",
    ownerAgentId: "agent-a",
    version: 8,
    fireAt: new Date(5).toISOString(),
  }));
  clock.advanceBy(5);
  await new Promise((resolve) => setImmediate(resolve));

  cache.snapshot("agent-b", [makeJob({
    reminderId: "owner-transfer-receipt-snapshot",
    ownerAgentId: "agent-b",
    version: 8,
    fireAt: "invalid-fire-at",
  })]);
  assert.equal(cache.getJob("owner-transfer-receipt-snapshot")?.ownerAgentId, "agent-b");
  assert.equal(
    cache.isArmed(createReminderDueIdentity({
      ownerAgentId: "agent-b",
      reminderId: "owner-transfer-receipt-snapshot",
      version: 8,
    })),
    false,
    "snapshot convergence must apply the same owner fence as an upsert",
  );
});

test("equal-version owner receipts dispatch, retry, consume, and restart independently", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-owner-receipt-identity-"));
  const storageForAgent = (agentId: string) =>
    createTestReminderStorage(path.join(dir, `${agentId}.json`));
  const clock = new FakeClock();
  const reminderId = "66666666-6666-4666-8666-666666666666";
  const owners = ["old-owner", "new-owner"] as const;
  const attempts = new Map<string, number>();
  const inboxes = new Map<string, AgentAppInboxStore>();
  let cache!: ReminderCache;
  try {
    for (const ownerAgentId of owners) {
      inboxes.set(ownerAgentId, createAgentAppInboxStore({
        registry: REMINDER_AGENT_INBOX_REGISTRY,
        storage: createInboxStorage(dir, ownerAgentId),
        beforeAck: (item) => {
          cache.ackLocalItem(createReminderDueIdentity({
            ownerAgentId,
            reminderId: item.sourceRef.id,
            version: Number(item.sourceRef.revision),
          }));
        },
      }));
    }
    cache = new ReminderCache({
      clock,
      storageForAgent,
      fireRetryDelayMs: 20,
      onFire: (job, context) => {
        attempts.set(job.ownerAgentId, (attempts.get(job.ownerAgentId) ?? 0) + 1);
        if (!context.itemConsumed) mintReminderItem(inboxes.get(job.ownerAgentId)!, job);
        return { wakeEnqueued: false };
      },
    });
    cache.start();
    for (const ownerAgentId of owners) cache.snapshot(ownerAgentId, []);
    cache.upsert(makeJob({
      reminderId,
      ownerAgentId: owners[0],
      version: 8,
      fireAt: new Date(5).toISOString(),
    }));
    clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));

    cache.upsert(makeJob({
      reminderId,
      ownerAgentId: owners[1],
      version: 8,
      fireAt: new Date(10).toISOString(),
    }));
    clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      cache.pendingFireReceipts().map((receipt) => receipt.job.ownerAgentId),
      owners,
      "same reminder revision retains one pending receipt per owner",
    );
    assert.deepEqual(
      owners.map((owner) => inboxes.get(owner)!.list().length),
      [1, 1],
      "owner-scoped stores may each materialize the same stable item id",
    );
    assert.equal(
      inboxes.get(owners[0])!.list()[0]?.itemId,
      inboxes.get(owners[1])!.list()[0]?.itemId,
      "owner isolation does not change the stable wire item identity",
    );

    clock.advanceBy(20);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      owners.map((owner) => attempts.get(owner)),
      [2, 2],
      "one owner's retry key cannot starve the other owner's equal-version receipt",
    );
    assert.deepEqual(owners.map((owner) => inboxes.get(owner)!.list().length), [1, 1]);

    const [newOwnerItem] = inboxes.get(owners[1])!.list();
    assert.ok(newOwnerItem);
    assert.equal(inboxes.get(owners[1])!.ack(newOwnerItem.itemId), true);
    assert.deepEqual(
      cache.pendingFireReceipts().map((receipt) => [
        receipt.job.ownerAgentId,
        receipt.itemConsumed,
      ]),
      [[owners[0], false], [owners[1], true]],
      "source-read handoff consumes only the matching owner receipt",
    );
    cache.stop();

    const restartedContexts: Array<[string, boolean]> = [];
    cache = new ReminderCache({
      clock,
      storageForAgent,
      fireRetryDelayMs: 20,
      onFire: (job, context) => {
        restartedContexts.push([job.ownerAgentId, context.itemConsumed]);
        if (!context.itemConsumed) mintReminderItem(inboxes.get(job.ownerAgentId)!, job);
        return { wakeEnqueued: false };
      },
    });
    cache.start();
    for (const ownerAgentId of owners) cache.snapshot(ownerAgentId, []);
    clock.advanceBy(40);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(restartedContexts, [[owners[0], false], [owners[1], true]]);
    assert.equal(inboxes.get(owners[0])!.list().length, 1);
    assert.equal(inboxes.get(owners[1])!.list().length, 0, "consumed new-owner item stays absent");
    cache.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistent pre-Server failure exhausts the per-receipt cap and stops", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-retry-cap-"));
  const persistencePath = path.join(dir, "mirror.json");
  const clock = new FakeClock();
  const exhaustions: unknown[] = [];
  let attempts = 0;
  try {
    const cache = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      fireRetryDelayMs: 10,
      fireRetryMaxDelayMs: 40,
      fireRetryMaxAttempts: 3,
      fireRetryDeadlineMs: 1_000,
      onRetryExhausted: (exhaustion) => exhaustions.push(exhaustion),
      onFire: () => {
        attempts += 1;
        return { wakeEnqueued: false, retryStage: "fire_request" };
      },
    });
    cache.start();
    cache.snapshot("agent-a", []);
    cache.upsert(makeJob({
      reminderId: "retry-cap",
      ownerAgentId: "agent-a",
      fireAt: new Date(5).toISOString(),
    }));
    clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));
    clock.advanceBy(10);
    await new Promise((resolve) => setImmediate(resolve));
    clock.advanceBy(20);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(attempts, 3);
    assert.equal(clock.pendingTimerCount(), 0, "cap exhaustion leaves no process-local replay loop");
    assert.equal(cache.pendingFireReceipts().length, 0, "terminal receipts are not transport-replayed");
    assert.deepEqual(exhaustions, [{
      code: "REMINDER_DELIVERY_RETRY_EXHAUSTED",
      stage: "fire_request",
      ownerAgentId: "agent-a",
      reminderId: "retry-cap",
      version: 1,
      requestId: JSON.parse(readFileSync(persistencePath, "utf8")).records[0].receipts[0].requestId,
      attempts: 3,
      deadlineAt: new Date(1_005).toISOString(),
      exhaustedAt: new Date(35).toISOString(),
    }]);
    assert.equal(
      JSON.parse(readFileSync(persistencePath, "utf8")).records[0].receipts[0].retryTerminal.code,
      "REMINDER_DELIVERY_RETRY_EXHAUSTED",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("post-Server materialization exhaustion stays durable while the next recurrence remains independent", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-materialization-durable-"));
  const persistencePath = path.join(dir, "mirror.json");
  const clock = new FakeClock();
  const exhaustions: unknown[] = [];
  let materializationAvailable = false;
  let materializationAttempts = 0;
  let acceptedWakes = 0;
  let fireRequests = 0;
  try {
    const cache = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      fireRetryDelayMs: 10,
      fireRetryMaxDelayMs: 40,
      fireRetryMaxAttempts: 3,
      fireRetryDeadlineMs: 1_000,
      onRetryExhausted: (exhaustion) => exhaustions.push(exhaustion),
      onFire: (_job, context) => {
        if (!context.serverAcked) {
          fireRequests += 1;
          return { wakeEnqueued: false, retryStage: "fire_request" };
        }
        materializationAttempts += 1;
        if (!materializationAvailable) {
          return { wakeEnqueued: false, retryStage: "inbox_materialization" };
        }
        acceptedWakes += 1;
        return { wakeEnqueued: true };
      },
    });
    cache.start();
    cache.snapshot("agent-a", []);
    const first = makeJob({
      reminderId: "materialization-durable",
      ownerAgentId: "agent-a",
      version: 1,
      fireAt: new Date(5).toISOString(),
      recurrence: { kind: "interval", description: "every 15 minutes" },
    });
    cache.upsert(first);
    clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));
    const [receipt] = cache.pendingFireReceipts();
    assert.ok(receipt);
    assert.equal(fireRequests, 1);

    const firstIdentity = createReminderDueIdentity({
      ownerAgentId: first.ownerAgentId,
      reminderId: first.reminderId,
      version: first.version,
    });
    assert.equal(cache.acceptFireRequest(firstIdentity, receipt.requestId, {
      fired: true,
      catchup: true,
    }), true);
    await new Promise((resolve) => setImmediate(resolve));
    clock.advanceBy(20);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(materializationAttempts, 2);
    assert.equal(exhaustions.length, 1, "the bounded alert still fires exactly once");
    assert.equal(receipt.retryTerminal?.stage, "inbox_materialization");
    assert.equal(receipt.wakeEnqueued, false);
    assert.equal(clock.pendingTimerCount(), 1, "the unresolved old occurrence keeps a capped replay timer");

    const successor = makeJob({
      reminderId: first.reminderId,
      ownerAgentId: first.ownerAgentId,
      version: 2,
      fireAt: new Date(200).toISOString(),
      recurrence: first.recurrence,
    });
    assert.equal(cache.upsert(successor), "applied");
    assert.equal(clock.pendingTimerCount(), 2, "old delivery and next recurrence use separate timers");

    materializationAvailable = true;
    clock.advanceBy(40);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(materializationAttempts, 3);
    assert.equal(acceptedWakes, 1, "recovery accepts exactly one wake");
    assert.equal(receipt.wakeEnqueued, true);
    assert.equal(receipt.retryTerminal, null, "recovered outbox state no longer claims a live terminal failure");
    assert.equal(clock.pendingTimerCount(), 1, "recovery cannot cancel the successor recurrence timer");

    clock.advanceBy(135);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fireRequests, 2, "the independently scheduled successor reaches its own Server request");
    assert.deepEqual(
      cache.pendingFireReceipts().map((pending) => pending.job.version),
      [2],
      "the successor owns a distinct due identity",
    );
    const persisted = JSON.parse(readFileSync(persistencePath, "utf8"));
    assert.deepEqual(
      persisted.records[0].receipts.map((pending: { job: { version: number }; wakeEnqueued: boolean }) => [
        pending.job.version,
        pending.wakeEnqueued,
      ]),
      [[1, true], [2, false]],
      "the recovered predecessor and pending successor cannot overwrite one another",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart replays a legacy inbox-materialization exhaustion without burying the newer schedule", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-materialization-restart-"));
  const persistencePath = path.join(dir, "mirror.json");
  const clock = new FakeClock();
  clock.advanceBy(1_000);
  const oldJob = makeJob({
    reminderId: "materialization-restart",
    ownerAgentId: "agent-a",
    version: 7,
    fireAt: new Date(5).toISOString(),
    recurrence: { kind: "interval", description: "every 15 minutes" },
  });
  const oldReceipt = {
    ...makePersistedReceipt(oldJob),
    requestId: "request-materialization-restart",
    firedAtClient: new Date(10).toISOString(),
    catchup: true,
    serverAcked: true,
    serverFired: true,
    retryAttempt: 8,
    retryDeadlineAt: new Date(900).toISOString(),
    retryTerminal: {
      code: "REMINDER_DELIVERY_RETRY_EXHAUSTED",
      stage: "inbox_materialization",
      ownerAgentId: oldJob.ownerAgentId,
      reminderId: oldJob.reminderId,
      version: oldJob.version,
      requestId: "request-materialization-restart",
      attempts: 8,
      deadlineAt: new Date(900).toISOString(),
      exhaustedAt: new Date(900).toISOString(),
    },
    phaseTruth: createReminderPhaseTruth({
      occurrenceId: "request-materialization-restart",
      firedAtClient: new Date(10).toISOString(),
    }),
  };
  writeFileSync(persistencePath, `${JSON.stringify({
    version: 6,
    records: [{
      reminderId: oldJob.reminderId,
      ownerAgentId: oldJob.ownerAgentId,
      version: oldJob.version,
      job: null,
      receipts: [oldReceipt],
    }],
  })}\n`);

  let recovered = 0;
  let successorRequests = 0;
  try {
    const cache = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      fireRetryMaxAttempts: 8,
      fireRetryDeadlineMs: 100,
      onFire: (job, context) => {
        if (!context.serverAcked) {
          successorRequests += 1;
          return { wakeEnqueued: false, retryStage: "fire_request" };
        }
        assert.equal(job.version, 7);
        assert.equal(context.requestId, oldReceipt.requestId);
        recovered += 1;
        return { wakeEnqueued: true };
      },
    });
    cache.start();
    cache.snapshot("agent-a", [makeJob({
      reminderId: oldJob.reminderId,
      ownerAgentId: oldJob.ownerAgentId,
      version: 8,
      fireAt: new Date(2_000).toISOString(),
      recurrence: oldJob.recurrence,
    })]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recovered, 1, "startup resumes the previously buried delivery obligation");
    const persistedAfterRecovery = JSON.parse(readFileSync(persistencePath, "utf8"));
    assert.equal(persistedAfterRecovery.records[0].receipts[0].wakeEnqueued, true);
    assert.equal(persistedAfterRecovery.records[0].receipts[0].retryTerminal, null);
    assert.equal(clock.pendingTimerCount(), 1, "the future successor remains armed after recovery");

    clock.advanceBy(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(successorRequests, 1, "ordinary future-due scheduling remains live in the same cache");
    assert.deepEqual(cache.pendingFireReceipts().map((receipt) => receipt.job.version), [8]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transient delivery failure recovers within exponential bounds", async () => {
  const clock = new FakeClock();
  let attempts = 0;
  let exhausted = false;
  const cache = new ReminderCache({
    clock,
    fireRetryDelayMs: 10,
    fireRetryMaxDelayMs: 40,
    fireRetryMaxAttempts: 4,
    fireRetryDeadlineMs: 1_000,
    onRetryExhausted: () => { exhausted = true; },
    onFire: () => {
      attempts += 1;
      return { wakeEnqueued: attempts === 3, retryStage: "inbox_materialization" };
    },
  });
  cache.start();
  cache.snapshot("agent-a", []);
  cache.upsert(makeJob({
    reminderId: "retry-transient",
    ownerAgentId: "agent-a",
    fireAt: new Date(5).toISOString(),
  }));
  clock.advanceBy(5);
  await new Promise((resolve) => setImmediate(resolve));
  clock.advanceBy(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  clock.advanceBy(9);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2, "the second retry must not collapse back to the initial delay");
  clock.advanceBy(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2, "fixed-delay retry would have fired at the old cadence");
  clock.advanceBy(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 3);
  assert.equal(exhausted, false);
  assert.equal(clock.pendingTimerCount(), 0);
});

test("restart preserves retry delay, attempt count, and deadline", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-retry-restart-"));
  const persistencePath = path.join(dir, "mirror.json");
  const clock = new FakeClock();
  let attempts = 0;
  let exhaustionAttempts = 0;
  const options = () => ({
    clock,
    storageForAgent: () => createTestReminderStorage(persistencePath),
    fireRetryDelayMs: 10,
    fireRetryMaxDelayMs: 40,
    fireRetryMaxAttempts: 3,
    fireRetryDeadlineMs: 1_000,
    onRetryExhausted: (exhaustion: { attempts: number }) => { exhaustionAttempts = exhaustion.attempts; },
    onFire: () => {
      attempts += 1;
      return { wakeEnqueued: false, retryStage: "fire_request" as const };
    },
  });
  try {
    let cache = new ReminderCache(options());
    cache.start();
    cache.snapshot("agent-a", []);
    cache.upsert(makeJob({
      reminderId: "retry-restart",
      ownerAgentId: "agent-a",
      fireAt: new Date(5).toISOString(),
    }));
    clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
    cache.stop();

    cache = new ReminderCache(options());
    cache.start();
    cache.snapshot("agent-a", []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1, "restart cannot bypass the durable next-at delay");
    clock.advanceBy(10);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2);
    cache.stop();

    cache = new ReminderCache(options());
    cache.start();
    cache.snapshot("agent-a", []);
    clock.advanceBy(19);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2);
    clock.advanceBy(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 3);
    assert.equal(exhaustionAttempts, 3, "the third failure exhausts the durable shared budget");
    assert.equal(clock.pendingTimerCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("absolute retry deadline survives restart and stops before the attempt cap", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-retry-deadline-"));
  const persistencePath = path.join(dir, "mirror.json");
  const clock = new FakeClock();
  const exhaustions: Array<{ attempts: number; deadlineAt: string; exhaustedAt: string }> = [];
  let attempts = 0;
  const options = () => ({
    clock,
    storageForAgent: () => createTestReminderStorage(persistencePath),
    fireRetryDelayMs: 10,
    fireRetryMaxDelayMs: 40,
    // Keep the count ceiling deliberately out of reach: this tooth must be
    // carried by the absolute deadline, never by the attempt cap.
    fireRetryMaxAttempts: 100,
    fireRetryDeadlineMs: 25,
    onRetryExhausted: (exhaustion: { attempts: number; deadlineAt: string; exhaustedAt: string }) => {
      exhaustions.push(exhaustion);
    },
    onFire: () => {
      attempts += 1;
      return { wakeEnqueued: false, retryStage: "fire_request" as const };
    },
  });

  try {
    let cache = new ReminderCache(options());
    cache.start();
    cache.snapshot("agent-a", []);
    cache.upsert(makeJob({
      reminderId: "retry-deadline",
      ownerAgentId: "agent-a",
      fireAt: new Date(5).toISOString(),
    }));
    clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
    const firstReceipt = JSON.parse(readFileSync(persistencePath, "utf8")).records[0].receipts[0];
    assert.equal(firstReceipt.retryNextAttemptAt, new Date(15).toISOString());
    assert.equal(firstReceipt.retryDeadlineAt, new Date(30).toISOString());
    cache.stop();

    cache = new ReminderCache(options());
    cache.start();
    cache.snapshot("agent-a", []);
    clock.advanceBy(10);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2);
    const secondReceipt = JSON.parse(readFileSync(persistencePath, "utf8")).records[0].receipts[0];
    assert.equal(secondReceipt.retryNextAttemptAt, new Date(30).toISOString());
    assert.equal(secondReceipt.retryDeadlineAt, new Date(30).toISOString());
    cache.stop();

    cache = new ReminderCache(options());
    cache.start();
    cache.snapshot("agent-a", []);
    clock.advanceBy(14);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2, "restored retry cannot run before the original absolute deadline");
    clock.advanceBy(1);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(attempts, 2, "deadline exhaustion stops before a third external side effect");
    assert.equal(exhaustions.length, 1);
    assert.deepEqual({
      attempts: exhaustions[0]?.attempts,
      deadlineAt: exhaustions[0]?.deadlineAt,
      exhaustedAt: exhaustions[0]?.exhaustedAt,
    }, {
      attempts: 2,
      deadlineAt: new Date(30).toISOString(),
      exhaustedAt: new Date(30).toISOString(),
    });
    assert.equal(clock.pendingTimerCount(), 0);
    const terminal = JSON.parse(readFileSync(persistencePath, "utf8")).records[0].receipts[0].retryTerminal;
    assert.equal(terminal.code, "REMINDER_DELIVERY_RETRY_EXHAUSTED");
    assert.equal(terminal.deadlineAt, new Date(30).toISOString());
    assert.equal(terminal.attempts, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write-ahead persistence failure is bounded and never executes the side effect", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-retry-persist-"));
  const persistencePath = path.join(dir, "mirror.json");
  const clock = new FakeClock();
  let writes = 0;
  let sideEffects = 0;
  let terminalStage = "";
  try {
    const cache = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      fireRetryDelayMs: 10,
      fireRetryMaxDelayMs: 20,
      fireRetryMaxAttempts: 3,
      fireRetryDeadlineMs: 1_000,
      persistForTesting: (storage, payload) => {
        writes += 1;
        if (writes >= 3) throw new Error("PERSISTENCE_UNAVAILABLE");
        storage.writeTextAtomic(payload);
      },
      onRetryExhausted: (exhaustion) => { terminalStage = exhaustion.stage; },
      onFire: () => {
        sideEffects += 1;
        return { wakeEnqueued: true };
      },
    });
    cache.start();
    cache.snapshot("agent-a", []);
    cache.upsert(makeJob({
      reminderId: "retry-persistence",
      ownerAgentId: "agent-a",
      fireAt: new Date(5).toISOString(),
    }));
    clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));
    clock.advanceBy(10);
    await new Promise((resolve) => setImmediate(resolve));
    clock.advanceBy(20);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sideEffects, 0, "failed write-ahead cannot execute then backfill");
    assert.equal(terminalStage, "persistence");
    assert.equal(clock.pendingTimerCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initial due-receipt persistence failure enters the same bounded budget", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reminder-due-persist-"));
  const persistencePath = path.join(dir, "mirror.json");
  const clock = new FakeClock();
  let writes = 0;
  let sideEffects = 0;
  let exhaustionAttempts = 0;
  try {
    const cache = new ReminderCache({
      clock,
      storageForAgent: () => createTestReminderStorage(persistencePath),
      fireRetryDelayMs: 10,
      fireRetryMaxDelayMs: 20,
      fireRetryMaxAttempts: 3,
      fireRetryDeadlineMs: 1_000,
      persistForTesting: (storage, payload) => {
        writes += 1;
        if (writes >= 2) throw new Error("PERSISTENCE_UNAVAILABLE");
        storage.writeTextAtomic(payload);
      },
      onRetryExhausted: (exhaustion) => { exhaustionAttempts = exhaustion.attempts; },
      onFire: () => {
        sideEffects += 1;
        return { wakeEnqueued: true };
      },
    });
    cache.start();
    cache.snapshot("agent-a", []);
    cache.upsert(makeJob({
      reminderId: "due-persistence",
      ownerAgentId: "agent-a",
      fireAt: new Date(5).toISOString(),
    }));
    clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));
    clock.advanceBy(10);
    await new Promise((resolve) => setImmediate(resolve));
    clock.advanceBy(20);
    await new Promise((resolve) => setImmediate(resolve));
    clock.advanceBy(20);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sideEffects, 0, "an uncommitted due receipt cannot escape as a side effect");
    assert.equal(exhaustionAttempts, 3);
    assert.equal(clock.pendingTimerCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
