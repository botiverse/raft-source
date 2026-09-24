import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  acceptActivityReadAllAck,
  getAcceptedActivityReadState,
  getActivityReadStateRevision,
  hasActivityReadHold,
  releaseActivityReadHoldForMessage,
  resetActivityReadStateForTests,
} from "../src/store/activityReadState.js";
import type {
  ActivityReadStateIngressContext,
} from "../src/store/activityReadState.js";

const context: ActivityReadStateIngressContext = {
  serverId: "server-a",
  principalId: "viewer-a",
  serverEpoch: 7,
  generation: 3,
};

afterEach(resetActivityReadStateForTests);

test("successful read-all ACK installs a receiver-private accepted read hold", () => {
  assert.equal(getActivityReadStateRevision(), 0);
  assert.equal(
    acceptActivityReadAllAck(context, "scope-a", { seq: 12, readStateVersion: 4 }).kind,
    "max_advanced",
  );
  assert.equal(hasActivityReadHold(context, "scope-a"), true);
  assert.deepEqual(getAcceptedActivityReadState(context, "scope-a"), {
    serverId: "server-a",
    principalId: "viewer-a",
    scopeId: "scope-a",
    maxReadSeq: 12,
    readStateVersion: 4,
  });
  assert.equal(getActivityReadStateRevision(), 1);
});

test("hold identity partitions server, principal, and scope", () => {
  acceptActivityReadAllAck(context, "scope-a", { seq: 12, readStateVersion: 4 });
  assert.equal(hasActivityReadHold(context, "scope-a"), true);
  assert.equal(hasActivityReadHold({ serverId: "server-b", principalId: "viewer-a" }, "scope-a"), false);
  assert.equal(hasActivityReadHold({ serverId: "server-a", principalId: "viewer-b" }, "scope-a"), false);
  assert.equal(hasActivityReadHold(context, "scope-b"), false);
});

test("only a newer real message releases the hold", () => {
  acceptActivityReadAllAck(context, "scope-a", { seq: 12, readStateVersion: 4 });
  assert.equal(releaseActivityReadHoldForMessage(context, "scope-a", 12), false);
  assert.equal(releaseActivityReadHoldForMessage(context, "scope-a", 11), false);
  assert.equal(hasActivityReadHold(context, "scope-a"), true);
  assert.equal(releaseActivityReadHoldForMessage(context, "scope-a", 13), true);
  assert.equal(hasActivityReadHold(context, "scope-a"), false);
  assert.equal(getActivityReadStateRevision(), 2);
});

test("late duplicate ACK cannot reactivate a hold released by newer activity", () => {
  const payload = { seq: 12, readStateVersion: 4 };
  acceptActivityReadAllAck(context, "scope-a", payload);
  releaseActivityReadHoldForMessage(context, "scope-a", 13);
  assert.equal(acceptActivityReadAllAck(context, "scope-a", payload).kind, "duplicate_dropped");
  assert.equal(hasActivityReadHold(context, "scope-a"), false);
  assert.equal(getActivityReadStateRevision(), 2, "duplicate is revision-neutral");
});

test("a newer live message seen before the ACK prevents a stale hold from being installed", () => {
  assert.equal(releaseActivityReadHoldForMessage(context, "scope-a", 13), false);
  assert.equal(
    acceptActivityReadAllAck(context, "scope-a", { seq: 12, readStateVersion: 4 }).kind,
    "max_advanced",
  );
  assert.equal(hasActivityReadHold(context, "scope-a"), false);
  assert.equal(getActivityReadStateRevision(), 1, "the accepted fact still fences admitted snapshots");
});

test("higher version may rewind maxReadSeq while equal-version conflict fails closed", () => {
  acceptActivityReadAllAck(context, "scope-a", { seq: 12, readStateVersion: 4 });
  assert.equal(
    acceptActivityReadAllAck(context, "scope-a", { seq: 9, readStateVersion: 5 }).kind,
    "max_advanced",
  );
  assert.equal(getAcceptedActivityReadState(context, "scope-a")?.maxReadSeq, 9);

  assert.equal(
    acceptActivityReadAllAck(context, "scope-a", { seq: 8, readStateVersion: 5 }).kind,
    "violation",
  );
  assert.equal(getAcceptedActivityReadState(context, "scope-a")?.maxReadSeq, 9);
});

test("malformed or unauthenticated ACK never creates a fact or hold", () => {
  assert.deepEqual(
    acceptActivityReadAllAck(context, "scope-a", { seq: -1, readStateVersion: 1 }),
    { kind: "invalid" },
  );
  assert.deepEqual(
    acceptActivityReadAllAck(context, "scope-a", { seq: "1", readStateVersion: 1 }),
    { kind: "invalid" },
  );
  assert.deepEqual(
    acceptActivityReadAllAck(context, "scope-a", { seq: 1, readStateVersion: null }),
    { kind: "invalid" },
  );
  assert.deepEqual(
    acceptActivityReadAllAck({ ...context, principalId: null }, "scope-a", { seq: 1, readStateVersion: 1 }),
    { kind: "invalid" },
  );
  assert.equal(hasActivityReadHold(context, "scope-a"), false);
  assert.equal(getActivityReadStateRevision(), 0);
});
