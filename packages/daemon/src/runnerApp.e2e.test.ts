import assert from "node:assert/strict";
import http from "node:http";
import { test } from "vitest";

import {
  registerAgentCredentialProxy,
  type AgentProxyFreshnessDecision,
  type AgentProxyInboxCoordinator,
  type AgentProxyVisibleMessage,
} from "./agentCredentialProxy.js";

type UpstreamObservation = {
  sendCount: number;
  sendBodies: Array<Record<string, unknown>>;
};

type ConsumedObservation = {
  target?: string;
  source: Parameters<AgentProxyInboxCoordinator["consumeVisibleMessages"]>[0]["source"];
  boundarySeq?: number;
  ids: Array<string | undefined>;
  seqs: number[];
};

async function withFakeSlockAgentApi(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  req.setEncoding("utf8");
  for await (const chunk of req) raw += String(chunk);
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function messageId(message: AgentProxyVisibleMessage): string | undefined {
  return message.message_id ?? message.id;
}

function normalizeConsume(input: Parameters<AgentProxyInboxCoordinator["consumeVisibleMessages"]>[0]): ConsumedObservation {
  return {
    target: input.target,
    source: input.source,
    boundarySeq: input.boundarySeq,
    ids: input.messages.map(messageId),
    seqs: input.messages.map((message) => Number(message.seq ?? 0)),
  };
}

function threadMessage(input: {
  seq: number;
  id: string;
  content: string;
  senderName?: string;
}): AgentProxyVisibleMessage {
  return {
    seq: input.seq,
    id: input.id,
    channel_type: "thread",
    channel_name: "974eb678",
    parent_channel_type: "channel",
    parent_channel_name: "proj-aiax",
    sender_type: "human",
    sender_name: input.senderName ?? "tygg",
    content: input.content,
    createdAt: "2026-06-07T14:24:22.000Z",
  };
}

async function sendThroughRunnerApp(input: {
  proxyUrl: string;
  proxyToken: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${input.proxyUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.proxyToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.body),
  });
  return {
    status: res.status,
    body: await res.json() as Record<string, unknown>,
  };
}

test("runner-app e2e: thread reply draft holds until same-thread send-draft", async () => {
  // Contract anchor: held #2644 / 9a7df3b3 — hold-when-unseen plus
  // thread-target-preservation. A draft replying to a thread must stay held
  // while that same thread has unseen counterparty context, and release to the
  // same thread target only after the context becomes model-seen.
  const threadTarget = "#proj-aiax:974eb678";
  const pendingThreadReply = threadMessage({
    seq: 974,
    id: "thread-reply-974",
    content: "new thread reply that must be seen before sending",
  });
  const upstream: UpstreamObservation = { sendCount: 0, sendBodies: [] };
  const consumed: ConsumedObservation[] = [];
  const decisions: AgentProxyFreshnessDecision[] = [];

  await withFakeSlockAgentApi(async (req, res) => {
    if (req.url === "/internal/agent-api/send") {
      upstream.sendCount += 1;
      upstream.sendBodies.push(await readJsonBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: "sent", messageId: "thread-send-1", messageSeq: 981 }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (serverUrl) => {
    const modelSeen = new Set<string>();
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-thread-draft-held",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: (target) => target === threadTarget && modelSeen.has("thread-reply-974") ? 974 : undefined,
        getPendingMessages: (target) => target === threadTarget ? [pendingThreadReply] : [],
        getAllPendingMessages: () => [pendingThreadReply],
        isMessageModelSeen: ({ message }) => {
          const id = messageId(message);
          return typeof id === "string" && modelSeen.has(id);
        },
        consumeVisibleMessages: (input) => {
          consumed.push(normalizeConsume(input));
        },
        recordFreshnessDecision: (input) => {
          decisions.push(input);
        },
      },
    });

    const held = await sendThroughRunnerApp({
      proxyUrl: handle.proxyUrl,
      proxyToken: handle.proxyToken,
      body: { target: threadTarget, content: "draft reply", seenUpToSeq: 973 },
    });

    assert.equal(upstream.sendCount, 0, "held draft must not forward to upstream before the thread reply is seen");
    assert.equal(held.status, 200);
    assert.equal(held.body.state, "held");
    assert.equal(held.body.outcome, "held");
    assert.equal(held.body.reason, "newer_messages_available");
    assert.deepEqual(held.body.available_actions, ["check_messages", "send_draft", "send_anyway"]);
    assert.equal(held.body.seenUpToSeq, 974);
    const heldMessages = held.body.heldMessages as Array<Record<string, unknown>>;
    assert.equal(heldMessages[0]?.message_id, "thread-reply-974");
    assert.equal(heldMessages[0]?.channel_type, "thread");
    assert.equal(heldMessages[0]?.channel_name, "974eb678");
    assert.equal(heldMessages[0]?.parent_channel_type, "channel");
    assert.equal(heldMessages[0]?.parent_channel_name, "proj-aiax");
    assert.deepEqual(consumed, [{
      target: threadTarget,
      source: "side_effect_preflight_context",
      boundarySeq: 974,
      ids: ["thread-reply-974"],
      seqs: [974],
    }]);
    assert.equal(decisions[0]?.decision, "local_hold");
    assert.equal(decisions[0]?.target, threadTarget);
    assert.equal(decisions[0]?.reason, "exact_target_pending");

    modelSeen.add("thread-reply-974");
    const sent = await sendThroughRunnerApp({
      proxyUrl: handle.proxyUrl,
      proxyToken: handle.proxyToken,
      body: {
        target: threadTarget,
        content: "draft reply",
        sendDraft: true,
        seenUpToSeq: held.body.seenUpToSeq,
      },
    });

    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    assert.equal(upstream.sendCount, 1, "send-draft forwards only after the pending thread reply is model-seen");
    assert.deepEqual(upstream.sendBodies, [{
      target: threadTarget,
      content: "draft reply",
      sendDraft: true,
      seenUpToSeq: 974,
    }]);
    assert.deepEqual(consumed, [
      {
        target: threadTarget,
        source: "side_effect_preflight_context",
        boundarySeq: 974,
        ids: ["thread-reply-974"],
        seqs: [974],
      },
      {
        target: threadTarget,
        source: "side_effect_preflight_context",
        boundarySeq: 974,
        ids: ["thread-reply-974"],
        seqs: [974],
      },
      {
        target: threadTarget,
        source: "agent_api_send_commit",
        boundarySeq: undefined,
        ids: ["thread-send-1"],
        seqs: [0],
      },
    ]);
    assert.equal(decisions[1]?.decision, "forward");
    assert.equal(decisions[1]?.target, threadTarget);
    assert.equal(decisions[1]?.reason, "exact_target_pending_already_seen");
  });
});

test("runner-app e2e: self send does not boundary-advance over unseen thread reply", async () => {
  // Contract anchor: held #2644 / 9a7df3b3 — self-set-not-boundary. Self sends
  // are marked by exact consumed id/set membership, not by advancing a
  // continuous model-seen boundary that could overshoot an older unseen
  // counterparty reply.
  const threadTarget = "#proj-aiax:974eb678";
  const unseenCounterparty = threadMessage({
    seq: 41,
    id: "counterparty-41",
    content: "older counterparty reply that must still hold",
  });
  const upstream: UpstreamObservation = { sendCount: 0, sendBodies: [] };
  const consumed: ConsumedObservation[] = [];
  const decisions: AgentProxyFreshnessDecision[] = [];

  await withFakeSlockAgentApi(async (req, res) => {
    if (req.url === "/internal/agent-api/send") {
      upstream.sendCount += 1;
      upstream.sendBodies.push(await readJsonBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: "sent", messageId: `self-${40 + upstream.sendCount}`, messageSeq: 40 + upstream.sendCount }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, async (serverUrl) => {
    let boundary = 40;
    let exposeCounterparty = false;
    const selfSeen = new Set<string>();
    const handle = await registerAgentCredentialProxy({
      agentId: "agent-1",
      launchId: "launch-thread-self-no-boundary-overshoot",
      serverUrl,
      apiKey: "sk_agent_server_side",
      activeCapabilities: "send,read",
      inboxCoordinator: {
        getBoundary: (target) => target === threadTarget ? boundary : undefined,
        getPendingMessages: (target) => target === threadTarget && exposeCounterparty ? [unseenCounterparty] : [],
        getAllPendingMessages: () => exposeCounterparty ? [unseenCounterparty] : [],
        isMessageModelSeen: ({ target, message }) => {
          if (target !== threadTarget) return false;
          const id = messageId(message);
          const seq = typeof message.seq === "number" ? message.seq : 0;
          return (typeof id === "string" && selfSeen.has(id)) || (seq > 0 && seq <= boundary);
        },
        consumeVisibleMessages: (input) => {
          consumed.push(normalizeConsume(input));
          for (const message of input.messages) {
            const id = messageId(message);
            if (typeof id === "string" && id.startsWith("self-")) selfSeen.add(id);
          }
          if (input.target === threadTarget && typeof input.boundarySeq === "number") {
            boundary = Math.max(boundary, input.boundarySeq);
          }
        },
        recordFreshnessDecision: (input) => {
          decisions.push(input);
        },
      },
    });

    const selfSent = await sendThroughRunnerApp({
      proxyUrl: handle.proxyUrl,
      proxyToken: handle.proxyToken,
      body: { target: threadTarget, content: "self update before counterparty is delivered" },
    });
    assert.equal(selfSent.status, 200);
    assert.equal(selfSent.body.state, "sent");
    assert.equal(boundary, 40, "self send must be marked by id, not by advancing the model-seen boundary");
    assert.deepEqual(consumed, [{
      target: threadTarget,
      source: "agent_api_send_commit",
      boundarySeq: undefined,
      ids: ["self-41"],
      seqs: [0],
    }]);

    exposeCounterparty = true;
    const held = await sendThroughRunnerApp({
      proxyUrl: handle.proxyUrl,
      proxyToken: handle.proxyToken,
      body: { target: threadTarget, content: "draft after self send", seenUpToSeq: boundary },
    });

    assert.equal(upstream.sendCount, 1, "unseen counterparty message must hold the next draft instead of forwarding");
    assert.equal(held.status, 200);
    assert.equal(held.body.state, "held");
    assert.equal(held.body.seenUpToSeq, 41);
    const heldMessages = held.body.heldMessages as Array<Record<string, unknown>>;
    assert.equal(heldMessages[0]?.message_id, "counterparty-41");
    assert.equal(decisions[1]?.decision, "local_hold");
    assert.equal(decisions[1]?.reason, "exact_target_pending");
  });
});
