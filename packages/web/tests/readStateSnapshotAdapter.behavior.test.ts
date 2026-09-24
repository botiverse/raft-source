import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeReadStateSnapshot,
  getAcceptedReadState,
  getReadStateLedgerGeneration,
  consumeReadStateUpdate,
  resetReadStateSyncForTests,
} from "../src/store/readStateSync";
import type {
  ReadStateSnapshotOutcome,
} from "../src/store/readStateSync";

/**
 * #632 C1 — the single authority-snapshot adapter (task #402).
 *
 * RED-FIRST. These teeth are written before the adapter exists; they fail with
 * "not a function" until it lands, and are the acceptance surface for it.
 *
 * Frozen shape (@赵梓淇, #proj-frontend:529915f4):
 *   - ONE conversion point, here in readStateSync — not in activityReadState.ts
 *     (that is the read-all ACK/hold path) and not in components, which must
 *     never destructure the union themselves.
 *   - The union's three kinds stay three: `absent` is an authoritative NEGATIVE
 *     fact, `corrupt` is an alarm that must not be demoted to absent nor
 *     overwrite what is displayed.
 *   - Exactly one field crosses type domains: `maxReadSeq` arrives as a
 *     canonical decimal string and the ledger holds a number. Parse via BigInt
 *     and only convert when it fits MAX_SAFE_INTEGER — an out-of-range value is
 *     corrupt, never a truncated number. (`latestActivity.seq` and
 *     `readStateVersion` are already same-domain and are NOT converted here.)
 *   - An HTTP snapshot must never roll back state a socket frame already
 *     advanced; the existing generation/version gate is the mechanism.
 */

const SERVER = "srv-1";
const SCOPE = "chan-1";

function present(maxReadSeq: string, readStateVersion = 1) {
  return { kind: "present" as const, readStateVersion, maxReadSeq, latestActivity: null };
}

function ledger(serverId: string, scopeId: string) {
  const state = getAcceptedReadState(serverId, scopeId);
  return state === null ? null : { maxReadSeq: state.maxReadSeq, readStateVersion: state.readStateVersion };
}

test.beforeEach(() => {
  resetReadStateSyncForTests();
});

test("present: a canonical decimal string becomes the exact numeric ledger value", () => {
  const outcome: ReadStateSnapshotOutcome = consumeReadStateSnapshot(SERVER, SCOPE, present("11157566", 3));

  assert.equal(outcome.kind, "accepted");
  assert.deepEqual(ledger(SERVER, SCOPE), { maxReadSeq: 11157566, readStateVersion: 3 });
});

test("present at the safe-integer boundary is still exact, not rounded", () => {
  const atMax = String(Number.MAX_SAFE_INTEGER); // 9007199254740991

  consumeReadStateSnapshot(SERVER, SCOPE, present(atMax, 1));

  assert.equal(getAcceptedReadState(SERVER, SCOPE)?.maxReadSeq, Number.MAX_SAFE_INTEGER);
});

test("beyond safe-integer is CORRUPT, never a truncated number", () => {
  const overflow = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(); // 9007199254740992

  const outcome = consumeReadStateSnapshot(SERVER, SCOPE, present(overflow, 1));

  assert.equal(outcome.kind, "corrupt");
  assert.equal(
    getAcceptedReadState(SERVER, SCOPE),
    null,
    "a value we cannot represent must not enter the ledger at all — silently storing 9007199254740992 " +
      "would be a wrong read frontier that no test can later distinguish from a real one",
  );
});

test("a non-canonical decimal is CORRUPT, not coerced", () => {
  for (const bad of ["", " 12", "12 ", "1e5", "0x10", "-1", "1.0", "０１２"]) {
    resetReadStateSyncForTests();
    const outcome = consumeReadStateSnapshot(SERVER, SCOPE, present(bad, 1));
    assert.equal(outcome.kind, "corrupt", `${JSON.stringify(bad)} must not parse as a read frontier`);
    assert.equal(getAcceptedReadState(SERVER, SCOPE), null);
  }
});

test("absent is an authoritative negative fact — it CLEARS a stale ledger entry", () => {
  consumeReadStateSnapshot(SERVER, SCOPE, present("500", 1));
  assert.ok(getAcceptedReadState(SERVER, SCOPE));

  const outcome = consumeReadStateSnapshot(SERVER, SCOPE, { kind: "absent" });

  assert.equal(outcome.kind, "cleared");
  assert.equal(
    getAcceptedReadState(SERVER, SCOPE),
    null,
    "no cursor row on the server means the client must fall back to the server's own row/count, " +
      "not keep projecting a read frontier the server no longer claims",
  );
});

test("corrupt does NOT clear and does NOT demote to absent", () => {
  consumeReadStateSnapshot(SERVER, SCOPE, present("500", 2));

  const outcome = consumeReadStateSnapshot(SERVER, SCOPE, { kind: "corrupt" });

  assert.equal(outcome.kind, "corrupt");
  assert.deepEqual(
    ledger(SERVER, SCOPE),
    { maxReadSeq: 500, readStateVersion: 2 },
    "corrupt is an alarm about the server's row, not evidence that the last good value is wrong; " +
      "wiping it here would turn one bad scope into a visible unread-state flip",
  );
});

test("corrupt is observable — it does not pass silently", () => {
  const seen: string[] = [];
  consumeReadStateSnapshot(SERVER, SCOPE, { kind: "corrupt" }, (scopeId) => seen.push(scopeId));

  assert.deepEqual(seen, [SCOPE]);
});

test("an HTTP snapshot must not roll back a newer socket frame", () => {
  consumeReadStateUpdate({ serverId: SERVER, scopeId: SCOPE, maxReadSeq: 900, readStateVersion: 9 });
  const generationAfterSocket = getReadStateLedgerGeneration();

  const outcome = consumeReadStateSnapshot(SERVER, SCOPE, present("500", 4));

  assert.equal(outcome.kind, "stale");
  assert.deepEqual(
    ledger(SERVER, SCOPE),
    { maxReadSeq: 900, readStateVersion: 9 },
    "a slow /channels response landing after a socket update must not resurrect the older frontier",
  );
  assert.equal(getReadStateLedgerGeneration(), generationAfterSocket, "a stale snapshot must not bump the generation");
});

test("an absent snapshot must not erase a newer socket frame either", () => {
  consumeReadStateUpdate({ serverId: SERVER, scopeId: SCOPE, maxReadSeq: 900, readStateVersion: 9 });

  const outcome = consumeReadStateSnapshot(SERVER, SCOPE, { kind: "absent" }, undefined, {
    ledgerGenerationAtRequest: 0,
  });

  assert.equal(outcome.kind, "stale");
  assert.deepEqual(
    ledger(SERVER, SCOPE),
    { maxReadSeq: 900, readStateVersion: 9 },
    "absent is authoritative only about the snapshot's own moment — an in-flight response that " +
      "predates a socket advance must not clear it",
  );
});

test("a newer snapshot still wins over an older socket frame", () => {
  consumeReadStateUpdate({ serverId: SERVER, scopeId: SCOPE, maxReadSeq: 100, readStateVersion: 2 });

  const outcome = consumeReadStateSnapshot(SERVER, SCOPE, present("900", 7));

  assert.equal(outcome.kind, "accepted");
  assert.deepEqual(ledger(SERVER, SCOPE), { maxReadSeq: 900, readStateVersion: 7 });
});

test("scopes are isolated — one corrupt scope leaves the others byte-exact", () => {
  consumeReadStateSnapshot(SERVER, "a", present("10", 1));
  consumeReadStateSnapshot(SERVER, "b", present("20", 1));

  consumeReadStateSnapshot(SERVER, "a", { kind: "corrupt" });

  assert.deepEqual(ledger(SERVER, "b"), { maxReadSeq: 20, readStateVersion: 1 });
});

test("a throwing corrupt sink does not escape and does not break the batch", () => {
  const outcome = consumeReadStateSnapshot(SERVER, SCOPE, { kind: "corrupt" }, () => {
    throw new Error("sink exploded");
  });

  assert.equal(outcome.kind, "corrupt", "the verdict is returned synchronously regardless of the sink");
  // and a sibling scope in the same fold is still processed
  assert.equal(consumeReadStateSnapshot(SERVER, "sibling", present("42", 1)).kind, "accepted");
});

test("an async-rejecting corrupt sink neither escapes nor becomes an unhandledRejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const outcome = consumeReadStateSnapshot(SERVER, SCOPE, { kind: "corrupt" }, async () => {
      throw new Error("async sink exploded");
    });
    assert.equal(outcome.kind, "corrupt", "still synchronous — the thenable must not be awaited");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      unhandled,
      [],
      "`(scopeId) => void` accepts an async fn, so a bare try/catch misses the rejection and it kills " +
        "the process a tick later",
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// ---------------------------------------------------------------------------
// @赵梓淇's frozen final teeth (task #402): the marker is ROW EVIDENCE and is
// orthogonal to whether the ledger accepted the version.
// ---------------------------------------------------------------------------

test("final 3a — VERSION-stale keeps the row's marker and writes nothing to the ledger", () => {
  consumeReadStateSnapshot(SERVER, SCOPE, {
    kind: "present",
    readStateVersion: 9,
    maxReadSeq: "900",
    latestActivity: { messageId: "m9", seq: "900" },
  });
  const generationAfterFirst = getReadStateLedgerGeneration();

  const outcome = consumeReadStateSnapshot(SERVER, SCOPE, {
    kind: "present",
    readStateVersion: 4, // older than 9 -> ledger must not move
    maxReadSeq: "400",
    latestActivity: { messageId: "m4", seq: "400" },
  });

  assert.equal(outcome.kind, "stale");
  assert.equal(
    outcome.latestActivitySeq,
    "400",
    "this row's own frontier is valid evidence even though the ledger already holds something newer",
  );
  assert.deepEqual(ledger(SERVER, SCOPE), { maxReadSeq: 900, readStateVersion: 9 }, "zero ledger write");
  assert.equal(getReadStateLedgerGeneration(), generationAfterFirst, "zero generation bump");
});

test("final 3b — GENERATION-stale keeps the row's marker and writes nothing to the ledger", () => {
  consumeReadStateUpdate({ serverId: SERVER, scopeId: SCOPE, maxReadSeq: 900, readStateVersion: 9 });
  const generationAfterSocket = getReadStateLedgerGeneration();

  const outcome = consumeReadStateSnapshot(
    SERVER,
    SCOPE,
    { kind: "present", readStateVersion: 12, maxReadSeq: "500", latestActivity: { messageId: "m5", seq: "500" } },
    undefined,
    { ledgerGenerationAtRequest: 0 },
  );

  assert.equal(outcome.kind, "stale");
  assert.equal(outcome.latestActivitySeq, "500", "superseded by a socket frame, but the row's evidence survives");
  assert.deepEqual(ledger(SERVER, SCOPE), { maxReadSeq: 900, readStateVersion: 9 }, "zero ledger write");
  assert.equal(getReadStateLedgerGeneration(), generationAfterSocket, "zero generation bump");
});

test("final 2 — absent / corrupt / null-pair yield NO marker, so no suppression can be keyed", () => {
  assert.equal(consumeReadStateSnapshot(SERVER, "a", { kind: "absent" }).latestActivitySeq, null);
  assert.equal(consumeReadStateSnapshot(SERVER, "b", { kind: "corrupt" }).latestActivitySeq, null);
  assert.equal(
    consumeReadStateSnapshot(SERVER, "c", {
      kind: "present",
      readStateVersion: 1,
      maxReadSeq: "1",
      latestActivity: null,
    }).latestActivitySeq,
    null,
  );
});

test("final 2b — a present union with an unusable maxReadSeq is corrupt WHOLE: no marker cherry-picked", () => {
  const outcome = consumeReadStateSnapshot(SERVER, SCOPE, {
    kind: "present",
    readStateVersion: 1,
    maxReadSeq: (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(),
    latestActivity: { messageId: "m", seq: "123" },
  });

  assert.equal(outcome.kind, "corrupt");
  assert.equal(
    outcome.latestActivitySeq,
    null,
    "the pair looks fine, but the union it belongs to is unusable — taking the marker out of it would " +
      "trust half of a row we just rejected",
  );
});
