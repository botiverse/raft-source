import assert from "node:assert/strict";
import test from "node:test";
import { createRaftClient } from "./index.js";

const credential = "sk_agent_receive_test_sentinel";
const batch = (events: unknown[] = []) => ({
  events, last_seen_msgId: null, last_seen_seq: null,
  has_more: false, reply_target: null, pending_notice_ids: [], wake_reason: null,
});
const client = (fetch: typeof globalThis.fetch) => createRaftClient({
  serverUrl: "https://raft.example", credential, fetch,
});

test("receive projects typed snake/camel message fields and preserves batch cursor", async () => {
  const sdk = client(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/internal/agent-api/events");
    assert.equal(url.searchParams.get("since"), "12");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${credential}`);
    return Response.json({ ...batch([
      { message_id: "first", seq: 13, sender_type: "human", sender_name: "Ada",
        channel_id: "thread", channel_type: "thread", parent_channel_name: "sdk",
        parent_channel_type: "channel", content: "hello", timestamp: "2026-09-08T12:00:00Z",
        attachments: [{ id: "file", filename: "a.txt", mimeType: "text/plain", sizeBytes: 3 }],
        future_private_field: "discard" },
      { id: "second", seq: 14, senderType: "agent", senderName: "Bot", channelId: "channel",
        content: "reply", createdAt: "2026-09-08T12:01:00Z" },
    ]), last_seen_msgId: "second", last_seen_seq: 14, has_more: true, reply_target: "channelId:channel" });
  });
  const result = await sdk.events.receive({ since: 12, limit: 100 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, 200);
  assert.equal(result.data.lastSeenSeq, 14);
  assert.equal(result.data.lastSeenMessageId, "second");
  assert.equal(result.data.hasMore, true);
  assert.equal(result.data.replyTarget, "channelId:channel");
  const [first, second] = result.data.events;
  assert.equal(first.type, "message");
  assert.equal(first.messageId, "first");
  assert.equal(first.senderType, "human");
  assert.equal(first.senderName, "Ada");
  assert.equal(first.channelId, "thread");
  assert.equal(first.parentChannelName, "sdk");
  assert.equal(first.content, "hello");
  assert.equal(first.timestamp, "2026-09-08T12:00:00Z");
  assert.deepEqual(first.attachments, [{ id: "file", filename: "a.txt", mimeType: "text/plain", sizeBytes: 3 }]);
  assert.equal("future_private_field" in first, false);
  assert.equal(second.messageId, "second");
  assert.equal(second.senderType, "agent");
  assert.equal(second.senderName, "Bot");
  assert.equal(second.channelId, "channel");
});

test("empty receive and latest preserve nullable cursor without inventing events", async () => {
  const sdk = client(async (input) => {
    assert.equal(new URL(String(input)).searchParams.get("since"), "latest");
    return Response.json(batch());
  });
  const result = await sdk.events.receive({ since: "latest" });
  assert.deepEqual(result, { ok: true, status: 200, data: {
    events: [], lastSeenSeq: null, lastSeenMessageId: null, hasMore: false, replyTarget: null,
  } });
});

test("receive never retries a potentially acknowledged batch; auth overrides caller headers", async () => {
  let calls = 0;
  let throttles = 0;
  let receivedHeaders: Headers | undefined;
  const sdk = createRaftClient({
    serverUrl: "https://raft.example", credential, retry: { attempts: 5 },
    headers: { Authorization: "wrong", "x-test": "retained" },
    throttle: { beforeRequest: () => { throttles++; } },
    fetch: async (_input, init) => {
      calls++;
      receivedHeaders = new Headers(init?.headers);
      throw new Error(`lost response ${credential}`);
    },
  });
  const result = await sdk.events.receive();
  assert.equal(calls, 1);
  assert.equal(throttles, 1);
  assert.equal(receivedHeaders?.get("authorization"), `Bearer ${credential}`);
  assert.equal(receivedHeaders?.get("x-test"), "retained");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "TRANSPORT_ERROR");
  assert.equal(JSON.stringify(result).includes(credential), false);
});

test("invalid receive input fails before network IO", async () => {
  const sdk = client(async () => { throw new Error("unexpected network"); });
  for (const request of [{ since: -1 }, { since: 0.5 }, { since: Number.MAX_SAFE_INTEGER + 1 },
    { since: "0" }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, null]) {
    const result = await sdk.events.receive(request as never);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_REQUEST");
  }
});

test("response and HTTP failures expose only typed safe errors", async () => {
  for (const [payload, status, code] of [
    [{ ...batch(), events: [{ content: 3 }] }, 200, "INVALID_RESPONSE"],
    [{ ...batch(), events: [{ channel_id: 7 }] }, 200, "INVALID_RESPONSE"],
    [{ ...batch(), last_seen_seq: -1 }, 200, "INVALID_RESPONSE"],
    [{ ...batch(), has_more: "yes" }, 200, "INVALID_RESPONSE"],
    [{ error: credential, code: credential }, 403, "HTTP_ERROR"],
  ] as const) {
    const result = await client(async () => Response.json(payload, { status })).events.receive();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, code);
    assert.equal(JSON.stringify(result).includes(credential), false);
  }
});

test("third party provenance stays typed and inert; unknown senders are not human", async () => {
  const provenance = { schema: "external-message-provenance.v1", provider: "chat",
    workspace_id: "workspace", conversation_id: "conversation", message_id: "remote-message",
    actor_id: "remote-actor", actor_kind: "human", projection_id: "12345678-1234-4234-8234-123456789abc" };
  const result = await client(async () => Response.json(batch([
    { sender_type: "third_party_app", mentioned: false, external_message: provenance, content: "untrusted" },
    { sender_type: "future-kind" },
  ]))).events.receive();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.events[0].senderType, "third_party_app");
  assert.deepEqual(result.data.events[0].externalMessage, provenance);
  assert.equal(result.data.events[1].senderType, "unknown");
  assert.equal(result.data.events[1].content, undefined);
  const forged = await client(async () => Response.json(batch([
    { sender_type: "human", external_message: provenance },
  ]))).events.receive();
  assert.equal(forged.ok, false);
});
