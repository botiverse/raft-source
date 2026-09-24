import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BEHAVIOR_VECTORS_PATH,
  canonicalJson,
  runBehaviorVectors,
  runCase,
} from "./runBehaviorVectors.js";

const envelopes = readFileSync(BEHAVIOR_VECTORS_PATH, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

function caseNamed(caseId: string) {
  const envelope = envelopes.find((e) => e.caseId === caseId);
  assert.ok(envelope, `missing vector ${caseId}`);
  return runCase(envelope!);
}

interface ScopeRow {
  rowId: string;
  rowVersion: string;
  maxReadSeq: string;
  readStateVersion: string;
}

function onlyScope(result: ReturnType<typeof runCase>) {
  const values = Object.values(result.finalState);
  assert.equal(values.length, 1);
  return values[0] as { rows: ScopeRow[]; activityVersion: string | null };
}

// ---------------------------------------------------------------------------
// canonicalJson — the cross-platform serialisation contract
// ---------------------------------------------------------------------------

test("canonicalJson sorts object keys so key order cannot change the digest", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: 2, b: 1 }), '{"a":2,"b":1}');
  // Same facts written in a different order must serialise identically —
  // otherwise TS and KMP disagree for a reason that is not behavior.
  assert.equal(canonicalJson({ x: { q: 1, p: 2 } }), canonicalJson({ x: { p: 2, q: 1 } }));
});

test("canonicalJson preserves array order, because order IS behavior here", () => {
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("canonicalJson drops undefined in objects and nulls it in arrays", () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson([undefined, 1]), "[null,1]");
});

test("canonicalJson refuses non-finite numbers rather than emitting null", () => {
  assert.throws(() => canonicalJson({ n: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ n: Number.POSITIVE_INFINITY }), /non-finite/);
});

// ---------------------------------------------------------------------------
// observable behavior per vector — a digest over wrong behavior is still a digest
// ---------------------------------------------------------------------------

test("every sequenced ingress branch is exercised by the vectors", () => {
  const seen = new Set<string>();
  for (const envelope of envelopes) {
    for (const step of envelope.steps as Array<{ ingress: { type: string } }>) seen.add(step.ingress.type);
  }
  assert.deepEqual(
    [...seen].sort(),
    ["difference", "frame", "notModified", "readStateUpdated", "snapshot"],
    "a vector set that skips a branch claims coverage it does not have",
  );
});

test("baseline then ordered frames apply and order most-recent-first", () => {
  const result = caseNamed("baseline-then-ordered-frames");
  assert.deepEqual(result.steps.map((s) => (s.outcome as { kind: string }).kind), [
    "applied",
    "applied",
    "applied",
  ]);
  assert.deepEqual(onlyScope(result).rows.map((r) => r.rowId), ["b", "c", "a"]);
});

test("a gapped frame stop-gates and leaves a difference request pending", () => {
  const result = caseNamed("gap-stop-gates-into-repair");
  assert.deepEqual(result.steps.map((s) => (s.outcome as { kind: string }).kind), [
    "applied",
    "gap_repair_requested",
  ]);
  assert.deepEqual((result.pending as Array<{ kind: string }>).map((p) => p.kind), ["difference"]);
  // The gapped frame's row must NOT be in state.
  assert.deepEqual(onlyScope(result).rows.map((r) => r.rowId), ["a"]);
});

test("a late older rowVersion does not regress the row", () => {
  const rows = onlyScope(caseNamed("out-of-order-row-version-does-not-regress")).rows;
  assert.deepEqual(rows.map((r) => `${r.rowId}@${r.rowVersion}`), ["a@7"]);
});

test("sequences adjacent across 2^53 stay distinct through the whole runner", () => {
  // The original defect: the runner parsed wire UInt64String with `Number()`,
  // so watermark 9007199254740992 and seq 9007199254740993 collapsed to one
  // double. The frame was then judged a duplicate/conflict instead of the next
  // contiguous position. This drives the REAL runner path, not the core alone.
  const result = caseNamed("uint64-adjacent-across-2p53");
  assert.deepEqual(result.steps.map((s) => (s.outcome as { kind: string }).kind), [
    "applied",
    "applied",
  ]);
  assert.deepEqual(onlyScope(result).rows.map((r) => r.rowId), ["a"]);
  assert.deepEqual(result.violations, [], "a legitimate next position is not a conflict");
});

test("a difference response repairs the gap it was requested for", () => {
  const result = caseNamed("difference-repairs-the-gap");
  const kinds = result.steps.map((s) => (s.outcome as { kind: string }).kind);
  assert.deepEqual(kinds, ["applied", "gap_repair_requested", "applied"]);
  assert.deepEqual(onlyScope(result).rows.map((r) => r.rowId).sort(), ["a", "b", "c"]);
});

test("notModified changes nothing", () => {
  const result = caseNamed("not-modified-changes-nothing");
  assert.equal((result.steps[1]!.outcome as { kind: string }).kind, "not_modified");
  assert.equal(onlyScope(result).activityVersion, "5", "a notModified must not move the version");
});

test("a snapshot's own tombstone blocks a later stale frame", () => {
  const result = caseNamed("snapshot-tombstone-blocks-stale-resurrection");
  assert.deepEqual(onlyScope(result).rows, [], "the tombstoned row must stay gone");
});

test("commandReceipt and commandRejected are refused rather than given a fabricated seq", () => {
  // They carry no `seq` in the contract. Injecting `seq: 0` invented a position
  // the server never sent; runnerProtocol 1 refuses them instead.
  assert.throws(
    () => runCase({
      caseId: "x",
      steps: [{
        type: "ingest",
        stepId: "s1",
        ingress: { type: "commandReceipt", scope: { serverId: "s", principalId: "p", filter: "all", windowId: "w" }, receipt: {} },
      }],
    } as never),
    /not sequenced by runnerProtocol 1/,
  );
});

test("read state advances then ignores a stale readStateVersion", () => {
  const rows = onlyScope(caseNamed("read-state-updated-is-version-monotonic")).rows;
  assert.equal(rows[0]!.maxReadSeq, "42");
  assert.equal(rows[0]!.readStateVersion, "3");
});

// ---------------------------------------------------------------------------
// determinism — the property the cross-platform comparison rests on
// ---------------------------------------------------------------------------

test("the run is deterministic: identical bytes produce an identical digest", () => {
  const first = runBehaviorVectors(BEHAVIOR_VECTORS_PATH);
  const second = runBehaviorVectors(BEHAVIOR_VECTORS_PATH);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.cases, second.cases);
});

test("every vector contributes a distinct per-case digest", () => {
  const report = runBehaviorVectors(BEHAVIOR_VECTORS_PATH);
  assert.equal(report.cases.length, envelopes.length);
  // Distinct digests mean a divergence localises to one case rather than
  // collapsing into one opaque mismatch.
  assert.equal(new Set(report.cases.map((c) => c.digest)).size, report.cases.length);
});

test("the vectors file digest is reported so both platforms prove they ate the same bytes", () => {
  const report = runBehaviorVectors(BEHAVIOR_VECTORS_PATH);
  assert.match(report.vectorsSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.runnerProtocol, 1);
});
