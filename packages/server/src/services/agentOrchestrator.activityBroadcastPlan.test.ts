import assert from "node:assert/strict";
import { test } from "vitest";
import { planActivityBroadcastAction } from "./agentOrchestrator.js";

test("planActivityBroadcastAction persists and emits immediately when trajectory entries are present", () => {
  assert.equal(
    planActivityBroadcastAction({
      hasEntries: true,
      isHeartbeat: false,
      isProbeResponse: false,
      isDeliveryAckTurnActive: false,
      shouldPersistStatusOnly: false,
    }),
    "persist-and-emit-now",
  );
});

test("planActivityBroadcastAction persists and emits immediately for durable status-only transitions", () => {
  assert.equal(
    planActivityBroadcastAction({
      hasEntries: false,
      isHeartbeat: false,
      isProbeResponse: false,
      isDeliveryAckTurnActive: false,
      shouldPersistStatusOnly: true,
    }),
    "persist-and-emit-now",
  );
});

test("planActivityBroadcastAction debounces non-durable status-only pulses", () => {
  assert.equal(
    planActivityBroadcastAction({
      hasEntries: false,
      isHeartbeat: false,
      isProbeResponse: false,
      isDeliveryAckTurnActive: false,
      shouldPersistStatusOnly: false,
    }),
    "debounce-only",
  );
});

test("planActivityBroadcastAction refreshes heartbeat status without persistence", () => {
  assert.equal(
    planActivityBroadcastAction({
      hasEntries: false,
      isHeartbeat: true,
      isProbeResponse: false,
      isDeliveryAckTurnActive: false,
      shouldPersistStatusOnly: true,
    }),
    "heartbeat-refresh",
  );
});

test("planActivityBroadcastAction never drops trajectory entries mislabeled as heartbeat", () => {
  assert.equal(
    planActivityBroadcastAction({
      hasEntries: true,
      isHeartbeat: true,
      isProbeResponse: false,
      isDeliveryAckTurnActive: false,
      shouldPersistStatusOnly: true,
    }),
    "persist-and-emit-now",
  );
});

test("planActivityBroadcastAction refreshes activity-probe snapshots without persistence", () => {
  assert.equal(
    planActivityBroadcastAction({
      hasEntries: false,
      isHeartbeat: false,
      isProbeResponse: true,
      isDeliveryAckTurnActive: false,
      shouldPersistStatusOnly: true,
    }),
    "probe-refresh",
  );
});

test("planActivityBroadcastAction never drops trajectory entries carrying a probe id", () => {
  assert.equal(
    planActivityBroadcastAction({
      hasEntries: true,
      isHeartbeat: false,
      isProbeResponse: true,
      isDeliveryAckTurnActive: false,
      shouldPersistStatusOnly: true,
    }),
    "persist-and-emit-now",
  );
});

test("planActivityBroadcastAction refreshes delivery-ack turn-active without persistence", () => {
  assert.equal(
    planActivityBroadcastAction({
      hasEntries: false,
      isHeartbeat: false,
      isProbeResponse: false,
      isDeliveryAckTurnActive: true,
      shouldPersistStatusOnly: true,
    }),
    "delivery-ack-refresh",
  );
});
