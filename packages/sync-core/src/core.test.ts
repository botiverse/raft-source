import assert from "node:assert/strict";
import { test } from "node:test";
import { createSyncCore } from "./core.js";
import type { SyncDomainConfig, SyncFrame, SyncSnapshot } from "./types.js";

/** Toy log domain: state = ordered list of applied event tags. */
type LogState = { entries: ReadonlyArray<string> };
type LogEvent = { tag: string };

function logDomain(name: string, density: "contiguous" | "sparse"): SyncDomainConfig<LogState, LogEvent> {
  return {
    name,
    density,
    initialState: () => ({ entries: [] }),
    fold: (state, event, frame) => ({ entries: [...state.entries, `${frame.seq}:${event.tag}`] }),
    fromSnapshot: (snapshot) => snapshot.state as LogState,
  };
}

function fingerprintedLogDomain(name: string): SyncDomainConfig<LogState, LogEvent> {
  return {
    ...logDomain(name, "sparse"),
    eventFingerprint: (event) => event.tag,
  };
}

function snapshotUpgradeDomain(name: string): SyncDomainConfig<LogState, LogEvent> {
  return {
    ...logDomain(name, "sparse"),
    acceptSameWatermarkSnapshot: (currentState, incoming) => {
      const next = incoming.state as LogState;
      return next.entries.length > currentState.entries.length;
    },
  };
}

function frame(scopeId: string, seq: bigint, tag: string, epoch: string | null = "e1"): SyncFrame<LogEvent> {
  return { scopeId, seq, epoch, event: { tag } };
}

function snapshot(scopeId: string, watermark: bigint, entries: string[], epoch: string | null = "e1"): SyncSnapshot<LogState> {
  return { scopeId, watermark, epoch, state: { entries } };
}

const DOMAINS = () => [logDomain("log", "contiguous") as SyncDomainConfig<unknown, unknown>];
const SPARSE = () => [logDomain("act", "sparse") as SyncDomainConfig<unknown, unknown>];

test("contiguous in-order frames apply through the fold", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  core.ingestSnapshot("log", snapshot("s", 0n, []));
  assert.deepEqual(core.ingestFrame("log", frame("s", 1n, "a")), { kind: "applied", scopeId: "s", seq: 1n });
  assert.deepEqual(core.ingestFrame("log", frame("s", 2n, "b")), { kind: "applied", scopeId: "s", seq: 2n });
  assert.deepEqual(core.state("log", "s"), { entries: ["1:a", "2:b"] });
  assert.equal(core.pendingRequests().length, 0);
});

test("duplicate and stale frames are idempotent no-ops (state reference preserved)", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  core.ingestSnapshot("log", snapshot("s", 0n, []));
  core.ingestFrame("log", frame("s", 1n, "a"));
  core.ingestFrame("log", frame("s", 2n, "b"));
  const before = core.state("log", "s");
  assert.deepEqual(core.ingestFrame("log", frame("s", 1n, "a")), { kind: "duplicate_dropped", scopeId: "s", seq: 1n });
  assert.equal(core.state("log", "s"), before, "no-op must preserve reference identity");
  assert.deepEqual(core.violations().records, [], "legacy event domains keep stale delivery violation-neutral");
});

test("fingerprinted same-version replay is duplicate, while conflicting fact fails closed", () => {
  const domain = fingerprintedLogDomain("facts");
  const core = createSyncCore({ domains: [domain as SyncDomainConfig<unknown, unknown>] });
  core.ingestFrame("facts", frame("s", 7n, "accepted", null));
  const before = core.state("facts", "s");

  assert.deepEqual(
    core.ingestFrame("facts", frame("s", 7n, "accepted", null)),
    { kind: "duplicate_dropped", scopeId: "s", seq: 7n },
  );
  assert.equal(core.state("facts", "s"), before, "same fact must preserve state reference");

  assert.deepEqual(
    core.ingestFrame("facts", frame("s", 7n, "conflict", null)),
    { kind: "violation", scopeId: "s", violation: "producer_version_conflict" },
  );
  assert.equal(core.state("facts", "s"), before, "conflicting fact must not apply");
  assert.equal(core.violations().records.at(-1)?.kind, "producer_version_conflict");
  assert.deepEqual(core.pendingRequests(), [
    { kind: "snapshot", domain: "facts", scopeId: "s", reason: "sparse_repull" },
  ]);
});

test("lower-version live frame records version_regression and preserves accepted state", () => {
  const domain = fingerprintedLogDomain("facts");
  const core = createSyncCore({ domains: [domain as SyncDomainConfig<unknown, unknown>] });
  core.ingestFrame("facts", frame("s", 9n, "accepted", null));
  const before = core.state("facts", "s");

  assert.deepEqual(
    core.ingestFrame("facts", frame("s", 8n, "older", null)),
    { kind: "duplicate_dropped", scopeId: "s", seq: 8n },
  );
  assert.equal(core.state("facts", "s"), before);
  assert.equal(core.violations().records.at(-1)?.kind, "version_regression");
});

test("contiguous gap stop-gates, requests difference, and repair converges to the anchored fold", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  core.ingestSnapshot("log", snapshot("s", 0n, []));
  core.ingestFrame("log", frame("s", 1n, "a"));
  const outcome = core.ingestFrame("log", frame("s", 3n, "c"));
  assert.deepEqual(outcome, { kind: "gap_repair_requested", scopeId: "s", fromSeq: 2n, toSeq: 2n });
  // Gapped frame is NOT applied; a difference request is pending.
  assert.deepEqual(core.state("log", "s"), { entries: ["1:a"] });
  const requests = core.pendingRequests();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { kind: "difference", domain: "log", scopeId: "s", sinceSeq: 1n, epoch: "e1" });
  // Repair delivers 2..3 in order — terminal state equals the in-order fold.
  core.ingestDifference("log", {
    scopeId: "s",
    epoch: "e1",
    fromSeq: 1n,
    toSeq: 3n,
    events: [
      { seq: 2n, event: { tag: "b" } },
      { seq: 3n, event: { tag: "c" } },
    ],
  });
  assert.deepEqual(core.state("log", "s"), { entries: ["1:a", "2:b", "3:c"] });
  assert.equal(core.pendingRequests().length, 0);
  assert.equal(core.scopeSyncState("log", "s")?.repairPending, false);
});

test("sparse scopes max-advance across holes and converge for any arrival order", () => {
  const frames = [frame("a", 5n, "x", null), frame("a", 9n, "y", null), frame("a", 12n, "z", null)];
  const permutations: SyncFrame<LogEvent>[][] = [
    [frames[0]!, frames[1]!, frames[2]!],
    [frames[2]!, frames[0]!, frames[1]!],
    [frames[1]!, frames[2]!, frames[0]!],
  ];
  const terminals = permutations.map((order) => {
    const core = createSyncCore({ domains: SPARSE() });
    for (const f of order) core.ingestFrame("act", f);
    return { state: core.state("act", "a"), seq: core.scopeSyncState("act", "a")?.appliedSeq };
  });
  // Max-advance semantics: watermark converges to the max seq in every order.
  for (const t of terminals) assert.equal(t.seq, 12n);
  // No stop-gating: no repair requests for sparse scopes.
  const core = createSyncCore({ domains: SPARSE() });
  for (const f of frames) core.ingestFrame("act", f);
  assert.equal(core.pendingRequests().length, 0);
});

test("cross-epoch frame is dropped, recorded as violation, and triggers rebaseline", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  core.ingestSnapshot("log", snapshot("s", 5n, ["seed"], "e1"));
  const outcome = core.ingestFrame("log", frame("s", 6n, "ghost", "e0"));
  assert.deepEqual(outcome, { kind: "epoch_rebaseline_requested", scopeId: "s" });
  assert.deepEqual(core.state("log", "s"), { entries: ["seed"] }, "cross-epoch frame must never apply");
  const drain = core.violations();
  assert.equal(drain.records.length, 1);
  assert.equal(drain.records[0]?.kind, "cross_epoch_arrival");
  const requests = core.pendingRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.kind, "snapshot");
});

test("snapshot rebaseline clears pending repairs and resumes in-order application", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  core.ingestSnapshot("log", snapshot("s", 0n, []));
  core.ingestFrame("log", frame("s", 4n, "late")); // gap → repair pending
  assert.equal(core.pendingRequests().length, 1);
  core.ingestSnapshot("log", snapshot("s", 10n, ["rebased"], "e2"));
  assert.equal(core.pendingRequests().length, 0);
  assert.deepEqual(core.ingestFrame("log", frame("s", 11n, "next", "e2")), { kind: "applied", scopeId: "s", seq: 11n });
  assert.deepEqual(core.state("log", "s"), { entries: ["rebased", "11:next"] });
});

test("partial difference (slice) idempotently regenerates the next request from the intermediate watermark", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  core.ingestSnapshot("log", snapshot("s", 0n, []));
  core.ingestFrame("log", frame("s", 5n, "late")); // baseline 0, gap → difference since 0
  const first = core.ingestDifference("log", {
    scopeId: "s",
    epoch: "e1",
    fromSeq: 0n,
    toSeq: 2n,
    events: [
      { seq: 1n, event: { tag: "a" } },
      { seq: 2n, event: { tag: "b" } },
    ],
    partial: true,
  });
  assert.equal(first.kind, "gap_repair_requested");
  const requests = core.pendingRequests();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { kind: "difference", domain: "log", scopeId: "s", sinceSeq: 2n, epoch: "e1" });
  // Draining pendingRequests twice yields the same description (idempotent).
  assert.deepEqual(core.pendingRequests(), requests);
});

test("first contact without baseline: contiguous requests snapshot, sparse adopts the frame", () => {
  const core = createSyncCore({ domains: [...DOMAINS(), ...SPARSE()] });
  const contiguous = core.ingestFrame("log", frame("s", 7n, "x"));
  assert.equal(contiguous.kind, "gap_repair_requested");
  assert.equal(core.pendingRequests()[0]?.kind, "snapshot");
  const sparse = core.ingestFrame("act", frame("a", 7n, "x", null));
  assert.deepEqual(sparse, { kind: "max_advanced", scopeId: "a", seq: 7n });
});

test("snapshot arrival order converges: stale same-epoch snapshot never rolls back (Tenny #4255 review RED)", () => {
  const snapA = snapshot("s", 10n, ["a-through-10"], "e1");
  const snapB = snapshot("s", 5n, ["b-through-5"], "e1");
  const forward = createSyncCore({ domains: DOMAINS() });
  forward.ingestSnapshot("log", snapA);
  const staleOutcome = forward.ingestSnapshot("log", snapB);
  const reverse = createSyncCore({ domains: DOMAINS() });
  reverse.ingestSnapshot("log", snapB);
  reverse.ingestSnapshot("log", snapA);
  // Any arrival order of the same snapshot set converges to the same state.
  assert.deepEqual(forward.state("log", "s"), reverse.state("log", "s"));
  assert.equal(forward.scopeSyncState("log", "s")?.appliedSeq, 10n);
  assert.equal(reverse.scopeSyncState("log", "s")?.appliedSeq, 10n);
  // The stale snapshot is a comparison-based no-op, recorded as regression.
  assert.deepEqual(staleOutcome, { kind: "duplicate_dropped", scopeId: "s", seq: 5n });
  assert.equal(forward.violations().records.some((r) => r.kind === "version_regression"), true);
});

test("cross-epoch snapshot rebaseline may lower the watermark (rebaseline, not rollback)", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  core.ingestSnapshot("log", snapshot("s", 10n, ["old-epoch"], "e1"));
  const outcome = core.ingestSnapshot("log", snapshot("s", 3n, ["new-epoch"], "e2"));
  assert.deepEqual(outcome, { kind: "applied", scopeId: "s", seq: 3n });
  assert.deepEqual(core.state("log", "s"), { entries: ["new-epoch"] });
  assert.equal(core.scopeSyncState("log", "s")?.epoch, "e2");
});

test("unregistered domain is a hard error", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  assert.throws(() => core.ingestFrame("nope", frame("s", 1n, "a")), /unregistered domain/);
});

test("difference response from a foreign epoch is rejected with violation + snapshot request", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  core.ingestSnapshot("log", snapshot("s", 2n, ["seed"], "e1"));
  const outcome = core.ingestDifference("log", {
    scopeId: "s",
    epoch: "e0",
    fromSeq: 2n,
    toSeq: 4n,
    events: [{ seq: 3n, event: { tag: "ghost" } }],
  });
  assert.deepEqual(outcome, { kind: "epoch_rebaseline_requested", scopeId: "s" });
  assert.deepEqual(core.state("log", "s"), { entries: ["seed"] });
  assert.equal(core.violations().records.at(-1)?.kind, "cross_epoch_arrival");
  assert.equal(core.pendingRequests()[0]?.kind, "snapshot");
});

test("difference snapshotRequired verdict swaps the repair to a snapshot request", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  core.ingestSnapshot("log", snapshot("s", 1n, ["seed"]));
  core.ingestFrame("log", frame("s", 9n, "late")); // gap → difference pending
  const outcome = core.ingestDifference("log", {
    scopeId: "s",
    epoch: "e1",
    fromSeq: 1n,
    toSeq: 9n,
    events: [],
    snapshotRequired: true,
  });
  assert.deepEqual(outcome, { kind: "epoch_rebaseline_requested", scopeId: "s" });
  const requests = core.pendingRequests();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { kind: "snapshot", domain: "log", scopeId: "s", reason: "snapshot_required" });
});

test("violations(sinceIndex) resumes from the given index", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  core.ingestSnapshot("log", snapshot("s", 5n, ["seed"], "e1"));
  core.ingestFrame("log", frame("s", 6n, "x", "e0")); // violation 0
  core.ingestSnapshot("log", snapshot("s", 3n, ["stale"], "e1")); // violation 1
  const all = core.violations();
  assert.equal(all.records.length, 2);
  const resumed = core.violations(all.records[1]!.index);
  assert.deepEqual(resumed.records.map((r) => r.kind), ["version_regression"]);
});

test("sparse first contact adopts the frame epoch as baseline", () => {
  const core = createSyncCore({ domains: SPARSE() });
  core.ingestFrame("act", frame("a", 4n, "x", "eZ"));
  assert.equal(core.scopeSyncState("act", "a")?.epoch, "eZ");
});

test("a sparse domain may accept a strictly richer same-watermark snapshot", () => {
  const core = createSyncCore({
    domains: [snapshotUpgradeDomain("upgrade") as SyncDomainConfig<unknown, unknown>],
  });

  core.ingestFrame("upgrade", frame("s", 7n, "latest", null));
  assert.deepEqual(core.state("upgrade", "s"), { entries: ["7:latest"] });

  const upgraded = core.ingestSnapshot(
    "upgrade",
    snapshot("s", 7n, ["5:older", "6:middle", "7:latest"], null),
  );
  assert.deepEqual(upgraded, { kind: "applied", scopeId: "s", seq: 7n });
  assert.deepEqual(core.state("upgrade", "s"), { entries: ["5:older", "6:middle", "7:latest"] });

  const stale = core.ingestSnapshot("upgrade", snapshot("s", 7n, ["7:latest"], null));
  assert.deepEqual(stale, { kind: "duplicate_dropped", scopeId: "s", seq: 7n });
  assert.deepEqual(core.state("upgrade", "s"), { entries: ["5:older", "6:middle", "7:latest"] });
});

test("first contact via difference response establishes the watermark", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  const outcome = core.ingestDifference("log", {
    scopeId: "fresh",
    epoch: "e1",
    fromSeq: 0n,
    toSeq: 2n,
    events: [
      { seq: 1n, event: { tag: "a" } },
      { seq: 2n, event: { tag: "b" } },
    ],
  });
  assert.deepEqual(outcome, { kind: "applied", scopeId: "fresh", seq: 2n });
  assert.deepEqual(core.state("log", "fresh"), { entries: ["1:a", "2:b"] });
});

test("state and scopeSyncState are undefined for untouched scopes", () => {
  const core = createSyncCore({ domains: DOMAINS() });
  assert.equal(core.state("log", "ghost"), undefined);
  assert.equal(core.scopeSyncState("log", "ghost"), undefined);
});
