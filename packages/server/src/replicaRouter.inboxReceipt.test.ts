import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import type { AgentMessage } from "@botiverse/raft-shared";
import {
  __setInboxDeliveryReceiptRouteRuntimeForTests,
  __setInboxDeliveryReceiptRuntimeForTests,
  handleReplicaMessage,
  routeInboxDeliveryWithReceipt,
  type RoutedInboxDeliveryReceipt,
} from "./replicaRouter.js";

const message: AgentMessage = {
  channel_id: "channel-1",
  channel_name: "general",
  channel_type: "channel",
  sender_id: "sender-1",
  sender_name: "Sender",
  sender_type: "agent",
  content: "receipt-required mention",
  timestamp: "2026-07-14T09:00:00.000Z",
  message_id: "message-1",
  seq: 41,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __setInboxDeliveryReceiptRuntimeForTests(null, null);
  __setInboxDeliveryReceiptRouteRuntimeForTests(null);
});

test("strict source route emits the receipt wire type and returns the target acknowledgement", async () => {
  const captured: { outgoing?: Record<string, unknown> } = {};
  let acceptedOptions: unknown = null;
  __setInboxDeliveryReceiptRuntimeForTests(
    async (_agentId, _machineId, _message, options) => {
      acceptedOptions = options;
      return { status: "queued", reason: "replayable_inbox" };
    },
    async (_replyReplicaId, requestId, receipt) => {
      handleReplicaMessage("slock:replica:source", JSON.stringify({
        type: "inbox:receipt",
        requestId,
        payload: receipt,
      }));
    },
  );
  __setInboxDeliveryReceiptRouteRuntimeForTests({
    isAvailable: () => true,
    getTargetReplica: async () => "replica-target",
    publish: async (_targetReplicaId, raw) => {
      captured.outgoing = JSON.parse(raw) as Record<string, unknown>;
      handleReplicaMessage("slock:replica:target", raw);
      return 1;
    },
  });

  const result = await routeInboxDeliveryWithReceipt(
    "agent-1",
    "machine-1",
    message,
    new Set(),
    { adminAuthority: true },
  );

  assert.equal(captured.outgoing?.type, "inbox:deliver:receipt");
  assert.equal(typeof captured.outgoing?.requestId, "string");
  assert.equal(typeof captured.outgoing?.replyReplicaId, "string");
  assert.deepEqual(captured.outgoing?.deliveryOptions, { adminAuthority: true });
  assert.deepEqual(acceptedOptions, { adminAuthority: true });
  assert.deepEqual(result, {
    routed: true,
    receipt: { status: "queued", reason: "replayable_inbox" },
  });
});

test("reconciliation source route uses a version-safe wire and returns the current target acknowledgement", async () => {
  const captured: { outgoing?: Record<string, unknown> } = {};
  let acceptedOptions: unknown = null;
  __setInboxDeliveryReceiptRuntimeForTests(
    async (_agentId, _machineId, _message, options) => {
      acceptedOptions = options;
      return { status: "queued", reason: "replayable_inbox" };
    },
    async (_replyReplicaId, requestId, receipt) => {
      handleReplicaMessage("slock:replica:source", JSON.stringify({
        type: "inbox:receipt",
        requestId,
        payload: receipt,
      }));
    },
  );
  __setInboxDeliveryReceiptRouteRuntimeForTests({
    isAvailable: () => true,
    getTargetReplica: async () => "replica-target",
    publish: async (_targetReplicaId, raw) => {
      captured.outgoing = JSON.parse(raw) as Record<string, unknown>;
      handleReplicaMessage("slock:replica:target", raw);
      return 1;
    },
  });

  const result = await routeInboxDeliveryWithReceipt(
    "agent-1",
    "machine-1",
    message,
    new Set(),
    {
      adminAuthority: true,
      reconcileNonMemberMention: true,
      mentionDeliveryOccurrenceId: "11111111-1111-4111-8111-111111111111",
    },
  );

  assert.equal(captured.outgoing?.type, "inbox:deliver:reconcile-receipt");
  assert.deepEqual(captured.outgoing?.deliveryOptions, {
    adminAuthority: true,
    reconcileNonMemberMention: true,
    mentionDeliveryOccurrenceId: "11111111-1111-4111-8111-111111111111",
  });
  assert.deepEqual(acceptedOptions, {
    adminAuthority: true,
    reconcileNonMemberMention: true,
    mentionDeliveryOccurrenceId: "11111111-1111-4111-8111-111111111111",
  });
  assert.deepEqual(result, {
    routed: true,
    receipt: { status: "queued", reason: "replayable_inbox" },
  });
});

test("reconciliation source fails closed when an older target ignores the new wire", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  let publishedRaw = "";
  let resolvePublished!: () => void;
  const published = new Promise<void>((resolve) => {
    resolvePublished = resolve;
  });
  __setInboxDeliveryReceiptRouteRuntimeForTests({
    isAvailable: () => true,
    getTargetReplica: async () => "replica-target-old",
    publish: async (_targetReplicaId, raw) => {
      publishedRaw = raw;
      resolvePublished();
      // Redis reports the old replica's subscription, but that replica only
      // recognizes `inbox:deliver:receipt` and therefore sends no response.
      return 1;
    },
  });

  const resultPromise = routeInboxDeliveryWithReceipt(
    "agent-1",
    "machine-1",
    message,
    new Set(),
    { reconcileNonMemberMention: true },
  );
  await published;
  assert.equal(
    (JSON.parse(publishedRaw) as { type?: unknown }).type,
    "inbox:deliver:reconcile-receipt",
  );

  vi.advanceTimersByTime(3_000);
  assert.deepEqual(await resultPromise, {
    routed: true,
    receipt: { status: "dropped", reason: "cross_replica_receipt_unavailable" },
  });
});

for (const malformedReceipt of [
  { status: "weird", reason: "unknown_status" },
  { status: "queued" },
  { status: "queued", reason: "" },
]) {
  test(`strict source route fails closed on malformed target receipt: ${JSON.stringify(malformedReceipt)}`, async () => {
    __setInboxDeliveryReceiptRouteRuntimeForTests({
      isAvailable: () => true,
      getTargetReplica: async () => "replica-target",
      publish: async (_targetReplicaId, raw) => {
        const outgoing = JSON.parse(raw) as { requestId?: unknown };
        assert.equal(typeof outgoing.requestId, "string");
        handleReplicaMessage("slock:replica:source", JSON.stringify({
          type: "inbox:receipt",
          requestId: outgoing.requestId,
          payload: malformedReceipt,
        }));
        return 1;
      },
    });

    assert.deepEqual(
      await routeInboxDeliveryWithReceipt("agent-1", "machine-1", message, new Set()),
      {
        routed: true,
        receipt: { status: "dropped", reason: "cross_replica_receipt_unavailable" },
      },
    );
  });
}

test("strict source route fails closed when the target replica has no subscriber", async () => {
  __setInboxDeliveryReceiptRouteRuntimeForTests({
    isAvailable: () => true,
    getTargetReplica: async () => "replica-target",
    publish: async () => 0,
  });

  assert.deepEqual(
    await routeInboxDeliveryWithReceipt("agent-1", "machine-1", message, new Set()),
    {
      routed: true,
      receipt: { status: "dropped", reason: "cross_replica_receipt_unavailable" },
    },
  );
});

test("strict source route returns a typed drop when owner lookup fails", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  __setInboxDeliveryReceiptRouteRuntimeForTests({
    isAvailable: () => true,
    getTargetReplica: async () => {
      throw new Error("redis unavailable");
    },
    publish: async () => {
      assert.fail("must not publish without a resolved owner");
    },
  });

  assert.deepEqual(
    await routeInboxDeliveryWithReceipt("agent-1", "machine-1", message, new Set()),
    {
      routed: true,
      receipt: { status: "dropped", reason: "cross_replica_receipt_unavailable" },
    },
  );
  assert.equal(errorLog.mock.calls.length, 1);
});

for (const expected of [
  { status: "queued", reason: "replayable_inbox" },
  { status: "dropped", reason: "agent_state_changed" },
] satisfies RoutedInboxDeliveryReceipt[]) {
  test(`receipt-required replica delivery returns target result: ${expected.status}`, async () => {
    let handled: { agentId: string; machineId: string | null; message: AgentMessage } | null = null;
    const published = new Promise<{
      replyReplicaId: string;
      requestId: string;
      receipt: RoutedInboxDeliveryReceipt;
    }>((resolve) => {
      __setInboxDeliveryReceiptRuntimeForTests(
        async (agentId, machineId, received) => {
          handled = { agentId, machineId, message: received };
          return expected;
        },
        async (replyReplicaId, requestId, receipt) => {
          resolve({ replyReplicaId, requestId, receipt });
        },
      );
    });

    handleReplicaMessage("slock:replica:target", JSON.stringify({
      type: "inbox:deliver:receipt",
      agentId: "agent-1",
      machineId: "machine-1",
      requestId: "request-1",
      replyReplicaId: "replica-source",
      payload: message,
    }));

    assert.deepEqual(await published, {
      replyReplicaId: "replica-source",
      requestId: "request-1",
      receipt: expected,
    });
    assert.deepEqual(handled, { agentId: "agent-1", machineId: "machine-1", message });
  });
}
