import assert from "node:assert/strict";

import type { DeliveryConsumptionActivityDiagnostic, TrajectoryEntry } from "@botiverse/raft-shared";
import {
  buildAgentActivityHashFields,
  fingerprintAgentRuntimeError,
  projectAgentActivityFromRedisHash,
  projectAgentRuntimeErrorFromRedisHash,
} from "../replicaRouter";
import { projectAgentActivityHintFromPersistedEvent } from "./agentActivityLogService";

test("legacy Redis activity cache without kind fields falls back from activity/detail", () => {
  const projected = projectAgentActivityFromRedisHash({
    activity: "working",
    detail: "legacy display text",
    updatedAt: "12345",
  });

  assert.deepEqual(projected, {
    activity: "working",
    detail: "legacy display text",
    detailKind: "other",
    updatedAt: 12345,
  });
});

// task #1116: the typed carrier is mirrored in the same hash as the snapshot so
// a non-owner replica's read-back exposes what the owner projected.
test("Redis activity cache decodes a mirrored delivery_unconsumed carrier and drops malformed ones", () => {
  const carrier = {
    launchId: "launch-1",
    episode: 1,
    unconsumedDeliveries: 3,
    firstUnconsumedAtMs: 1_000,
    lastDeliveryAtMs: 3_000,
    lastDeliveryKey: "msg-3",
    lastDeliveryPath: "stdin_idle_delivery",
    lastConsumptionKind: null,
    lastConsumptionAtMs: null,
    lastRuntimeResult: null,
    lastDeliveryErrorClass: null,
    processAlive: true,
  };
  const projected = projectAgentActivityFromRedisHash({
    activity: "online",
    detail: "3 deliveries written, runtime not consuming",
    detailKind: "delivery_unconsumed",
    updatedAt: "67890",
    carriers: JSON.stringify({ deliveryConsumption: carrier, unknownCarrier: { x: 1 } }),
  });
  assert.deepEqual(projected?.carriers, { deliveryConsumption: carrier }, "known carrier decoded verbatim, unknown keys dropped");

  assert.equal(
    projectAgentActivityFromRedisHash({ activity: "online", detail: "", detailKind: "delivery_unconsumed", updatedAt: "1", carriers: "{not json" })?.carriers,
    undefined,
    "malformed carrier field is dropped, not propagated",
  );
  assert.equal(
    projectAgentActivityFromRedisHash({ activity: "online", detail: "", detailKind: "delivery_unconsumed", updatedAt: "1", carriers: JSON.stringify({ deliveryConsumption: "nope" }) })?.carriers,
    undefined,
    "non-object carrier value is dropped",
  );
  assert.equal(
    "carriers" in (projectAgentActivityFromRedisHash({ activity: "working", detail: "x", detailKind: "running_command", updatedAt: "1" }) ?? {}),
    false,
    "a snapshot written without a carrier has no carriers field",
  );
  // Reviewer counterexample (task #1126): an object that is not a diagnostic
  // must not come back as one — decode goes through the normalizer.
  assert.equal(
    projectAgentActivityFromRedisHash({ activity: "online", detail: "", detailKind: "delivery_unconsumed", updatedAt: "1", carriers: JSON.stringify({ deliveryConsumption: { unexpected: "not a diagnostic" } }) })?.carriers,
    undefined,
    "a non-diagnostic object under deliveryConsumption is dropped",
  );
  const cleared = projectAgentActivityFromRedisHash({ activity: "working", detail: "x", detailKind: "running_command", updatedAt: "1", observedAtMs: "", carriers: "" });
  assert.deepEqual(cleared, { activity: "working", detail: "x", detailKind: "running_command", updatedAt: 1 }, "cleared (empty) optional fields decode as absent");
});

// Reviewer counterexample (task #1126): detail and carrier must land in ONE
// HSET so an interleaved reader cannot see a new detail beside an old carrier.
test("Redis activity snapshot is one hash write carrying detail and carriers together, clearing absent fields", () => {
  const carrier: DeliveryConsumptionActivityDiagnostic = {
    launchId: "launch-1",
    episode: 1,
    unconsumedDeliveries: 3,
    firstUnconsumedAtMs: 1_000,
    lastDeliveryAtMs: 3_000,
    lastDeliveryKey: "msg-3",
    lastDeliveryPath: "stdin_idle_delivery",
    lastConsumptionKind: null,
    lastConsumptionAtMs: null,
    lastRuntimeResult: null,
    lastDeliveryErrorClass: null,
    processAlive: true,
  };
  const withCarrier = buildAgentActivityHashFields({
    activity: "online",
    detail: "3 deliveries written, runtime not consuming",
    detailKind: "delivery_unconsumed",
    observedAtMs: 5,
    carriers: { deliveryConsumption: carrier },
    updatedAtMs: 10,
  });
  assert.deepEqual(Object.keys(withCarrier).sort(), ["activity", "carriers", "detail", "detailKind", "observedAtMs", "updatedAt"]);
  assert.deepEqual(JSON.parse(withCarrier.carriers!), { deliveryConsumption: carrier });
  const plain = buildAgentActivityHashFields({ activity: "working", detail: "Running tests", detailKind: "running_command", updatedAtMs: 11 });
  assert.equal(plain.carriers, "", "a write without a carrier clears the field in the same command");
  assert.equal(plain.observedAtMs, "", "a write without observedAtMs clears it in the same command");
  assert.deepEqual(Object.keys(plain).sort(), Object.keys(withCarrier).sort(), "every write names every field: no stale field survives a write");
});

test("Redis activity cache preserves observedAtMs separately from write clock", () => {
  const projected = projectAgentActivityFromRedisHash({
    activity: "working",
    detail: "running command",
    detailKind: "running_command",
    observedAtMs: "12345",
    updatedAt: "67890",
  });

  assert.deepEqual(projected, {
    activity: "working",
    detail: "running command",
    detailKind: "running_command",
    observedAtMs: 12345,
    updatedAt: 67890,
  });
});

test("Redis runtime-error mirror preserves the authority fingerprint and payload", () => {
  const error = {
    message: "Provider authentication failed",
    at: "2026-08-02T12:00:00.000Z",
    launchId: "launch-1",
    actionRequired: true,
  };

  assert.deepEqual(projectAgentRuntimeErrorFromRedisHash({
    state: "error",
    fingerprint: fingerprintAgentRuntimeError(error),
    message: error.message,
    at: error.at,
    launchId: error.launchId,
    actionRequired: "1",
    updatedAt: "12345",
  }), {
    error,
    fingerprint: fingerprintAgentRuntimeError(error),
    updatedAt: 12345,
  });
});

test("Redis runtime-error clear is an explicit tombstone and malformed fingerprints fail closed", () => {
  const fingerprint = fingerprintAgentRuntimeError(null);
  assert.deepEqual(projectAgentRuntimeErrorFromRedisHash({
    state: "clear",
    fingerprint,
    updatedAt: "67890",
  }), {
    error: null,
    fingerprint,
    updatedAt: 67890,
  });
  assert.equal(projectAgentRuntimeErrorFromRedisHash({
    state: "clear",
    fingerprint: "stale-error",
    updatedAt: "67890",
  }), null);
});

test("legacy persisted activity hint without detail kind remains readable", () => {
  const entries: TrajectoryEntry[] = [
    {
      kind: "status",
      activity: "working",
      detail: "legacy display text",
    },
  ];

  const projected = projectAgentActivityHintFromPersistedEvent({
    activity: "working",
    detail: "legacy display text",
    entries,
    createdAt: new Date(12345),
  });

  assert.deepEqual(projected, {
    activity: "working",
    detail: "legacy display text",
    detailKind: "other",
    updatedAt: 12345,
  });
});

// task #1123: the typed spawn-failure reason is mirrored beside the snapshot
// like the delivery carrier, and decoded through its own normalizer.
test("Redis activity cache decodes a mirrored spawnFailure carrier and drops malformed ones", () => {
  const projected = projectAgentActivityFromRedisHash({
    activity: "offline",
    detail: "Runtime start failed: model not found",
    detailKind: "runtime_unavailable",
    updatedAt: "1",
    carriers: JSON.stringify({ spawnFailure: { reason: "model_not_found", model: "claude-opus-5" }, unknownCarrier: 1 }),
  });
  assert.deepEqual(projected?.carriers, { spawnFailure: { reason: "model_not_found", model: "claude-opus-5" } });
  assert.equal(
    projectAgentActivityFromRedisHash({ activity: "offline", detail: "", detailKind: "runtime_unavailable", updatedAt: "1", carriers: JSON.stringify({ spawnFailure: { reason: "disk_full" } }) })?.carriers,
    undefined,
    "an unknown reason is dropped, not propagated",
  );
  assert.deepEqual(
    projectAgentActivityFromRedisHash({ activity: "offline", detail: "", detailKind: "runtime_unavailable", updatedAt: "1", carriers: JSON.stringify({ spawnFailure: { reason: "runtime_not_found", model: "should-not-echo" } }) })?.carriers,
    { spawnFailure: { reason: "runtime_not_found" } },
    "model travels only with model_not_found",
  );
});

// Reconciler step 4b: the held notice's typed reason is mirrored beside the
// idle snapshot so a non-owner replica serves it too; only a known reason.
test("Redis activity cache decodes a mirrored credentialHold carrier and drops unknown reasons", () => {
  const idle = (carriers: unknown) => projectAgentActivityFromRedisHash({
    activity: "online", detail: "held", detailKind: "idle", updatedAt: "1", carriers: JSON.stringify(carriers),
  })?.carriers;
  assert.deepEqual(idle({ credentialHold: { reason: "user_model_access", model: "not-echoed" } }), { credentialHold: { reason: "user_model_access" } });
  assert.deepEqual(idle({ credentialHold: { reason: "billing" } }), { credentialHold: { reason: "billing" } });
  assert.equal(idle({ credentialHold: { reason: "quota" } }), undefined, "an unknown reason is dropped, not propagated");
  assert.equal(idle({ credentialHold: "user_reauth" }), undefined, "a non-object value is dropped");
});
