import assert from "node:assert/strict";
import test from "node:test";

import { isExternalAgentCursorAdvancingProofLevel } from "@botiverse/raft-shared";
import {
  buildRaftChannelWakeFailedEvent,
  buildRaftChannelWakeInjectedEvent,
  raftChannelWakeManifest,
  createRaftChannelWakeAdapter,
} from "./raftChannelWakeAdapter.js";

const baseInput = {
  eventId: "event-1",
  attemptId: "attempt-1",
  messageId: "message-1",
  agentId: "agent-1",
  profile: "profile-1",
  coreSessionId: "core-1",
  adapterInstance: "adapter-1",
  runtimeSession: "claude-session-1",
  occurredAt: "2026-06-08T05:00:00.000Z",
};

test("Claude Code wake manifest declares spawn-core external harness plugin", () => {
  assert.equal(raftChannelWakeManifest.runtimeId, "claude");
  assert.equal(raftChannelWakeManifest.integrationPattern, "external-harness-plugin");
  assert.equal(raftChannelWakeManifest.commsMode, "spawn-core");
  assert.equal(raftChannelWakeManifest.bridgeLifecycle.explicitStartOnly, true);
  assert.equal(raftChannelWakeManifest.bridgeLifecycle.oneShotCommandsBridgeIndependent, true);
  assert.equal(raftChannelWakeManifest.bridgeLifecycle.autoStartDefault, false);
  assert.equal(raftChannelWakeManifest.serverApi.mode, "interim-agent-api-events");
  assert.equal(raftChannelWakeManifest.serverApi.deliveryOnly, true);
  assert.equal(raftChannelWakeManifest.serverApi.cursorAuthority, "model_seen_only");
  assert.equal(raftChannelWakeManifest.wakeAdapter.kind, "raft-channel");
  assert.equal(raftChannelWakeManifest.wakeAdapter.requiresInteractiveSession, true);
});

test("Claude Code adapter emits wake_injected proof without cursor authority", () => {
  const event = buildRaftChannelWakeInjectedEvent(baseInput);

  assert.equal(event.kind, "proof");
  assert.equal(event.proofLevel, "wake_injected");
  assert.equal(event.authority.source, "wake_adapter");
  assert.equal(isExternalAgentCursorAdvancingProofLevel(event.proofLevel), false);
});

test("Claude Code adapter failed wake preserves attempt identity and nullable runtime session", () => {
  const event = buildRaftChannelWakeFailedEvent(
    {
      ...baseInput,
      runtimeSession: null,
    },
    {
      failureClass: "no_session",
      reason: "Claude Code interactive --channels session is not attached",
    },
  );

  assert.equal(event.kind, "wake_attempt");
  assert.equal(event.outcome, "failed");
  assert.equal(event.runtimeSession, null);
  assert.equal(event.attemptId, "attempt-1");
  assert.equal(event.failureMeta.failureClass, "no_session");
  assert.equal("proofLevel" in event, false);
});

test("Claude Code channel wake adapter posts to plugin endpoint and emits wake_injected", async () => {
  const requests: unknown[] = [];
  const adapter = createRaftChannelWakeAdapter({
    endpointUrl: "http://127.0.0.1:49152/wake",
    token: "test-token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ ok: true, runtimeSession: "claude-session-2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const event = await adapter.wake({
    ...baseInput,
    runtimeSession: null,
  });

  assert.equal(event.kind, "proof");
  assert.equal(event.proofLevel, "wake_injected");
  assert.equal(event.runtimeSession, "claude-session-2");
  assert.equal(requests.length, 1);
  const request = requests[0] as { url: URL | RequestInfo; init?: RequestInit };
  assert.equal(String(request.url), "http://127.0.0.1:49152/wake");
  assert.equal(request.init?.method, "POST");
  assert.equal((request.init?.headers as Record<string, string>)["x-raft-bridge-token"], "test-token");
  assert.doesNotMatch(String(request.init?.body), /content|body|text/);
});

test("Claude Code channel wake adapter degrades when endpoint is missing or busy", async () => {
  const missing = createRaftChannelWakeAdapter();
  const missingEvent = await missing.wake(baseInput);
  assert.equal(missingEvent.kind, "wake_attempt");
  assert.equal(missingEvent.failureMeta.failureClass, "no_session");

  const busy = createRaftChannelWakeAdapter({
    endpointUrl: "http://127.0.0.1:49152/wake",
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      failureClass: "busy",
      reason: "Claude Code session is processing another turn",
      retryAfterMs: 5000,
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  });
  const busyEvent = await busy.wake(baseInput);
  assert.equal(busyEvent.kind, "wake_attempt");
  assert.equal(busyEvent.failureMeta.failureClass, "busy");
  assert.equal(busyEvent.failureMeta.retryAfterMs, 5000);
});
