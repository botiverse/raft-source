import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentMessage } from "@botiverse/raft-shared";
import { AgentStartPendingDeliveryBuffer } from "./agentStartPendingDeliveryBuffer.js";

function message(content: string, messageId = content): AgentMessage {
  return {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "User",
    sender_type: "human",
    content,
    timestamp: "2026-01-01T00:00:00.000Z",
    message_id: messageId,
    seq: 1,
  };
}

test("AgentStartPendingDeliveryBuffer transition table preserves pending wake exactly once", () => {
  const buffer = new AgentStartPendingDeliveryBuffer();

  assert.equal(buffer.bufferDuringStart("agent-1", message("during-start")), 1);
  assert.equal(buffer.bufferDuringStart("agent-1", message("during-cooldown")), 2);
  buffer.assertInvariants("queued/start/cooldown", {
    queuedAgentIds: ["agent-1"],
    startingAgentIds: [],
    cooldownAgentIds: ["agent-1"],
  });

  buffer.rebindWake("agent-1", message("old-wake"), message("new-wake"), (left, right) => left.message_id === right.message_id);
  assert.deepEqual(
    buffer.values("agent-1").map((item) => item.content),
    ["during-start", "during-cooldown", "old-wake"],
    "rebindWake merges the old wake instead of overwriting pending delivery",
  );

  const drained = buffer.drainOnSpawn("agent-1");
  assert.deepEqual(
    drained.map((item) => item.content),
    ["during-start", "during-cooldown", "old-wake"],
    "drainOnSpawn returns each pending wake once",
  );
  assert.equal(buffer.has("agent-1"), false, "drainOnSpawn clears the owner buffer");

  buffer.cancelStart("agent-1");
  assert.equal(buffer.has("agent-1"), false, "cancelStart is idempotent after drain");
});

test("AgentStartPendingDeliveryBuffer proof-of-catch: DROP is blocked by rebindWake merge", () => {
  const buffer = new AgentStartPendingDeliveryBuffer();
  buffer.bufferDuringStart("agent-1", message("already-pending"));

  buffer.rebindWake("agent-1", message("old-wake"), message("new-wake"), () => false);

  assert.deepEqual(
    buffer.values("agent-1").map((item) => item.content),
    ["already-pending", "old-wake"],
    "regression catch: rebindWake must append the old wake without dropping already-pending delivery",
  );
});

test("AgentStartPendingDeliveryBuffer proof-of-catch: DUP is blocked by drainOnSpawn transfer", () => {
  const buffer = new AgentStartPendingDeliveryBuffer();

  buffer.bufferDuringStart("agent-1", message("wake"));
  assert.deepEqual(buffer.drainOnSpawn("agent-1").map((item) => item.content), ["wake"]);

  buffer.bufferDuringStart("agent-1", message("later-wake"));

  assert.deepEqual(
    buffer.drainOnSpawn("agent-1").map((item) => item.content),
    ["later-wake"],
    "regression catch: a second drain can only deliver newly-buffered work, not the prior drained wake",
  );
});

test("AgentStartPendingDeliveryBuffer proof-of-catch: ORPHAN is blocked by cancelStart cleanup", () => {
  const buffer = new AgentStartPendingDeliveryBuffer();

  buffer.bufferDuringStart("agent-1", message("wake"));
  buffer.cancelStart("agent-1");

  assert.equal(buffer.has("agent-1"), false);
  assert.doesNotThrow(() =>
    buffer.assertInvariants("cancelled start", {
      queuedAgentIds: [],
      startingAgentIds: [],
    }),
  );
});

test("AgentStartPendingDeliveryBuffer values returns a snapshot, not mutable owner state", () => {
  const buffer = new AgentStartPendingDeliveryBuffer();

  buffer.bufferDuringStart("agent-1", message("wake"));
  const snapshot = buffer.values("agent-1");
  snapshot.push(message("external-mutation"));

  assert.equal(buffer.count("agent-1"), 1);
  assert.deepEqual(buffer.values("agent-1").map((item) => item.content), ["wake"]);
});

test("AgentStartPendingDeliveryBuffer proof-of-catch: non-starting pending owner is rejected", () => {
  const buffer = new AgentStartPendingDeliveryBuffer();

  buffer.bufferDuringStart("agent-1", message("wake"));

  assert.throws(
    () =>
      buffer.assertInvariants("non-starting pending", {
        queuedAgentIds: [],
        startingAgentIds: [],
      }),
    /pending messages for non-starting agent agent-1/,
  );
});

test("AgentStartPendingDeliveryBuffer suppressConsumed removes matching pending messages without raw access", () => {
  const buffer = new AgentStartPendingDeliveryBuffer();

  buffer.bufferDuringStart("agent-1", message("seen", "seen-id"));
  buffer.bufferDuringStart("agent-1", message("unseen", "unseen-id"));

  const removed = buffer.suppressConsumed("agent-1", (item) => item.message_id === "seen-id");

  assert.equal(removed, 1);
  assert.deepEqual(buffer.values("agent-1").map((item) => item.content), ["unseen"]);
});
