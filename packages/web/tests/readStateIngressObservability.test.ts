import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeReadStateUpdate,
  getAcceptedReadState,
  normalizeReadStateUpdated,
  normalizeReadStateUpdatedBulk,
  registerReadStateIngressCorruptListener,
  resetReadStateSyncForTests,
} from "../src/store/readStateSync.js";
import type {
  ReadStateIngressCorruption,
} from "../src/store/readStateSync.js";

// #632 C0 — read-state ingress failure observability.
//
// SCOPE NOTE, deliberately narrow: these teeth pin only that a rejected ingress
// payload is OBSERVABLE and never silently applied. They do NOT pin canonical
// string acceptance, and they do NOT pin >2^53 fidelity — C0 does not implement
// either, and no one has yet produced real `seq` magnitude data showing the
// high-bit case can occur. Do not cite this file as evidence that the high-bit
// problem or the #632 read/unread reconciliation is solved.

const SERVER = "server-a";

function collect(): { seen: ReadStateIngressCorruption[]; stop: () => void } {
  const seen: ReadStateIngressCorruption[] = [];
  const stop = registerReadStateIngressCorruptListener((c) => seen.push(c));
  return { seen, stop };
}

// The stored entry also carries an internal `generation`; these teeth are about
// the read-state fact itself, so compare only the fact.
function acceptedFact(scopeId: string): { maxReadSeq: number; readStateVersion: number } | null {
  const accepted = getAcceptedReadState(SERVER, scopeId);
  if (!accepted) return null;
  return { maxReadSeq: accepted.maxReadSeq, readStateVersion: accepted.readStateVersion };
}

test("legal safe-number payload is unchanged: it normalizes, applies, and reports nothing", () => {
  resetReadStateSyncForTests();
  const { seen, stop } = collect();
  try {
    const update = normalizeReadStateUpdated({
      serverId: SERVER,
      scopeId: "scope-1",
      maxReadSeq: 100,
      readStateVersion: 3,
    });

    assert.deepEqual(update, {
      serverId: SERVER,
      scopeId: "scope-1",
      maxReadSeq: 100,
      readStateVersion: 3,
    });
    assert.equal(consumeReadStateUpdate(update!), "accepted");
    assert.deepEqual(acceptedFact("scope-1"), { maxReadSeq: 100, readStateVersion: 3 });
    assert.deepEqual(seen, [], "a legal payload must not emit any corruption signal");
  } finally {
    stop();
  }
});

test("each rejected field emits its own stable reason instead of vanishing", () => {
  const cases: Array<{ name: string; payload: unknown; expected: ReadStateIngressCorruption }> = [
    {
      name: "canonical decimal string (C0 does NOT accept it yet)",
      payload: { serverId: SERVER, scopeId: "s", maxReadSeq: "100", readStateVersion: 1 },
      expected: { field: "maxReadSeq", reason: "max_read_seq_invalid" },
    },
    {
      name: "above MAX_SAFE_INTEGER",
      payload: { serverId: SERVER, scopeId: "s", maxReadSeq: 9007199254740993, readStateVersion: 1 },
      expected: { field: "maxReadSeq", reason: "max_read_seq_invalid" },
    },
    {
      name: "negative",
      payload: { serverId: SERVER, scopeId: "s", maxReadSeq: -1, readStateVersion: 1 },
      expected: { field: "maxReadSeq", reason: "max_read_seq_invalid" },
    },
    {
      name: "fractional",
      payload: { serverId: SERVER, scopeId: "s", maxReadSeq: 1.5, readStateVersion: 1 },
      expected: { field: "maxReadSeq", reason: "max_read_seq_invalid" },
    },
    {
      name: "invalid readStateVersion",
      payload: { serverId: SERVER, scopeId: "s", maxReadSeq: 1, readStateVersion: "3" },
      expected: { field: "readStateVersion", reason: "read_state_version_invalid" },
    },
    {
      name: "empty scopeId",
      payload: { serverId: SERVER, scopeId: "", maxReadSeq: 1, readStateVersion: 1 },
      expected: { field: "scopeId", reason: "scope_id_invalid" },
    },
    {
      name: "missing serverId",
      payload: { scopeId: "s", maxReadSeq: 1, readStateVersion: 1 },
      expected: { field: "serverId", reason: "server_id_invalid" },
    },
    {
      name: "not an object",
      payload: "nonsense",
      expected: { field: "payload", reason: "not_an_object" },
    },
  ];

  for (const { name, payload, expected } of cases) {
    resetReadStateSyncForTests();
    const { seen, stop } = collect();
    try {
      const update = normalizeReadStateUpdated(payload);
      assert.equal(update, null, `${name}: must be rejected`);
      assert.deepEqual(seen, [expected], `${name}: must emit exactly its own reason`);
    } finally {
      stop();
    }
  }
});

test("a rejected payload never reaches the accepted map", () => {
  resetReadStateSyncForTests();
  const { stop } = collect();
  try {
    // Establish a good fact first, then feed a rejected one for the same scope.
    consumeReadStateUpdate({ serverId: SERVER, scopeId: "scope-1", maxReadSeq: 50, readStateVersion: 2 });
    assert.equal(normalizeReadStateUpdated({
      serverId: SERVER,
      scopeId: "scope-1",
      maxReadSeq: "9007199254740993",
      readStateVersion: 9,
    }), null);

    assert.deepEqual(
      acceptedFact("scope-1"),
      { maxReadSeq: 50, readStateVersion: 2 },
      "the rejected value must not overwrite or partially apply over the accepted fact",
    );
  } finally {
    stop();
  }
});

test("good-bad-good: one bad scope in a bulk payload does not drop the good ones", () => {
  resetReadStateSyncForTests();
  const { seen, stop } = collect();
  try {
    const updates = normalizeReadStateUpdatedBulk({
      serverId: SERVER,
      scopes: [
        { scopeId: "good-1", maxReadSeq: 10, readStateVersion: 1 },
        { scopeId: "bad", maxReadSeq: "100", readStateVersion: 1 },
        { scopeId: "good-2", maxReadSeq: 20, readStateVersion: 1 },
      ],
    });

    assert.deepEqual(
      updates.map((u) => u.scopeId),
      ["good-1", "good-2"],
      "both good scopes must survive a neighbouring bad one",
    );
    assert.deepEqual(
      seen,
      [{ field: "maxReadSeq", reason: "max_read_seq_invalid" }],
      "the bad scope must be reported exactly once, not silently filtered",
    );
  } finally {
    stop();
  }
});

test("bulk ENVELOPE rejections are observable, exactly once each", () => {
  const cases: Array<{ name: string; payload: unknown; expected: ReadStateIngressCorruption }> = [
    { name: "null", payload: null, expected: { field: "payload", reason: "not_an_object" } },
    { name: "not an object", payload: "nonsense", expected: { field: "payload", reason: "not_an_object" } },
    { name: "empty object", payload: {}, expected: { field: "serverId", reason: "server_id_invalid" } },
    {
      name: "empty serverId",
      payload: { serverId: "", scopes: [] },
      expected: { field: "serverId", reason: "server_id_invalid" },
    },
    {
      name: "scopes not an array",
      payload: { serverId: SERVER, scopes: "bad" },
      expected: { field: "payload", reason: "scopes_not_an_array" },
    },
  ];

  for (const { name, payload, expected } of cases) {
    resetReadStateSyncForTests();
    const { seen, stop } = collect();
    try {
      assert.deepEqual(normalizeReadStateUpdatedBulk(payload), [], `${name}: yields no updates`);
      assert.deepEqual(seen, [expected], `${name}: envelope rejection must be reported exactly once`);
    } finally {
      stop();
    }
  }
});

test("an async listener that REJECTS cannot escape as an unhandledRejection", async () => {
  resetReadStateSyncForTests();
  const escaped: unknown[] = [];
  const onUnhandled = (reason: unknown) => escaped.push(reason);
  process.on("unhandledRejection", onUnhandled);

  const stopAsyncReject = registerReadStateIngressCorruptListener(async () => {
    throw new Error("async observability sink exploded");
  });
  const { seen, stop } = collect();
  try {
    // A `=> void` listener type would accept this async function and discard its
    // Promise; the rejection would then surface next tick and kill the process.
    assert.equal(
      normalizeReadStateUpdated({ serverId: SERVER, scopeId: "s", maxReadSeq: -1, readStateVersion: 1 }),
      null,
      "the normalizer still returns synchronously",
    );
    assert.deepEqual(seen, [{ field: "maxReadSeq", reason: "max_read_seq_invalid" }], "the neighbour sink still ran");

    // Probe two ticks — an unhandled rejection surfaces after the microtask queue drains.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(escaped, [], "an async sink's rejection must not escape ingestion");

    // And ingestion still works afterwards.
    const good = normalizeReadStateUpdated({ serverId: SERVER, scopeId: "s", maxReadSeq: 7, readStateVersion: 1 });
    assert.equal(consumeReadStateUpdate(good!), "accepted");
    assert.deepEqual(acceptedFact("s"), { maxReadSeq: 7, readStateVersion: 1 });
  } finally {
    stop();
    stopAsyncReject();
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a throwing corruption listener cannot break ingestion", () => {
  resetReadStateSyncForTests();
  const stopBad = registerReadStateIngressCorruptListener(() => {
    throw new Error("observability sink exploded");
  });
  const { seen, stop } = collect();
  try {
    // The bad listener runs alongside a good one; ingestion must still proceed
    // and the good listener must still be notified.
    assert.equal(normalizeReadStateUpdated({ serverId: SERVER, scopeId: "s", maxReadSeq: -1, readStateVersion: 1 }), null);
    assert.deepEqual(seen, [{ field: "maxReadSeq", reason: "max_read_seq_invalid" }]);

    const good = normalizeReadStateUpdated({ serverId: SERVER, scopeId: "s", maxReadSeq: 7, readStateVersion: 1 });
    assert.equal(consumeReadStateUpdate(good!), "accepted");
    assert.deepEqual(acceptedFact("s"), { maxReadSeq: 7, readStateVersion: 1 });
  } finally {
    stop();
    stopBad();
  }
});
