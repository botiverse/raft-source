import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  STATE_TRANSITION_DOMAINS,
  STATE_TRANSITION_JOIN_FIELDS,
  STATE_TRANSITION_KEY_FIELDS,
  STATE_TRANSITION_META_FIELDS,
  STATE_VIOLATION_JOIN_FIELDS,
  STATE_VIOLATION_KEY_FIELDS,
  STATE_VIOLATION_KINDS,
  STATE_VIOLATION_META_FIELDS,
  TRACE_FAMILY_REGISTRY,
  InvalidTraceEntityDimensionError,
  assertTraceFamilyEntityFilterable,
  buildStateTransitionTraceAttrs,
  buildStateViolationTraceAttrs,
  traceFamilyRegistration,
} from "../index.js";

test("trace family registry has live consumers for every registered family", () => {
  assert.deepEqual(
    TRACE_FAMILY_REGISTRY.map((entry) => entry.family),
    ["slock.state.transition", "slock.state.violation", "slock.client_error", "server.db.query"],
  );

  for (const registration of TRACE_FAMILY_REGISTRY) {
    assert.ok(registration.consumers.length > 0, `${registration.family} must name a live consumer`);
    for (const consumer of registration.consumers) {
      assert.ok(consumer.what);
      assert.ok(consumer.how);
      assert.ok(consumer.whoRuns);
      assert.ok(consumer.runbook);
    }
    assert.ok(Array.isArray(registration.entityFilterableDimensions));
  }
});

test("entity-filterability is declared per family and invalid dimensions fail closed", () => {
  assert.deepEqual(traceFamilyRegistration("slock.state.transition").entityFilterableDimensions, ["entityId"]);
  assert.deepEqual(traceFamilyRegistration("slock.state.violation").entityFilterableDimensions, ["entityId"]);
  assert.deepEqual(traceFamilyRegistration("slock.client_error").entityFilterableDimensions, []);
  assert.deepEqual(traceFamilyRegistration("server.db.query").entityFilterableDimensions, []);

  assert.doesNotThrow(() => assertTraceFamilyEntityFilterable("slock.state.transition", "entityId"));
  assert.throws(
    () => assertTraceFamilyEntityFilterable("slock.client_error", "entityId"),
    (error: unknown) => {
      assert.ok(error instanceof InvalidTraceEntityDimensionError);
      assert.equal(error.code, "invalid-dimension");
      assert.match(error.message, /not entity-filterable/);
      return true;
    },
  );
  // Fail-closed negative control: the fleet-detection server.db.query family
  // declares no entity dimensions, so an entity filter must throw, not empty-match.
  assert.throws(
    () => assertTraceFamilyEntityFilterable("server.db.query", "entityId"),
    (error: unknown) => {
      assert.ok(error instanceof InvalidTraceEntityDimensionError);
      assert.equal(error.code, "invalid-dimension");
      assert.match(error.message, /not entity-filterable/);
      return true;
    },
  );
});

test("bisect family entity declarations equal their emitted key capability", () => {
  const familyKeyFields = new Map<string, readonly string[]>([
    ["slock.state.transition", STATE_TRANSITION_KEY_FIELDS],
    ["slock.state.violation", STATE_VIOLATION_KEY_FIELDS],
  ]);

  for (const registration of TRACE_FAMILY_REGISTRY) {
    if (registration.privacyTier !== "bisect") {
      assert.deepEqual(registration.entityFilterableDimensions, []);
      continue;
    }
    const keyFields = familyKeyFields.get(registration.family as "slock.state.transition" | "slock.state.violation");
    assert.ok(keyFields, `${registration.family} must register its emitted key schema`);
    assert.deepEqual(
      registration.entityFilterableDimensions,
      keyFields.filter((field) => field === "entityId"),
    );
  }
});

test("state transition registry permits entityId only because the family is bisect tier", () => {
  const registration = traceFamilyRegistration("slock.state.transition");
  assert.equal(registration.privacyTier, "bisect");

  const attrs = buildStateTransitionTraceAttrs({
    domain: "channel",
    event: "patch",
    entityId: "channel-1",
    touched: 1,
  });

  assert.deepEqual(Object.keys(attrs.key), STATE_TRANSITION_KEY_FIELDS);
  assert.deepEqual(Object.keys(attrs.meta), ["outcomeDetail", "touched"]);
  assert.equal("join" in attrs, false);
  assert.equal(attrs.key.entityId, "channel-1");
});

test("state transition schema keeps stable keys closed and arrival fields in meta", () => {
  const attrs = buildStateTransitionTraceAttrs({
    domain: "task",
    event: "upsert",
    entityId: "task-1",
    touched: 0,
    outcome: "noop",
    outcomeDetail: "unchanged",
    seq: 12,
    timestamp: "2026-07-07T00:00:00.000Z",
    reconcileSuggested: true,
  });

  assert.deepEqual(Object.keys(attrs.key), STATE_TRANSITION_KEY_FIELDS);
  assert.deepEqual(Object.keys(attrs.meta), [
    "outcomeDetail",
    "touched",
    "reconcileSuggested",
    "seq",
    "timestamp",
  ]);
  assert.equal(attrs.key.outcome, "noop");
  assert.equal("seq" in attrs.key, false);
  assert.equal("timestamp" in attrs.key, false);
  assert.ok(STATE_TRANSITION_DOMAINS.includes(attrs.key.domain));
  assert.deepEqual(STATE_TRANSITION_META_FIELDS, [
    "outcomeDetail",
    "touched",
    "recoveryAction",
    "reconcileSuggested",
    "epoch",
    "seq",
    "timestamp",
  ]);
  assert.ok(STATE_TRANSITION_DOMAINS.includes("messages"));
});

test("state transition join schema is registry-declared, opaque, and never key/meta", () => {
  const registration = traceFamilyRegistration("slock.state.transition");
  const clientEventId = randomUUID();
  const attrs = buildStateTransitionTraceAttrs({
    domain: "agents",
    event: "patch:trajectory-append",
    entityId: "agent-1",
    touched: 1,
    seq: 3,
    join: {
      clientEventId,
      content: "message text must not become a join key",
      userId: "user-1",
    } as { clientEventId: string },
  });

  assert.deepEqual(registration.joinKeys, STATE_TRANSITION_JOIN_FIELDS);
  assert.deepEqual(Object.keys(attrs.join ?? {}), registration.joinKeys);
  assert.deepEqual(attrs.join, { clientEventId });
  assert.equal("clientEventId" in attrs.key, false);
  assert.equal("clientEventId" in attrs.meta, false);
  assert.equal(JSON.stringify(attrs.key).includes(clientEventId), false);
  assert.equal(JSON.stringify(attrs.meta).includes(clientEventId), false);
  assertJoinKeysValueFree(registration.joinKeys);
});

test("state violation schema keeps producer order metadata out of stable keys", () => {
  const registration = traceFamilyRegistration("slock.state.violation");
  assert.equal(registration.privacyTier, "bisect");

  const attrs = buildStateViolationTraceAttrs({
    domain: "agents",
    entityId: "agent-1",
    violationKind: "producer_seq_conflict",
    epoch: "unknown",
    same_activity: true,
    same_detail_kind: false,
    same_detail_presence: true,
    same_detail_bucket: false,
    count: 2,
    event: "patch:trajectory-append",
    outcomeDetail: "producer_seq_conflict",
    serverSeq: 10,
    timestamp: 100,
    currentActivity: "working",
    projectedActivity: "working",
    currentDetailKind: "running_command",
    projectedDetailKind: "other",
  });

  assert.deepEqual(Object.keys(attrs.key), STATE_VIOLATION_KEY_FIELDS);
  assert.deepEqual(Object.keys(attrs.meta), [
    "count",
    "event",
    "outcomeDetail",
    "serverSeq",
    "timestamp",
    "currentActivity",
    "projectedActivity",
    "currentDetailKind",
    "projectedDetailKind",
  ]);
  assert.equal(attrs.key.domain, "agents");
  assert.equal(attrs.key.violationKind, "producer_seq_conflict");
  assert.equal(attrs.key.same_activity, true);
  assert.equal(attrs.key.same_detail_kind, false);
  assert.equal("serverSeq" in attrs.key, false);
  assert.equal("timestamp" in attrs.key, false);
  assert.ok(STATE_VIOLATION_KINDS.includes(attrs.key.violationKind));
  assert.deepEqual(STATE_VIOLATION_META_FIELDS, [
    "count",
    "event",
    "outcomeDetail",
    "serverSeq",
    "timestamp",
    "currentActivity",
    "projectedActivity",
    "currentDetailKind",
    "projectedDetailKind",
  ]);
  assert.ok(STATE_VIOLATION_KINDS.includes("version_regression"));
  assert.ok(STATE_VIOLATION_KINDS.includes("producer_version_conflict"));
});

test("state violation join schema is registry-declared, opaque, and never key/meta", () => {
  const registration = traceFamilyRegistration("slock.state.violation");
  const clientEventId = randomUUID();
  const attrs = buildStateViolationTraceAttrs({
    domain: "agents",
    entityId: "agent-1",
    violationKind: "producer_seq_conflict",
    epoch: "unknown",
    same_activity: true,
    same_detail_kind: true,
    same_detail_presence: true,
    same_detail_bucket: true,
    event: "patch:trajectory-append",
    join: {
      clientEventId,
      payload: "socket payload must not become a join key",
      senderName: "Alice",
    } as { clientEventId: string },
  });

  assert.deepEqual(registration.joinKeys, STATE_VIOLATION_JOIN_FIELDS);
  assert.deepEqual(Object.keys(attrs.join ?? {}), registration.joinKeys);
  assert.deepEqual(attrs.join, { clientEventId });
  assert.equal("clientEventId" in attrs.key, false);
  assert.equal("clientEventId" in attrs.meta, false);
  assert.equal(JSON.stringify(attrs.key).includes(clientEventId), false);
  assert.equal(JSON.stringify(attrs.meta).includes(clientEventId), false);
  assertJoinKeysValueFree(registration.joinKeys);
});

function assertJoinKeysValueFree(joinKeys: readonly string[] | undefined): void {
  assert.ok(joinKeys);
  for (const key of joinKeys) {
    assert.doesNotMatch(key, /content|message|payload|text|body|user|sender|name|email/i);
  }
}
