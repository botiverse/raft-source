import assert from "node:assert/strict";
import test from "node:test";
import { createSyncCore } from "./core.js";
import {
  generateSyncHarnessFixture,
  generateSyncMixedInterleavingHarnessFixture,
  replaySyncHarnessFixture,
  type SyncHarnessEvent,
  type SyncHarnessSnapshotState,
} from "./testing.js";
import type { SyncDomainConfig } from "./types.js";

test("sync harness generator is deterministic for a fixed seed", () => {
  const options = { seed: 43, domain: "messages", scopeIds: ["channel-a", "channel-b"], steps: 8 };

  assert.deepEqual(generateSyncHarnessFixture(options), generateSyncHarnessFixture(options));
});

test("sync harness generator emits fixed oracle steps for seed 43", () => {
  const fixture = generateSyncHarnessFixture({
    seed: 43,
    domain: "messages",
    scopeIds: ["channel-a", "channel-b"],
    steps: 5,
  });

  assert.deepEqual(fixture.steps.map((step) => step.expectedOutcome), [
    { kind: "applied", scopeId: "channel-a", seq: 0n },
    { kind: "applied", scopeId: "channel-a", seq: 1n },
    { kind: "applied", scopeId: "channel-a", seq: 3n },
    { kind: "applied", scopeId: "channel-b", seq: 0n },
    { kind: "applied", scopeId: "channel-a", seq: 3n },
  ]);
  assert.deepEqual(fixture.steps.map((step) => step.input.kind), [
    "snapshot",
    "frame",
    "difference",
    "snapshot",
    "snapshot",
  ]);
});

test("sync harness generator rejects unbounded or underspecified fixtures", () => {
  assert.throws(
    () => generateSyncHarnessFixture({ seed: 1, domain: "messages", scopeIds: [], steps: 1 }),
    /at least one scopeId/,
  );
  assert.throws(
    () => generateSyncHarnessFixture({ seed: 1, domain: "messages", scopeIds: ["channel-a"], steps: -1 }),
    /non-negative safe integer/,
  );
});

test("mixed interleaving harness generator is deterministic and covers frame snapshot difference", () => {
  const options = { seed: 4255, domain: "messages", scopeIds: ["channel-a", "channel-b"], steps: 12 };

  const fixture = generateSyncMixedInterleavingHarnessFixture(options);

  assert.deepEqual(fixture, generateSyncMixedInterleavingHarnessFixture(options));
  assert.deepEqual(new Set(fixture.steps.map((step) => step.input.kind)), new Set(["snapshot", "frame", "difference"]));
});

test("mixed interleaving harness replays oracle outcomes against sync core", () => {
  const fixture = generateSyncMixedInterleavingHarnessFixture({
    seed: 4255,
    domain: "messages",
    scopeIds: ["channel-a"],
    steps: 6,
  });
  const core = createSyncCore({ domains: [harnessDomain("messages") as SyncDomainConfig<unknown, unknown>] });

  assert.deepEqual(
    replaySyncHarnessFixture(core, fixture),
    fixture.steps.map((step) => step.expectedOutcome),
  );
  assert.deepEqual(core.state("messages", "channel-a"), { applied: [1, 2, 3, 4, 5] });
});

test("mixed interleaving harness catches stale snapshot rollback regression before fix", () => {
  const fixture = generateSyncMixedInterleavingHarnessFixture({
    seed: 4255,
    domain: "messages",
    scopeIds: ["channel-a"],
    steps: 6,
  });
  const staleSnapshotStep = fixture.steps[4];

  assert.equal(staleSnapshotStep?.input.kind, "snapshot");
  assert.deepEqual(staleSnapshotStep?.expectedOutcome, {
    kind: "duplicate_dropped",
    scopeId: "channel-a",
    seq: 2n,
  });
});

function harnessDomain(
  name: string,
): SyncDomainConfig<SyncHarnessSnapshotState, SyncHarnessEvent> {
  return {
    name,
    density: "contiguous",
    initialState: () => ({ applied: [] }),
    fold: (state, event) => ({ applied: [...state.applied, event.value] }),
    fromSnapshot: (snapshot) => snapshot.state as SyncHarnessSnapshotState,
  };
}
