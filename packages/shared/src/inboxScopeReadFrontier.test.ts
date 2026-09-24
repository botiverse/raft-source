// Frozen behavior teeth for the shared inbox read-frontier contract (#632).
// The three reviewer-frozen teeth plus corruption-loudness and pairing cuts —
// every exit imports the constructor these teeth pin, so a drift here is a
// drift everywhere.
import assert from "node:assert/strict";
import test from "node:test";

import { compareUInt64String, isUInt64String } from "@botiverse/raft-sync-core";

import {
  type InboxScopeCursorCorruption,
  type InboxScopeCursorRow,
  formatInboxScopeCorruptionLine,
  makeInboxScopeReadFrontier,
} from "./inboxScopeReadFrontier.js";

test("tooth 1: no cursor row (null) is absent", () => {
  assert.deepEqual(makeInboxScopeReadFrontier(null), { kind: "absent" });
});

test("tooth 2: a REAL row with version=0 and maxReadSeq='0' is present — presence is not value-derived", () => {
  const frontier = makeInboxScopeReadFrontier({
    readStateVersion: 0,
    maxReadSeq: "0",
    latestActivityMessageId: null,
    latestActivitySeq: null,
  });
  assert.deepEqual(frontier, {
    kind: "present",
    readStateVersion: 0,
    maxReadSeq: "0",
    latestActivity: null,
  });
});

test("tooth 3: frontier with either half missing or invalid fails closed to null — no cross-source fill", () => {
  const base = { readStateVersion: 3, maxReadSeq: "17" };
  const idOnly = makeInboxScopeReadFrontier({
    ...base,
    latestActivityMessageId: "m-1",
    latestActivitySeq: null,
  });
  const seqOnly = makeInboxScopeReadFrontier({
    ...base,
    latestActivityMessageId: null,
    latestActivitySeq: "42",
  });
  const badSeq = makeInboxScopeReadFrontier({
    ...base,
    latestActivityMessageId: "m-1",
    latestActivitySeq: "007",
  });
  for (const f of [idOnly, seqOnly, badSeq]) {
    assert.equal(f.kind, "present");
    assert.equal((f as { latestActivity: unknown }).latestActivity, null);
  }
  // Positive control: a valid same-source pair survives verbatim.
  const paired = makeInboxScopeReadFrontier({
    ...base,
    latestActivityMessageId: "m-1",
    latestActivitySeq: "9007199254740993",
  });
  assert.deepEqual(
    (paired as { latestActivity: unknown }).latestActivity,
    { messageId: "m-1", seq: "9007199254740993" },
  );
});

test("corrupt PRESENT rows become kind:'corrupt' with exactly-once value-free callback — never throw, never absent, never zero", () => {
  const reports: InboxScopeCursorCorruption[] = [];
  const corrupt = makeInboxScopeReadFrontier(
    { readStateVersion: -1, maxReadSeq: "5", latestActivityMessageId: null, latestActivitySeq: null },
    (c) => { reports.push(c); },
  );
  assert.deepEqual(corrupt, { kind: "corrupt" });
  assert.deepEqual(reports, [{ field: "readStateVersion", reason: "negative" }]);

  for (const badSeq of ["01", "-1", "1.5", "", "abc"]) {
    const calls: InboxScopeCursorCorruption[] = [];
    const f = makeInboxScopeReadFrontier(
      { readStateVersion: 1, maxReadSeq: badSeq, latestActivityMessageId: null, latestActivitySeq: null },
      (c) => { calls.push(c); },
    );
    assert.deepEqual(f, { kind: "corrupt" }, `maxReadSeq=${JSON.stringify(badSeq)} must be corrupt`);
    assert.equal(calls.length, 1, "callback exactly once");
    assert.equal(calls[0].field, "maxReadSeq");
    // Value-free discipline: the report never carries the raw value.
    assert.equal(JSON.stringify(calls[0]).includes(badSeq === "" ? "\"\"" : badSeq), false);
  }
  // No callback provided: still total, still corrupt, still no throw.
  assert.deepEqual(
    makeInboxScopeReadFrontier({ readStateVersion: Number.NaN, maxReadSeq: "1", latestActivityMessageId: null, latestActivitySeq: null }),
    { kind: "corrupt" },
  );
});

test("batch isolation: one corrupt scope leaves the other N intact and reports exactly once", () => {
  const rows: Array<InboxScopeCursorRow | null> = [
    { readStateVersion: 1, maxReadSeq: "5", latestActivityMessageId: "m-1", latestActivitySeq: "9" },
    null,
    { readStateVersion: 2, maxReadSeq: "NOT_A_NUMBER", latestActivityMessageId: null, latestActivitySeq: null },
    { readStateVersion: 0, maxReadSeq: "0", latestActivityMessageId: null, latestActivitySeq: null },
  ];
  const reports: InboxScopeCursorCorruption[] = [];
  const out = rows.map((r) => makeInboxScopeReadFrontier(r, (c) => { reports.push(c); }));

  assert.deepEqual(out[0], {
    kind: "present", readStateVersion: 1, maxReadSeq: "5",
    latestActivity: { messageId: "m-1", seq: "9" },
  });
  assert.deepEqual(out[1], { kind: "absent" });
  assert.deepEqual(out[2], { kind: "corrupt" });
  assert.deepEqual(out[3], {
    kind: "present", readStateVersion: 0, maxReadSeq: "0", latestActivity: null,
  });
  assert.equal(reports.length, 1, "exactly one corruption report for the batch");
  assert.deepEqual(reports[0], { field: "maxReadSeq", reason: "not_canonical_decimal" });
});

test("value domain rides the sync-core canonical primitives (no second implementation)", () => {
  // Consumer-level sanity only — the primitives' own teeth live in sync-core.
  assert.equal(isUInt64String("9007199254740993"), true);
  assert.equal(isUInt64String("01"), false);
  assert.equal(compareUInt64String("9007199254740992", "9007199254740993") < 0, true);
});

test("a THROWING telemetry sink cannot break the batch: still corrupt, called once, neighbors intact", () => {
  const rows: Array<InboxScopeCursorRow | null> = [
    { readStateVersion: 1, maxReadSeq: "5", latestActivityMessageId: null, latestActivitySeq: null },
    { readStateVersion: 1, maxReadSeq: "boom", latestActivityMessageId: null, latestActivitySeq: null },
    { readStateVersion: 2, maxReadSeq: "7", latestActivityMessageId: null, latestActivitySeq: null },
  ];
  let calls = 0;
  const throwingSink = () => {
    calls += 1;
    throw new Error("telemetry sink exploded");
  };
  const out = rows.map((r) => makeInboxScopeReadFrontier(r, throwingSink));
  assert.equal(out[0].kind, "present", "scope before the corrupt one is unaffected");
  assert.equal(out[1].kind, "corrupt", "corrupt verdict survives the sink failure");
  assert.equal(out[2].kind, "present", "scope after the corrupt one is unaffected");
  assert.equal(calls, 1, "sink still called exactly once");
});

test("an ASYNC-REJECTING sink cannot kill the process: corrupt sync, once, no unhandledRejection", async () => {
  const rows: Array<InboxScopeCursorRow | null> = [
    { readStateVersion: 1, maxReadSeq: "5", latestActivityMessageId: null, latestActivitySeq: null },
    { readStateVersion: 1, maxReadSeq: "boom", latestActivityMessageId: null, latestActivitySeq: null },
    { readStateVersion: 2, maxReadSeq: "7", latestActivityMessageId: null, latestActivitySeq: null },
  ];
  let calls = 0;
  const asyncRejectingSink = async () => {
    calls += 1;
    throw new Error("async telemetry sink exploded");
  };
  const unhandled: unknown[] = [];
  const probe = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", probe);
  try {
    const out = rows.map((r) => makeInboxScopeReadFrontier(r, asyncRejectingSink));
    assert.equal(out[0].kind, "present");
    assert.equal(out[1].kind, "corrupt", "corrupt verdict returned synchronously");
    assert.equal(out[2].kind, "present");
    assert.equal(calls, 1, "sink still called exactly once");
    // Let any escaped rejection surface before judging.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "no unhandledRejection may escape the constructor");
  } finally {
    process.off("unhandledRejection", probe);
  }
});

test("corruption alarm line: stable shape, total, hostile scope never reflected", () => {
  const c: InboxScopeCursorCorruption = { field: "maxReadSeq", reason: "not_canonical_decimal" };
  assert.equal(
    formatInboxScopeCorruptionLine("3f0a2f0e-58c8-4dd5-9f6f-1af0f24c9f00", c),
    "inbox_cursor_corrupt scope=3f0a2f0e-58c8-4dd5-9f6f-1af0f24c9f00 field=maxReadSeq reason=not_canonical_decimal",
  );
  for (const hostile of ["not-a-uuid", "abc\n\x1b[31m", "", "3F0A2F0E-58C8-4DD5-9F6F-1AF0F24C9F00x"]) {
    const line = formatInboxScopeCorruptionLine(hostile, c);
    assert.equal(line.split("\n").length, 1, "one physical line");
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(line, /[\x00-\x1f\x7f]/, "no control chars");
    assert.match(line, /scope=invalid /, "hostile scope must not be reflected");
  }
});
