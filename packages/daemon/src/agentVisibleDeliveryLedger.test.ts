import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentMessage } from "@botiverse/raft-shared";
import { AgentVisibleDeliveryLedger } from "./agentVisibleDeliveryLedger.js";

function pendingMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "User",
    sender_type: "human",
    content: "pending",
    timestamp: "2026-01-01T00:00:00.000Z",
    message_id: "m-1",
    seq: 1,
    ...overrides,
  };
}

test("AgentVisibleDeliveryLedger attention delivery records exact ids but does not advance boundary", () => {
  const ledger = new AgentVisibleDeliveryLedger();

  const consumed = ledger.recordConsumed("agent-1", {
    messages: [{ seq: 42, message_id: "m-42", channel_type: "channel", channel_name: "general" }],
    source: "spawn_wake_message",
  });

  assert.ok(consumed);
  assert.equal(
    ledger.getBoundary("agent-1", "#general"),
    undefined,
    "wake delivery is an attention signal and must not advance the model-seen high-water boundary",
  );
  assert.equal(ledger.getMessageIdSet("agent-1", "#general")?.has("m-42"), true);
  assert.equal(ledger.isModelSeen("agent-1", "#general", { seq: 41, message_id: "m-41" }), false);
  assert.equal(ledger.isModelSeen("agent-1", "#general", { seq: 42 }), false);
  assert.equal(ledger.isModelSeen("agent-1", "#general", { message_id: "m-42" }), true);
  assert.equal(consumed.shouldSuppress(pendingMessage({ message_id: "m-42", seq: 42 })), true);
});

test("AgentVisibleDeliveryLedger local events and stdin wake hints cannot advance boundary", () => {
  for (const source of ["agent_api_events_local", "stdin_idle_delivery", "stdin_thread_context_delivery"] as const) {
    const ledger = new AgentVisibleDeliveryLedger();

    ledger.recordConsumed("agent-1", {
      messages: [{ seq: 50, message_id: `m-${source}`, channel_type: "channel", channel_name: "general" }],
      source,
    });

    assert.equal(
      ledger.getBoundary("agent-1", "#general"),
      undefined,
      `${source} is an attention/delivery signal and must not advance model-seen high-water`,
    );
    assert.equal(ledger.isModelSeen("agent-1", "#general", { seq: 49, message_id: `gap-${source}` }), false);
    assert.equal(ledger.isModelSeen("agent-1", "#general", { message_id: `m-${source}` }), true);
  }
});

test("AgentVisibleDeliveryLedger proof-of-catch: set-only sources cannot advance boundary", () => {
  const ledger = new AgentVisibleDeliveryLedger();

  ledger.recordConsumed("agent-1", {
    messages: [{ seq: 50, message_id: "m-50", channel_type: "channel", channel_name: "general" }],
    source: "agent_api_history",
  });

  assert.equal(
    ledger.getBoundary("agent-1", "#general"),
    undefined,
    "regression catch: server/history visibility must not advance model-seen high-water boundary",
  );
  assert.equal(ledger.getMessageIdSet("agent-1", "#general")?.has("m-50"), true);
  assert.equal(ledger.isModelSeen("agent-1", "#general", { seq: 49, message_id: "m-49" }), false);
  assert.equal(ledger.isModelSeen("agent-1", "#general", { message_id: "m-50" }), true);
});

test("AgentVisibleDeliveryLedger proof-of-catch: explicit target mismatch is rejected", () => {
  const ledger = new AgentVisibleDeliveryLedger();

  assert.throws(
    () =>
      ledger.recordConsumed("agent-1", {
        target: "#private",
        messages: [{ seq: 7, message_id: "m-7", channel_type: "channel", channel_name: "general" }],
        source: "spawn_wake_message",
      }),
    /target mismatch/,
  );
  assert.equal(ledger.hasAgentState("agent-1"), false, "rejected visibility projection must not enter ledger state");
});

test("AgentVisibleDeliveryLedger keeps thread and parent channel targets isolated", () => {
  const ledger = new AgentVisibleDeliveryLedger();

  const consumed = ledger.recordConsumed("agent-1", {
    messages: [{
      seq: 70,
      message_id: "thread-70",
      channel_type: "thread",
      channel_name: "abcdef123456",
      parent_channel_name: "general",
      parent_channel_type: "channel",
    }],
    source: "spawn_wake_message",
  });

  assert.ok(consumed);
  assert.equal(ledger.getBoundary("agent-1", "#general"), undefined);
  assert.equal(ledger.getBoundary("agent-1", "#general:abcdef12"), undefined);
  assert.equal(consumed.shouldSuppress(pendingMessage({
    channel_id: "parent",
    channel_name: "general",
    channel_type: "channel",
    message_id: "thread-70",
    seq: 70,
  })), false);
  assert.equal(consumed.shouldSuppress(pendingMessage({
    channel_id: "thread",
    channel_name: "abcdef123456",
    channel_type: "thread",
    parent_channel_name: "general",
    parent_channel_type: "channel",
    message_id: "thread-70",
    seq: 70,
  })), true);
});
