// Agent API auth suite: history, mentions, read cursors, message resolve,
// forwarded snapshots and search.
// Shared fixtures: ./internalAgentApi.auth.testkit.ts.
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { resolveAgentVisibleMessagePayload } from "./internal";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { BasicTracer, FORWARDED_RESOLVE_CAPABILITY, MemoryTraceSink } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { traceAgentIdHash, traceServerIdHash } from "../tracing/traceIdentity";
import {
  channelAgents,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  serverMembers,
  servers as serversTable,
  users,
} from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import {
  createChannel,
  addAgent,
  addHuman,
  findOrCreateAgentDM,
  findOrCreateDM,
  getAgentLegacyReadCursor,
  getOrCreateThread,
  markAgentLegacyRead,
} from "../services/channelService";
import { createMessage } from "../services/messageService";
import {
  jsonHeaders,
  waitForLegacyReadCursor,
  assertLegacyReadCursorStays,
  createAgentAttentionMessage,
  mintAgentKey,
  seedAuthFixture,
} from "./internalAgentApi.auth.testkit";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("agent-api mentions only returns target-visible mention rows", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();

  const pending = await createMessage(fixture.channelId, "user", fixture.ownerId, "pending @AgentApiAuthBot");
  const notified = await createMessage(fixture.channelId, "user", fixture.ownerId, "notified @AgentApiAuthBot");
  const ordinary = await createMessage(fixture.channelId, "user", fixture.ownerId, "ordinary @AgentApiAuthBot");

  await db.insert(messageMentions).values([
    {
      messageId: pending.id,
      messageSeq: pending.seq,
      serverId: fixture.serverId,
      channelId: fixture.channelId,
      targetType: "agent",
      targetId: fixture.agentId,
      handleAtSendTime: "AgentApiAuthBot",
      notifiableAtSend: false,
    },
    {
      messageId: notified.id,
      messageSeq: notified.seq,
      serverId: fixture.serverId,
      channelId: fixture.channelId,
      targetType: "agent",
      targetId: fixture.agentId,
      handleAtSendTime: "AgentApiAuthBot",
      notifiableAtSend: false,
      notifiedAt: new Date(),
      notifiedByType: "user",
      notifiedById: fixture.ownerId,
      notifiedAction: "notify_only",
    },
    {
      messageId: ordinary.id,
      messageSeq: ordinary.seq,
      serverId: fixture.serverId,
      channelId: fixture.channelId,
      targetType: "agent",
      targetId: fixture.agentId,
      handleAtSendTime: "AgentApiAuthBot",
    },
  ]);

  const res = await fetch(`${app.baseUrl}/internal/agent-api/mentions`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { mentions: Array<{ messageId: string }> };
  assert.deepEqual(
    body.mentions.map((mention) => mention.messageId).sort(),
    [notified.id, ordinary.id].sort(),
    "pending outsider mention rows must not appear in the agent target-side mentions feed",
  );
});

test("agent-api and legacy history conserve a caller-authored newest row and report page boundaries", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const first = await createMessage(fixture.channelId, "user", fixture.ownerId, "history page one");
  const second = await createMessage(fixture.channelId, "user", fixture.ownerId, "history page two");

  const channelRef = encodeURIComponent(`#${fixture.channelName}`);
  const exact = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&limit=2`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(exact.status, 200);
  const exactBody = await exact.json() as {
    messages: Array<{ id: string }>;
    has_more: boolean;
    has_older: boolean;
    has_newer: boolean;
  };
  assert.equal(exactBody.messages.length, 2);
  assert.deepEqual(exactBody.messages.map((message) => message.id), [first.id, second.id]);
  assert.equal(exactBody.has_more, false, "exactly limit rows must not imply another page");
  assert.equal(exactBody.has_older, false);
  assert.equal(exactBody.has_newer, false);

  const third = await createMessage(fixture.channelId, "agent", fixture.agentId, "history page three from caller");
  assert.ok(first.seq < second.seq && second.seq < third.seq, "fixture must contain three chronological rows");
  assert.equal(third.senderType, "agent", "fixture newest must be caller-authored");
  assert.equal(third.senderId, fixture.agentId, "fixture newest must be authored by the reading agent");
  await markAgentLegacyRead(fixture.agentId, fixture.channelId, third.seq);
  assert.equal(
    await getAgentLegacyReadCursor(fixture.agentId, fixture.channelId),
    third.seq,
    "fixture unread cursor must land on the caller-authored newest row",
  );

  const over = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&limit=2`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(over.status, 200);
  const overBody = await over.json() as {
    messages: Array<{ id: string }>;
    has_more: boolean;
    has_older: boolean;
    has_newer: boolean;
    last_read_seq: number;
  };
  assert.deepEqual(overBody.messages.map((message) => message.id), [second.id, third.id]);
  assert.equal(overBody.has_more, true);
  assert.equal(overBody.has_older, true);
  assert.equal(overBody.has_newer, false);
  assert.equal(overBody.last_read_seq, third.seq);

  const legacy = await fetch(`${app.baseUrl}/internal/agent/${fixture.agentId}/history?channel=${channelRef}&limit=2`, {
    headers: jsonHeaders(fixture.machineApiKey),
  });
  assert.equal(legacy.status, 200);
  const legacyBody = await legacy.json() as {
    messages: Array<{ id: string }>;
    has_more: boolean;
    has_older: boolean;
    has_newer: boolean;
    last_read_seq: number;
  };
  assert.deepEqual(legacyBody.messages.map((message) => message.id), [second.id, third.id]);
  assert.equal(legacyBody.has_more, true);
  assert.equal(legacyBody.has_older, true);
  assert.equal(legacyBody.has_newer, false);
  assert.equal(legacyBody.last_read_seq, third.seq);

  for (const endpoint of [
    {
      label: "agent-api",
      path: "/internal/agent-api/history",
      headers: jsonHeaders(fixture.readOnlyApiKey),
    },
    {
      label: "legacy",
      path: `/internal/agent/${fixture.agentId}/history`,
      headers: jsonHeaders(fixture.machineApiKey),
    },
  ]) {
    const after = await fetch(
      `${app.baseUrl}${endpoint.path}?channel=${channelRef}&after=${first.seq}&limit=1`,
      { headers: endpoint.headers },
    );
    assert.equal(after.status, 200, `${endpoint.label} after status`);
    const afterBody = await after.json() as {
      messages: Array<{ id: string }>;
      has_more: boolean;
      has_older: boolean;
      has_newer: boolean;
    };
    assert.deepEqual(afterBody.messages.map((message) => message.id), [second.id], `${endpoint.label} after page`);
    assert.equal(afterBody.has_more, true, `${endpoint.label} after has_more`);
    assert.equal(afterBody.has_older, false, `${endpoint.label} after has_older`);
    assert.equal(afterBody.has_newer, true, `${endpoint.label} after has_newer`);

    const before = await fetch(
      `${app.baseUrl}${endpoint.path}?channel=${channelRef}&before=${third.seq}&limit=1`,
      { headers: endpoint.headers },
    );
    assert.equal(before.status, 200, `${endpoint.label} before status`);
    const beforeBody = await before.json() as {
      messages: Array<{ id: string }>;
      has_more: boolean;
      has_older: boolean;
      has_newer: boolean;
    };
    assert.deepEqual(beforeBody.messages.map((message) => message.id), [second.id], `${endpoint.label} before page`);
    assert.equal(beforeBody.has_more, true, `${endpoint.label} before has_more`);
    assert.equal(beforeBody.has_older, true, `${endpoint.label} before has_older`);
    // The anchor (third) is newer than the page: a --before page says so.
    assert.equal(beforeBody.has_newer, true, `${endpoint.label} before has_newer`);
  }
});

test("agent-api history advances unread cursor but not send freshness proof", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const baseline = await createAgentAttentionMessage(fixture, "history browse baseline");
  const fresh = await createAgentAttentionMessage(fixture, "history browse fresh");

  const channelRef = encodeURIComponent(`#${fixture.channelName}`);
  const res = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&limit=2`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { messages: Array<{ id: string }>; last_read_seq: number };
  assert.deepEqual(body.messages.map((message) => message.id), [baseline.id, fresh.id]);
  assert.equal(body.last_read_seq, 0);
  await waitForLegacyReadCursor(fixture.agentId, fixture.channelId, fresh.seq);

  const send = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      target: `#${fixture.channelName}`,
      content: "agent-api send after history browse with stale model state",
      seenUpToSeq: baseline.seq,
    }),
  });
  assert.equal(send.status, 200);
  const sendBody = await send.json() as {
    state: string;
    newMessageCount: number;
    heldMessages: Array<{ id: string }>;
    seenUpToSeq: number;
  };
  assert.equal(sendBody.state, "held");
  assert.equal(sendBody.newMessageCount, 1);
  assert.equal(sendBody.heldMessages[0]?.id, fresh.id);
  assert.equal(sendBody.seenUpToSeq, fresh.seq);
});

test("agent-api history with consume=false returns the page without advancing the read cursor", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const first = await createAgentAttentionMessage(fixture, "peek first");
  const second = await createAgentAttentionMessage(fixture, "peek second");

  const channelRef = encodeURIComponent(`#${fixture.channelName}`);
  const peek = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&limit=2&consume=false`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(peek.status, 200);
  const peekBody = await peek.json() as { messages: Array<{ id: string }>; last_read_seq: number; model_seen_up_to_seq: number | null };
  assert.deepEqual(peekBody.messages.map((message) => message.id), [first.id, second.id]);
  assert.equal(peekBody.last_read_seq, 0);
  assert.equal(peekBody.model_seen_up_to_seq, null);
  await assertLegacyReadCursorStays(fixture.agentId, fixture.channelId, 0, "consume=false must not mark the page read");

  // The same read without the flag still consumes.
  const read = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&limit=2`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(read.status, 200);
  const readBody = await read.json() as { model_seen_up_to_seq: number | null };
  assert.equal(readBody.model_seen_up_to_seq, second.seq);
  await waitForLegacyReadCursor(fixture.agentId, fixture.channelId, second.seq);

  const invalid = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&consume=no`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(invalid.status, 400);
});

test("agent-api latest history window does not consume a 51st older unread and exact-seq send still holds for it", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const unread = [];
  for (let index = 1; index <= 51; index += 1) {
    unread.push(await createAgentAttentionMessage(fixture, `gapped unread ${index}`));
  }

  const channelRef = encodeURIComponent(`#${fixture.channelName}`);
  const read = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(read.status, 200);
  const readBody = await read.json() as {
    messages: Array<{ id: string; seq: number }>;
    has_older: boolean;
    last_read_seq: number;
    model_seen_up_to_seq: number | null;
  };
  assert.equal(readBody.messages.length, 50);
  assert.equal(readBody.has_older, true);
  assert.equal(readBody.last_read_seq, 0);
  assert.equal(readBody.model_seen_up_to_seq, null);
  assert.deepEqual(
    readBody.messages.map((message) => message.id),
    unread.slice(1).map((message) => message.id),
  );
  await assertLegacyReadCursorStays(
    fixture.agentId,
    fixture.channelId,
    0,
    "a latest window with an older gap must not consume the hidden first unread",
  );

  const send = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      target: `#${fixture.channelName}`,
      content: "send after seeing only the latest 50",
      seenExactSeqs: readBody.messages.map((message) => message.seq),
    }),
  });
  assert.equal(send.status, 200);
  const sendBody = await send.json() as {
    state: string;
    newMessageCount: number;
    heldMessages: Array<{ id: string }>;
  };
  assert.equal(sendBody.state, "held");
  assert.equal(sendBody.newMessageCount, 1);
  assert.deepEqual(sendBody.heldMessages.map((message) => message.id), [unread[0]!.id]);
});

test("agent-api send accepts an exact sparse seen seq when no other target attention is unseen", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const seenByCheck = await createAgentAttentionMessage(fixture, "body rendered by message check");

  const send = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: jsonHeaders(fixture.agentApiKey),
    body: JSON.stringify({
      target: `#${fixture.channelName}`,
      content: "reply after message check",
      seenExactSeqs: [seenByCheck.seq],
    }),
  });
  assert.equal(send.status, 200);
  const body = await send.json() as { state: string; messageId?: string };
  assert.equal(body.state, "sent");
  assert.equal(typeof body.messageId, "string");
});

test("agent-api history around does not advance unread cursor", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const target = await createAgentAttentionMessage(fixture, "around context should stay unread");

  const channelRef = encodeURIComponent(`#${fixture.channelName}`);
  const res = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&around=${target.id.slice(0, 8)}&limit=1`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { messages: Array<{ id: string }>; last_read_seq: number };
  assert.deepEqual(body.messages.map((message) => message.id), [target.id]);
  assert.equal(body.last_read_seq, 0);

  await assertLegacyReadCursorStays(
    fixture.agentId,
    fixture.channelId,
    0,
    "around history is a context lookup and must not consume unread state",
  );
});

// Task #266: a human web sender's IANA zone is agent-facing transport. Both
// agent history reads and the resolved-message payload carry it; the human
// read of the same channel does not.
test("agent history and resolved-message reads carry the human sender's time zone", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const zoned = await createMessage(fixture.channelId, "user", fixture.ownerId, "zoned human send", "chat", undefined, {
    senderTimezone: "Asia/Shanghai",
  });
  const plain = await createMessage(fixture.channelId, "agent", fixture.agentId, "agent reply without a zone");
  const channelRef = encodeURIComponent(`#${fixture.channelName}`);

  const agentApi = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&limit=10`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(agentApi.status, 200);
  const agentApiBody = await agentApi.json() as { messages: Array<{ id: string; senderTimezone?: string | null }> };
  assert.equal(agentApiBody.messages.find((message) => message.id === zoned.id)?.senderTimezone, "Asia/Shanghai");
  assert.equal(agentApiBody.messages.find((message) => message.id === plain.id)?.senderTimezone, null);

  const legacy = await fetch(`${app.baseUrl}/internal/agent/${fixture.agentId}/history?channel=${channelRef}&limit=10`, {
    headers: jsonHeaders(fixture.machineApiKey),
  });
  assert.equal(legacy.status, 200);
  const legacyBody = await legacy.json() as { messages: Array<{ id: string; senderTimezone?: string | null }> };
  assert.equal(legacyBody.messages.find((message) => message.id === zoned.id)?.senderTimezone, "Asia/Shanghai");

  const resolved = await resolveAgentVisibleMessagePayload(zoned.id, fixture.serverId, fixture.agentId);
  assert.equal(resolved?.sender_timezone, "Asia/Shanghai");
  const resolvedPlain = await resolveAgentVisibleMessagePayload(plain.id, fixture.serverId, fixture.agentId);
  assert.equal(resolvedPlain?.sender_timezone, null);

  const humanToken = await tokenForHuman(fixture.ownerEmail);
  const humanPage = await fetch(`${app.baseUrl}/api/messages/channel/${fixture.channelId}?limit=10`, {
    headers: { Authorization: `Bearer ${humanToken}`, "X-Server-Id": fixture.serverId },
  });
  assert.equal(humanPage.status, 200);
  const humanBody = await humanPage.json() as { messages: Array<Record<string, unknown>> };
  const humanRow = humanBody.messages.find((message) => message.id === zoned.id);
  assert.ok(humanRow, "the human page must include the zoned message");
  assert.equal("senderTimezone" in humanRow, false, "a human client never receives another user's zone");
});

test("legacy machine-agent history advances unread cursor but not send freshness proof", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const baseline = await createAgentAttentionMessage(fixture, "legacy browse baseline");
  const fresh = await createAgentAttentionMessage(fixture, "legacy browse fresh");

  const channelRef = encodeURIComponent(`#${fixture.channelName}`);
  const res = await fetch(`${app.baseUrl}/internal/agent/${fixture.agentId}/history?channel=${channelRef}&limit=2`, {
    headers: jsonHeaders(fixture.machineApiKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { messages: Array<{ id: string }>; last_read_seq: number };
  assert.deepEqual(body.messages.map((message) => message.id), [baseline.id, fresh.id]);
  assert.equal(body.last_read_seq, 0);
  await waitForLegacyReadCursor(fixture.agentId, fixture.channelId, fresh.seq);

  const send = await fetch(`${app.baseUrl}/internal/agent/${fixture.agentId}/send`, {
    method: "POST",
    headers: jsonHeaders(fixture.machineApiKey),
    body: JSON.stringify({
      target: `#${fixture.channelName}`,
      content: "legacy send after history browse with stale model state",
      seenUpToSeq: baseline.seq,
    }),
  });
  assert.equal(send.status, 200);
  const sendBody = await send.json() as {
    state: string;
    newMessageCount: number;
    heldMessages: Array<{ id: string }>;
    seenUpToSeq: number;
  };
  assert.equal(sendBody.state, "held");
  assert.equal(sendBody.newMessageCount, 1);
  assert.equal(sendBody.heldMessages[0]?.id, fresh.id);
  assert.equal(sendBody.seenUpToSeq, fresh.seq);
});

test("agent-api mentions uses a limit-plus-one probe for has_more", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();
  const first = await createMessage(fixture.channelId, "user", fixture.ownerId, "first exact @AgentApiAuthBot");
  const second = await createMessage(fixture.channelId, "user", fixture.ownerId, "second exact @AgentApiAuthBot");

  await db.insert(messageMentions).values([
    {
      messageId: first.id,
      messageSeq: first.seq,
      serverId: fixture.serverId,
      channelId: fixture.channelId,
      targetType: "agent",
      targetId: fixture.agentId,
      handleAtSendTime: "AgentApiAuthBot",
      source: "send_path",
      notifiableAtSend: true,
    },
    {
      messageId: second.id,
      messageSeq: second.seq,
      serverId: fixture.serverId,
      channelId: fixture.channelId,
      targetType: "agent",
      targetId: fixture.agentId,
      handleAtSendTime: "AgentApiAuthBot",
      source: "send_path",
      notifiableAtSend: true,
    },
  ]);

  const exact = await fetch(`${app.baseUrl}/internal/agent-api/mentions?limit=2`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(exact.status, 200);
  const exactBody = await exact.json() as { mentions: Array<{ messageId: string }>; has_more: boolean };
  assert.deepEqual(exactBody.mentions.map((mention) => mention.messageId), [second.id, first.id]);
  assert.equal(exactBody.has_more, false, "exactly limit mention rows must not imply another page");

  const third = await createMessage(fixture.channelId, "user", fixture.ownerId, "third exact @AgentApiAuthBot");
  await db.insert(messageMentions).values({
    messageId: third.id,
    messageSeq: third.seq,
    serverId: fixture.serverId,
    channelId: fixture.channelId,
    targetType: "agent",
    targetId: fixture.agentId,
    handleAtSendTime: "AgentApiAuthBot",
    source: "send_path",
    notifiableAtSend: true,
  });

  const over = await fetch(`${app.baseUrl}/internal/agent-api/mentions?limit=2`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(over.status, 200);
  const overBody = await over.json() as { mentions: Array<{ messageId: string }>; has_more: boolean };
  assert.deepEqual(overBody.mentions.map((mention) => mention.messageId), [third.id, second.id]);
  assert.equal(overBody.has_more, true);
});

test("agent-api history scrubs forwarded source pointers for peer joint agents", async ({ app }) => {
  const db = getDb();
  const suffix = randomUUID();
  const [hostOwner] = await db.insert(users).values({
    email: `agent-api-forward-host-${suffix}@slock.test`,
    name: `agent-api-forward-host-${suffix}`,
    displayName: "Agent API Forward Host",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [peerOwner] = await db.insert(users).values({
    email: `agent-api-forward-peer-${suffix}@slock.test`,
    name: `agent-api-forward-peer-${suffix}`,
    displayName: "Agent API Forward Peer",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();

  const hostServer = await createServer("Agent API Forward Host", `agent-api-forward-host-${suffix}`, hostOwner.id);
  const peerServer = await createServer("Agent API Forward Peer", `agent-api-forward-peer-${suffix}`, peerOwner.id);
  const hostAgent = await createAgent(hostServer.id, "host-forward-agent", { runtime: "claude", model: "sonnet" });
  const peerAgent = await createAgent(peerServer.id, "peer-forward-agent", { runtime: "claude", model: "sonnet" });
  const peerReadKey = await mintAgentKey(peerAgent.id, ["read"]);

  const source = await createChannel(hostServer.id, `forward-source-${suffix}`);
  const privateSource = await createChannel(
    hostServer.id,
    `forward-private-source-${suffix}`,
    undefined,
    "private",
  );
  const canonical = await createChannel(hostServer.id, `forward-canonical-${suffix}`);
  const hostProjection = await createChannel(hostServer.id, `forward-host-${suffix}`, undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, `forward-peer-${suffix}`, undefined, "joint");
  await addAgent(source.id, hostAgent.id);
  await addAgent(privateSource.id, hostAgent.id);

  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: hostServer.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: joint.id,
      serverId: peerServer.id,
      localChannelId: peerProjection.id,
      role: "participant",
      joinedByUserId: peerOwner.id,
    },
  ]);
  await addAgent(hostProjection.id, hostAgent.id);
  await addAgent(peerProjection.id, peerAgent.id);

  const sourceMessage = await createMessage(source.id, "agent", hostAgent.id, "source only host agents can open");
  const privateSourceMessage = await createMessage(
    privateSource.id,
    "agent",
    hostAgent.id,
    "private source snapshot remains readable",
  );
  const forwarded = await createMessage(canonical.id, "agent", hostAgent.id, "Forwarded 2 messages", "chat", undefined, {
    actionMetadata: {
      kind: "forwarded-bundle",
      version: 1,
      forwardedItems: [
        {
          index: 0,
          sourceServerId: hostServer.id,
          sourceTargetId: source.id,
          sourceMessageId: sourceMessage.id,
          sourceMessageSeq: sourceMessage.seq,
          sourceTargetSnapshot: {
            id: source.id,
            type: "channel",
            label: `#${source.name}`,
            labelVisibility: "public",
          },
          sourceAuthorSnapshot: {
            type: "agent",
            id: hostAgent.id,
            name: "host-forward-agent",
            uniqueName: "host-forward-agent",
          },
          sourceCreatedAt: sourceMessage.createdAt.toISOString(),
          contentSnapshot: "source only host agents can open",
          attachmentSnapshots: [],
          attachmentPolicy: "excluded",
          provenanceState: "available",
        },
        {
          index: 1,
          sourceServerId: hostServer.id,
          sourceTargetId: privateSource.id,
          sourceMessageId: privateSourceMessage.id,
          sourceMessageSeq: privateSourceMessage.seq,
          sourceTargetSnapshot: {
            id: privateSource.id,
            type: "private",
            label: `#${privateSource.name}`,
            labelVisibility: "private",
          },
          sourceAuthorSnapshot: {
            type: "agent",
            id: hostAgent.id,
            name: "host-forward-agent",
            uniqueName: "host-forward-agent",
          },
          sourceCreatedAt: privateSourceMessage.createdAt.toISOString(),
          contentSnapshot: "private source snapshot remains readable",
          attachmentSnapshots: [],
          attachmentPolicy: "excluded",
          provenanceState: "available",
        },
      ],
    },
  });

  const channelRef = encodeURIComponent(`#${peerProjection.name}`);
  const res = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&limit=5`, {
    headers: jsonHeaders(peerReadKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    messages: Array<{
      id: string;
      content?: string;
      actionMetadata?: {
        forwardedItems?: Array<{
          sourceServerId: string | null;
          sourceTargetId: string | null;
          sourceMessageId: string | null;
          sourceTargetSnapshot: { id: string | null; label: string; labelVisibility: string };
          provenanceState: string;
        }>;
      } | null;
    }>;
  };
  const forwardedItems = body.messages.find((message) => message.id === forwarded.id)?.actionMetadata?.forwardedItems ?? [];
  const item = forwardedItems[0];
  assert.equal(Object.hasOwn(item ?? {}, "sourceServerId"), false, "sourceServerId is removed, not null");
  assert.equal(Object.hasOwn(item ?? {}, "sourceTargetId"), false, "sourceTargetId is removed, not null");
  assert.equal(Object.hasOwn(item ?? {}, "sourceMessageId"), false, "sourceMessageId is removed, not null");
  assert.equal(item?.sourceTargetSnapshot.id, null);
  assert.equal(item?.sourceTargetSnapshot.label, "");
  assert.equal(item?.sourceTargetSnapshot.labelVisibility, "restricted");
  assert.equal(item?.provenanceState, "original_unavailable");
  const privateItem = forwardedItems[1];
  assert.equal(Object.hasOwn(privateItem ?? {}, "sourceServerId"), false, "sourceServerId is removed, not null");
  assert.equal(Object.hasOwn(privateItem ?? {}, "sourceTargetId"), false, "sourceTargetId is removed, not null");
  assert.equal(Object.hasOwn(privateItem ?? {}, "sourceMessageId"), false, "sourceMessageId is removed, not null");
  assert.equal(privateItem?.sourceTargetSnapshot.id, null);
  assert.equal(privateItem?.sourceTargetSnapshot.label, "");
  assert.equal(privateItem?.sourceTargetSnapshot.labelVisibility, "restricted");
  assert.equal(privateItem?.provenanceState, "original_unavailable");
  const projectedContent = body.messages.find((message) => message.id === forwarded.id)?.content ?? "";
  assert.match(projectedContent, /^Forwarded 2 messages\n\nForwarded content snapshot:/);
  assert.match(projectedContent, /From: @host-forward-agent/);
  assert.match(projectedContent, /source only host agents can open/);
  assert.match(projectedContent, /private source snapshot remains readable/);
  assert.doesNotMatch(projectedContent, /Source:/);
  assert.doesNotMatch(projectedContent, new RegExp(source.name));
  assert.doesNotMatch(projectedContent, new RegExp(privateSource.name));
  assert.doesNotMatch(projectedContent, new RegExp(sourceMessage.id));
  assert.doesNotMatch(projectedContent, new RegExp(privateSourceMessage.id));
  assert.doesNotMatch(projectedContent, new RegExp(source.id));
  assert.doesNotMatch(projectedContent, new RegExp(privateSource.id));
  assert.doesNotMatch(projectedContent, new RegExp(hostServer.id));

  const resolveRes = await fetch(
    `${app.baseUrl}/internal/agent-api/messages/${forwarded.id.slice(0, 8)}/resolve`,
    { headers: jsonHeaders(peerReadKey) },
  );
  assert.equal(resolveRes.status, 200);
  const resolveBody = await resolveRes.json() as { message?: { content?: string } };
  assert.equal(
    resolveBody.message?.content,
    projectedContent,
    "history and resolve must share the same viewer-scrubbed forwarded snapshot",
  );
});

test("agent durable history and resolve surfaces append the same bounded forwarded snapshot", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const source = await createChannel(fixture.serverId, `agent-forward-source-${randomUUID()}`);
  await addAgent(source.id, fixture.agentId);
  const firstSource = await createMessage(source.id, "user", fixture.ownerId, "first durable forwarded body");
  const secondSource = await createMessage(
    source.id,
    "agent",
    fixture.agentId,
    `second durable forwarded body ${"x".repeat(2_100)}`,
  );
  const forwarded = await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    "Forwarded 2 messages",
    "chat",
    undefined,
    {
      actionMetadata: {
        kind: "forwarded-bundle",
        version: 1,
        forwardedItems: [
          {
            index: 0,
            sourceServerId: fixture.serverId,
            sourceTargetId: source.id,
            sourceMessageId: firstSource.id,
            sourceMessageSeq: firstSource.seq,
            sourceTargetSnapshot: {
              id: source.id,
              type: "channel",
              label: `#${source.name}`,
              labelVisibility: "public",
            },
            sourceAuthorSnapshot: {
              type: "user",
              id: fixture.ownerId,
              name: fixture.ownerName,
              uniqueName: fixture.ownerName,
            },
            sourceCreatedAt: firstSource.createdAt.toISOString(),
            contentSnapshot: firstSource.content,
            attachmentSnapshots: [{ filename: "decision.md", mimeType: "text/markdown" }],
            attachmentPolicy: "excluded",
            provenanceState: "available",
          },
          {
            index: 1,
            sourceServerId: fixture.serverId,
            sourceTargetId: source.id,
            sourceMessageId: secondSource.id,
            sourceMessageSeq: secondSource.seq,
            sourceTargetSnapshot: {
              id: source.id,
              type: "channel",
              label: `#${source.name}`,
              labelVisibility: "public",
            },
            sourceAuthorSnapshot: {
              type: "agent",
              id: fixture.agentId,
              name: "AgentApiAuthBot",
              uniqueName: "AgentApiAuthBot",
            },
            sourceCreatedAt: secondSource.createdAt.toISOString(),
            contentSnapshot: secondSource.content,
            attachmentSnapshots: [],
            attachmentPolicy: "excluded",
            provenanceState: "available",
          },
        ],
      },
    },
  );

  const channelRef = encodeURIComponent(`#${fixture.channelName}`);
  const agentHistoryRes = await fetch(
    `${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&around=${forwarded.id.slice(0, 8)}&limit=1`,
    { headers: jsonHeaders(fixture.readOnlyApiKey) },
  );
  assert.equal(agentHistoryRes.status, 200);
  const agentHistory = await agentHistoryRes.json() as { messages: Array<{ id: string; content: string }> };
  const agentHistoryContent = agentHistory.messages.find((message) => message.id === forwarded.id)?.content ?? "";

  const legacyHistoryRes = await fetch(
    `${app.baseUrl}/internal/agent/${fixture.agentId}/history?channel=${channelRef}&around=${forwarded.id.slice(0, 8)}&limit=1`,
    { headers: jsonHeaders(fixture.machineApiKey) },
  );
  assert.equal(legacyHistoryRes.status, 200);
  const legacyHistory = await legacyHistoryRes.json() as { messages: Array<{ id: string; content: string }> };
  const legacyHistoryContent = legacyHistory.messages.find((message) => message.id === forwarded.id)?.content ?? "";

  const resolveRes = await fetch(
    `${app.baseUrl}/internal/agent-api/messages/${forwarded.id.slice(0, 8)}/resolve`,
    { headers: jsonHeaders(fixture.readOnlyApiKey) },
  );
  assert.equal(resolveRes.status, 200);
  const resolved = await resolveRes.json() as { message?: { content?: string } };
  const resolvedContent = resolved.message?.content ?? "";

  assert.equal(legacyHistoryContent, agentHistoryContent);
  assert.equal(resolvedContent, agentHistoryContent);
  assert.match(agentHistoryContent, /^Forwarded 2 messages\n\nForwarded content snapshot:/);
  assert.ok(
    agentHistoryContent.indexOf("first durable forwarded body")
      < agentHistoryContent.indexOf("second durable forwarded body"),
    "forwarded item order must match the immutable bundle order",
  );
  assert.match(agentHistoryContent, new RegExp(`From: @${fixture.ownerName}`));
  assert.match(agentHistoryContent, /From: @AgentApiAuthBot/);
  assert.match(agentHistoryContent, new RegExp(`Source: #${source.name}`));
  assert.match(agentHistoryContent, /Attachments: decision\.md \(text\/markdown\)/);
  assert.match(agentHistoryContent, /\[forwarded content truncated: 130 chars omitted\]/);
  assert.doesNotMatch(agentHistoryContent, new RegExp(firstSource.id));
  assert.doesNotMatch(agentHistoryContent, new RegExp(secondSource.id));
  assert.doesNotMatch(agentHistoryContent, new RegExp(source.id));
  assert.doesNotMatch(agentHistoryContent, new RegExp(fixture.serverId));
});

test("message resolve --forwarded returns one forwarded message whole from the viewer's snapshot, and cut notes name it only for a declaring client", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const source = await createChannel(fixture.serverId, `agent-forward-whole-${randomUUID()}`);
  await addAgent(source.id, fixture.agentId);
  // A source the agent can't read: its item is served without source pointers.
  const privateSource = await createChannel(fixture.serverId, `agent-forward-hidden-${randomUUID()}`, undefined, "private");
  const firstSource = await createMessage(source.id, "user", fixture.ownerId, "first forwarded body");
  const longBody = `long forwarded body ${"y".repeat(5_000)} end of the long body`;
  const secondSource = await createMessage(privateSource.id, "user", fixture.ownerId, longBody);
  const item = (index: number, channel: { id: string; name: string }, message: { id: string; seq: number; content: string; createdAt: Date }) => ({
    index,
    sourceServerId: fixture.serverId,
    sourceTargetId: channel.id,
    sourceMessageId: message.id,
    sourceMessageSeq: message.seq,
    sourceTargetSnapshot: { id: channel.id, type: "channel", label: `#${channel.name}`, labelVisibility: "public" },
    sourceAuthorSnapshot: { type: "user", id: fixture.ownerId, name: fixture.ownerName, uniqueName: fixture.ownerName },
    sourceCreatedAt: message.createdAt.toISOString(),
    contentSnapshot: message.content,
    attachmentSnapshots: index === 1 ? [{ filename: "notes.md", mimeType: "text/markdown" }] : [],
    attachmentPolicy: "excluded",
    provenanceState: "available",
  });
  const forwarded = await createMessage(fixture.channelId, "user", fixture.ownerId, "Forwarded 2 messages", "chat", undefined, {
    actionMetadata: {
      kind: "forwarded-bundle",
      version: 1,
      forwardedItems: [item(0, source, firstSource), item(1, privateSource, secondSource)],
    },
  });
  const plain = await createMessage(fixture.channelId, "user", fixture.ownerId, "not a forward");
  const declaring = { ...jsonHeaders(fixture.readOnlyApiKey), "X-Raft-Client-Capabilities": FORWARDED_RESOLVE_CAPABILITY };
  const resolveUrl = (id: string, forwardedNumber?: string) =>
    `${app.baseUrl}/internal/agent-api/messages/${id}/resolve${forwardedNumber === undefined ? "" : `?forwarded=${forwardedNumber}`}`;

  // In range: the whole content, with the snapshot's own lines.
  const wholeRes = await fetch(resolveUrl(forwarded.id.slice(0, 8), "2"), { headers: declaring });
  assert.equal(wholeRes.status, 200);
  const whole = await wholeRes.json() as { message?: { content?: string }; forwarded?: { number: number; total: number; content: string } };
  assert.equal(whole.forwarded?.number, 2);
  assert.equal(whole.forwarded?.total, 2);
  const itemContent = whole.forwarded?.content ?? "";
  assert.match(itemContent, /^Forwarded message 2:\n/);
  assert.match(itemContent, new RegExp(`From: @${fixture.ownerName}`));
  assert.match(itemContent, /Sent: /);
  assert.match(itemContent, /Attachments: notes\.md \(text\/markdown\)/);
  assert.ok(itemContent.includes(longBody), "the forwarded content is not cut");
  assert.doesNotMatch(itemContent, /cut:|truncated:/);
  // The snapshot never carries the source pointers, nor a source the agent can't see.
  assert.doesNotMatch(itemContent, /Source:/);
  for (const hidden of [privateSource.id, privateSource.name, secondSource.id, firstSource.id, fixture.serverId]) {
    assert.ok(!itemContent.includes(hidden), `forwarded item exposes ${hidden}`);
  }
  // The message's own snapshot names the command for the cut item, to a declaring client.
  assert.ok(
    whole.message?.content?.includes(`[forwarded message 2 cut: 3,041 chars omitted]\nRead it whole: raft message resolve ${forwarded.id} --forwarded 2`),
    whole.message?.content,
  );

  const firstRes = await fetch(resolveUrl(forwarded.id, "1"), { headers: declaring });
  assert.equal(firstRes.status, 200);
  const first = await firstRes.json() as { forwarded?: { content: string } };
  assert.match(first.forwarded?.content ?? "", new RegExp(`Source: #${source.name}`));
  assert.match(first.forwarded?.content ?? "", /first forwarded body/);

  // Out of range: how many it forwards.
  const outOfRange = await fetch(resolveUrl(forwarded.id, "3"), { headers: declaring });
  assert.equal(outOfRange.status, 400);
  const outOfRangeBody = await outOfRange.json() as { code?: string; error?: string; suggestedNextAction?: string };
  assert.equal(outOfRangeBody.code, "FORWARDED_OUT_OF_RANGE");
  assert.equal(outOfRangeBody.error, "This message forwards 2 messages; ask for forwarded message 1 to 2.");
  assert.equal(outOfRangeBody.suggestedNextAction, "Use --forwarded 1 to 2.");

  // A message that forwards nothing.
  const notForward = await fetch(resolveUrl(plain.id, "1"), { headers: declaring });
  assert.equal(notForward.status, 400);
  const notForwardBody = await notForward.json() as { code?: string; error?: string };
  assert.equal(notForwardBody.code, "NOT_A_FORWARD");
  assert.match(notForwardBody.error ?? "", /^This message forwards no messages/);

  // Not a positive integer: the contract refuses it.
  const zero = await fetch(resolveUrl(forwarded.id, "0"), { headers: declaring });
  assert.equal(zero.status, 400);

  // History: the read-whole line only for a client that declares it.
  const channelRef = encodeURIComponent(`#${fixture.channelName}`);
  const historyUrl = `${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&around=${forwarded.id.slice(0, 8)}&limit=1`;
  const historyContent = async (headers: Record<string, string>) => {
    const res = await fetch(historyUrl, { headers });
    assert.equal(res.status, 200);
    const body = await res.json() as { messages: Array<{ id: string; content: string }> };
    return body.messages.find((message) => message.id === forwarded.id)?.content ?? "";
  };
  const declared = await historyContent(declaring);
  assert.equal(declared.match(/Read it whole: /g)?.length, 1);
  assert.match(declared, new RegExp(`Read it whole: raft message resolve ${forwarded.id} --forwarded 2`));
  const undeclared = await historyContent(jsonHeaders(fixture.readOnlyApiKey));
  assert.doesNotMatch(undeclared, /Read it whole|--forwarded/);
  assert.match(undeclared, /\[forwarded content truncated: 3041 chars omitted\]/);
});

test("agent-api message resolve is registered and gated by read capability", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const message = await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    "agent-api resolve target",
  );

  const success = await fetch(`${app.baseUrl}/internal/agent-api/messages/${message.id.slice(0, 8)}/resolve`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(success.status, 200);
  const successBody = await success.json() as {
    message?: {
      message_id?: string;
      channel_name?: string;
      sender_type?: string;
      content?: string;
    };
  };
  assert.equal(successBody.message?.message_id, message.id);
  assert.equal(successBody.message?.channel_name, fixture.channelName);
  assert.equal(successBody.message?.sender_type, "human");
  assert.equal(successBody.message?.content, "agent-api resolve target");

  const humanAgentDm = await findOrCreateDM(fixture.serverId, fixture.ownerId, fixture.agentId);
  assert.ok(humanAgentDm);
  const agentToHumanDmMessage = await createMessage(
    humanAgentDm.id,
    "agent",
    fixture.agentId,
    "agent to human dm target",
  );
  const humanAgentDmResolve = await fetch(`${app.baseUrl}/internal/agent-api/messages/${agentToHumanDmMessage.id.slice(0, 8)}/resolve`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(humanAgentDmResolve.status, 200);
  const humanAgentDmBody = await humanAgentDmResolve.json() as {
    message?: {
      message_id?: string;
      channel_type?: string;
      channel_name?: string;
      sender_name?: string;
    };
  };
  assert.equal(humanAgentDmBody.message?.message_id, agentToHumanDmMessage.id);
  assert.equal(humanAgentDmBody.message?.channel_type, "dm");
  assert.equal(humanAgentDmBody.message?.channel_name, fixture.ownerName);
  assert.equal(humanAgentDmBody.message?.sender_name, "AgentApiAuthBot");

  // Remove the agent's membership so this DM is no longer resolvable for it.
  // (The DM's peer identity — dmChannelIdentities — is durable and survives
  // human-membership changes, so deleting channelHumans would NOT make it
  // unresolvable; the agent's own channelAgents row is what gates its read.)
  await getDb().delete(channelAgents).where(eq(channelAgents.channelId, humanAgentDm.id));
  const brokenHumanAgentDmResolve = await fetch(`${app.baseUrl}/internal/agent-api/messages/${agentToHumanDmMessage.id.slice(0, 8)}/resolve`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(brokenHumanAgentDmResolve.status, 404);
  assert.equal((await brokenHumanAgentDmResolve.json() as { errorCode?: string }).errorCode, "NOT_FOUND");

  const peerAgent = await createAgent(fixture.serverId, "AgentApiAuthPeer", { runtime: "claude", model: "sonnet" });
  const peerReadOnlyApiKey = await mintAgentKey(peerAgent.id, ["read"]);
  const agentAgentDm = await findOrCreateAgentDM(fixture.serverId, fixture.agentId, peerAgent.id);
  assert.ok(agentAgentDm);
  const agentToAgentDmMessage = await createMessage(
    agentAgentDm.id,
    "agent",
    fixture.agentId,
    "agent to agent dm target",
  );
  const peerResolve = await fetch(`${app.baseUrl}/internal/agent-api/messages/${agentToAgentDmMessage.id.slice(0, 8)}/resolve`, {
    headers: jsonHeaders(peerReadOnlyApiKey),
  });
  assert.equal(peerResolve.status, 200);
  const peerResolveBody = await peerResolve.json() as {
    message?: {
      message_id?: string;
      channel_type?: string;
      channel_name?: string;
      sender_name?: string;
    };
  };
  assert.equal(peerResolveBody.message?.message_id, agentToAgentDmMessage.id);
  assert.equal(peerResolveBody.message?.channel_type, "dm");
  assert.equal(peerResolveBody.message?.channel_name, "AgentApiAuthBot");
  assert.equal(peerResolveBody.message?.sender_name, "AgentApiAuthBot");

  const systemMessage = await createMessage(
    fixture.channelId,
    "user",
    "system",
    "system lifecycle event",
    "system",
  );
  const systemSuccess = await fetch(`${app.baseUrl}/internal/agent-api/messages/${systemMessage.id.slice(0, 8)}/resolve`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(systemSuccess.status, 200);
  const systemBody = await systemSuccess.json() as {
    message?: {
      message_id?: string;
      sender_type?: string;
      sender_name?: string;
      content?: string;
    };
  };
  assert.equal(systemBody.message?.message_id, systemMessage.id);
  assert.equal(systemBody.message?.sender_type, "system");
  assert.equal(systemBody.message?.sender_name, "system");
  assert.equal(systemBody.message?.content, "system lifecycle event");

  const syntheticSystemEventId = await fetch(`${app.baseUrl}/internal/agent-api/messages/a5b9413d/resolve`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(syntheticSystemEventId.status, 404);
  const syntheticBody = await syntheticSystemEventId.json() as { errorCode?: string; error?: string };
  assert.equal(syntheticBody.errorCode, "NOT_FOUND");
  assert.match(syntheticBody.error ?? "", /no message you can see has that id/);

  const noReadKey = await mintAgentKey(fixture.agentId, ["send"]);
  const noRead = await fetch(`${app.baseUrl}/internal/agent-api/messages/${message.id}/resolve`, {
    headers: jsonHeaders(noReadKey),
  });
  assert.equal(noRead.status, 403);
  const noReadBody = await noRead.json() as { code?: string; requiredCapability?: string };
  assert.equal(noReadBody.code, "capability_not_authorized");
  assert.equal(noReadBody.requiredCapability, "read");

  const inactiveRead = await fetch(`${app.baseUrl}/internal/agent-api/messages/${message.id}/resolve`, {
    headers: {
      ...jsonHeaders(fixture.readOnlyApiKey),
      "X-Slock-Agent-Active-Capabilities": "send",
    },
  });
  assert.equal(inactiveRead.status, 501);
  const inactiveReadBody = await inactiveRead.json() as { code?: string; requiredCapability?: string };
  assert.equal(inactiveReadBody.code, "unsupported_capability");
  assert.equal(inactiveReadBody.requiredCapability, "read");
});

test("agent-api message resolve projects joint storage messages to the local channel", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();
  const [hostOwner] = await db.insert(users).values({
    email: "agent-api-joint-resolve-host@slock.test",
    name: "agent-api-joint-resolve-host",
    displayName: "Agent API Joint Host",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const hostServer = await createServer("Agent API Joint Host", `agent-api-joint-resolve-host-${randomUUID()}`, hostOwner.id);
  const canonical = await createChannel(hostServer.id, "agent-api-joint-canonical", undefined, "channel");
  const hostProjection = await createChannel(hostServer.id, "shared-resolve-room", undefined, "joint");
  const peerProjection = await createChannel(fixture.serverId, "shared-resolve-room", undefined, "joint");
  await addHuman(hostProjection.id, hostOwner.id);
  await addHuman(peerProjection.id, fixture.ownerId);

  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: hostServer.id,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: hostOwner.id,
    },
    {
      jointChannelId: joint.id,
      serverId: fixture.serverId,
      localChannelId: peerProjection.id,
      role: "participant",
      joinedByUserId: fixture.ownerId,
    },
  ]);
  await addAgent(peerProjection.id, fixture.agentId);

  const message = await createMessage(canonical.id, "user", hostOwner.id, "joint storage resolve target");

  const res = await fetch(`${app.baseUrl}/internal/agent-api/messages/${message.id.slice(0, 8)}/resolve`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    message?: {
      message_id?: string;
      channel_name?: string;
      channel_type?: string;
      content?: string;
    };
  };
  assert.equal(body.message?.message_id, message.id);
  assert.equal(body.message?.channel_name, peerProjection.name);
  assert.equal(body.message?.channel_type, "channel");
  assert.equal(body.message?.content, "joint storage resolve target");
});

test("agent-api message resolve computes short-id ambiguity only across visible messages", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const privateChannel = await createChannel(
    fixture.serverId,
    `agent-api-private-resolve-${randomUUID()}`,
    "private resolve probe target",
    "private",
  );
  await addHuman(privateChannel.id, fixture.ownerId);

  await getDb().insert(messages).values([
    {
      id: "bbbbbbbb-1111-4111-8111-111111111111",
      channelId: privateChannel.id,
      senderType: "user",
      senderId: fixture.ownerId,
      content: "private resolve collision one",
    },
    {
      id: "bbbbbbbb-2222-4222-8222-222222222222",
      channelId: privateChannel.id,
      senderType: "user",
      senderId: fixture.ownerId,
      content: "private resolve collision two",
    },
  ]);

  const inaccessibleCollision = await fetch(`${app.baseUrl}/internal/agent-api/messages/bbbbbbbb/resolve`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(inaccessibleCollision.status, 404);
  const inaccessibleBody = await inaccessibleCollision.json() as { errorCode?: string; error?: string };
  assert.equal(inaccessibleBody.errorCode, "NOT_FOUND");
  assert.match(inaccessibleBody.error ?? "", /no message you can see has that id/);

  const [visible] = await getDb().insert(messages).values({
    id: "bbbbbbbb-3333-4333-8333-333333333333",
    channelId: fixture.channelId,
    senderType: "user",
    senderId: fixture.ownerId,
    content: "visible resolve collision",
  }).returning();

  const visibleResolve = await fetch(`${app.baseUrl}/internal/agent-api/messages/bbbbbbbb/resolve`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(visibleResolve.status, 200);
  const visibleBody = await visibleResolve.json() as { message?: { message_id?: string; content?: string } };
  assert.equal(visibleBody.message?.message_id, visible.id);
  assert.equal(visibleBody.message?.content, "visible resolve collision");
});

test("agent-api history around resolves anchors and fails closed on bad anchors", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const message = await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    "agent-api around target",
  );
  // A day ago, with milliseconds: inside the Free plan's 30-day history window.
  const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 24 * 60 * 60 * 1000 + 123);
  await getDb().update(messages).set({ createdAt }).where(eq(messages.id, message.id));
  const channelRef = encodeURIComponent(`#${fixture.channelName}`);

  const success = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&around=${message.id.slice(0, 8)}&limit=1`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(success.status, 200);
  const successBody = await success.json() as {
    messages?: Array<{ id?: string; content?: string; createdAt?: string; timestamp?: string }>;
    has_older?: boolean;
    has_newer?: boolean;
  };
  assert.equal(successBody.messages?.length, 1);
  assert.equal(successBody.messages?.[0]?.id, message.id);
  assert.equal(successBody.messages?.[0]?.content, "agent-api around target");
  assert.equal(successBody.messages?.[0]?.createdAt, createdAt.toISOString());
  assert.match(successBody.messages?.[0]?.createdAt ?? "", /Z$/);
  assert.equal(successBody.messages?.[0]?.timestamp, undefined);
  assert.equal(typeof successBody.has_older, "boolean");
  assert.equal(typeof successBody.has_newer, "boolean");

  const missing = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&around=4f9c2210&limit=1`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(missing.status, 404);
  const missingBody = await missing.json() as { errorCode?: string; error?: string };
  assert.equal(missingBody.errorCode, "NOT_FOUND");
  assert.match(missingBody.error ?? "", /4f9c2210/);

  await getDb().insert(messages).values([
    {
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      channelId: fixture.channelId,
      senderType: "user",
      senderId: fixture.ownerId,
      content: "ambiguous around one",
    },
    {
      id: "aaaaaaaa-2222-4222-8222-222222222222",
      channelId: fixture.channelId,
      senderType: "user",
      senderId: fixture.ownerId,
      content: "ambiguous around two",
    },
  ]);
  const ambiguous = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&around=aaaaaaaa&limit=1`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(ambiguous.status, 400);
  const ambiguousBody = await ambiguous.json() as { errorCode?: string; suggestedNextAction?: string };
  assert.equal(ambiguousBody.errorCode, "AMBIGUOUS_ID");
  assert.match(ambiguousBody.suggestedNextAction ?? "", /full message UUID/);

  const invalid = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&around=not-a-message-id&limit=1`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json() as { errorCode?: string; error?: string };
  assert.equal(invalidBody.errorCode, "INVALID_ARG");
  assert.match(invalidBody.error ?? "", /isn't a seq number, a full message UUID or an 8-character short id/);
});

test("agent-api history keeps 8-digit pagination seqs distinct from around short ids", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const [decimalPrefixMessage] = await getDb().insert(messages).values({
    id: "63508141-1111-4111-8111-111111111111",
    channelId: fixture.channelId,
    senderType: "user",
    senderId: fixture.ownerId,
    content: "numeric short-id around target",
  }).returning();
  const afterTarget = await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    "message after 8-digit pagination anchor",
  );
  await getDb().update(messages).set({ seq: 10018628 }).where(eq(messages.id, afterTarget.id));
  const channelRef = encodeURIComponent(`#${fixture.channelName}`);

  const around = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&around=63508141&limit=1`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(around.status, 200);
  const aroundBody = await around.json() as { messages?: Array<{ id?: string }> };
  assert.equal(aroundBody.messages?.[0]?.id, decimalPrefixMessage.id);

  const after = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&after=10015971&limit=1`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(after.status, 200);
  const afterBody = await after.json() as { messages?: Array<{ id?: string; seq?: number }> };
  assert.deepEqual(afterBody.messages?.map((message) => ({ id: message.id, seq: message.seq })), [
    { id: afterTarget.id, seq: 10018628 },
  ]);

  const legacyAfter = await fetch(`${app.baseUrl}/internal/agent/${fixture.agentId}/history?channel=${channelRef}&after=10015971&limit=1`, {
    headers: jsonHeaders(fixture.machineApiKey),
  });
  assert.equal(legacyAfter.status, 200);
  const legacyAfterBody = await legacyAfter.json() as { messages?: Array<{ id?: string; seq?: number }> };
  assert.deepEqual(legacyAfterBody.messages?.map((message) => ({ id: message.id, seq: message.seq })), [
    { id: afterTarget.id, seq: 10018628 },
  ]);

  const before = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${channelRef}&before=10015971&limit=1`, {
    headers: jsonHeaders(fixture.readOnlyApiKey),
  });
  assert.equal(before.status, 200);
  const beforeBody = await before.json() as { messages?: unknown[] };
  assert.equal(beforeBody.messages?.length, 1);
  // An 8-digit seq that is no message's short id reads as a seq for `around`
  // too: the "Older:"/"Newer:" lines print seqs (Cindy 10-30: it was a 404).
  for (const endpoint of [
    { label: "agent-api", path: "/internal/agent-api/history", headers: jsonHeaders(fixture.readOnlyApiKey) },
    { label: "legacy", path: `/internal/agent/${fixture.agentId}/history`, headers: jsonHeaders(fixture.machineApiKey) },
  ]) {
    const aroundSeq = await fetch(`${app.baseUrl}${endpoint.path}?channel=${channelRef}&around=10018628&limit=1`, {
      headers: endpoint.headers,
    });
    assert.equal(aroundSeq.status, 200, `${endpoint.label} around=<8-digit seq> status`);
    const aroundSeqBody = await aroundSeq.json() as { messages?: Array<{ id?: string }> };
    assert.equal(aroundSeqBody.messages?.[0]?.id, afterTarget.id, `${endpoint.label} around=<8-digit seq> window`);
  }
});

test("agent-api search uses the bound runner identity and typed response contract", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const sink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink }));
  const marker = `agent-api-search-${randomUUID()}`;
  await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    `${marker} from owner`,
  );

  const params = new URLSearchParams({
    q: marker,
    channel: `#${fixture.channelName}`,
    sender: fixture.ownerName,
    sort: "recent",
    limit: "5",
  });
  const res = await fetch(`${app.baseUrl}/internal/agent-api/search?${params}`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  const body = await res.json() as {
    error?: string;
    hasMore: boolean;
    results: Array<{ content: string; senderName: string; senderType: string; channelName: string }>;
  };
  assert.equal(res.status, 200, body.error);
  assert.equal(body.hasMore, false);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0]?.senderName, "Agent API Auth Owner");
  assert.equal(body.results[0]?.senderType, "human");
  assert.equal(body.results[0]?.channelName, fixture.channelName);
  assert.match(body.results[0]?.content ?? "", new RegExp(marker));

  // Every span opened after agent auth (search's db query spans) carries the
  // agent's keyed hash, and none carries the raw agent id.
  const agentHash = traceAgentIdHash(fixture.agentId);
  const requestSpan = sink.getAllSpans().find((span) =>
    span.name === "server.http.request" && span.attrs?.route_pattern === "/internal/agent-api/search"
  );
  assert.ok(requestSpan, "expected agent-api search request span");
  assert.equal(requestSpan.attrs?.agent_id_hash, agentHash);
  const childSpans = sink.getAllSpans().filter((span) =>
    span.context.traceId === requestSpan.context.traceId && span.name !== "server.http.request"
  );
  assert.ok(childSpans.some((span) => span.name === "server.db.query"), "expected search db query spans");
  for (const span of [requestSpan, ...childSpans]) {
    assert.equal(span.attrs?.agent_id_hash, agentHash, `${span.name} should carry agent_id_hash`);
    assert.equal(span.attrs?.agent_id_present, true, `${span.name} should mark agent_id_present`);
    assert.equal(span.attrs?.server_id_hash, traceServerIdHash(fixture.serverId), `${span.name} should carry server_id_hash`);
    assert.equal(JSON.stringify(span).includes(fixture.agentId), false, `${span.name} must not carry the raw agent id`);
    assert.equal(JSON.stringify(span).includes(fixture.serverId), false, `${span.name} must not carry the raw server id`);
  }
});

test("agent-api history renders sender handle instead of display name", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const marker = `agent-api-history-handle-${randomUUID()}`;
  await createMessage(
    fixture.channelId,
    "user",
    fixture.ownerId,
    `${marker} from display-name owner`,
  );

  const params = new URLSearchParams({
    channel: `#${fixture.channelName}`,
    limit: "5",
  });
  const res = await fetch(`${app.baseUrl}/internal/agent-api/history?${params}`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  const body = await res.json() as {
    error?: string;
    messages?: Array<{ content: string; senderName: string; senderHandle?: string }>;
  };
  assert.equal(res.status, 200, body.error);
  const message = body.messages?.find((candidate) => candidate.content.includes(marker));
  assert.ok(message, "expected created message in agent history");
  assert.equal(message.senderName, fixture.ownerName);
  assert.notEqual(message.senderName, "Agent API Auth Owner");
  assert.equal("senderHandle" in message, false, "internal handle helper must not leak");
});

test("agent-api search sees agent-member private channels and parent-authorized threads", async ({ app }) => {
  const db = getDb();
  const fixture = await seedAuthFixture();
  const marker = `agent-private-search-${randomUUID()}`;
  const visiblePrivate = await createChannel(fixture.serverId, `agent-api-visible-private-${randomUUID()}`, undefined, "private");
  await addHuman(visiblePrivate.id, fixture.ownerId);
  await addAgent(visiblePrivate.id, fixture.agentId);
  const visibleDirect = await createMessage(
    visiblePrivate.id,
    "user",
    fixture.ownerId,
    `${marker} visible private direct`,
  );
  const parent = await createMessage(
    visiblePrivate.id,
    "user",
    fixture.ownerId,
    `${marker} visible private parent`,
  );
  const thread = await getOrCreateThread(parent.id, fixture.ownerId, "user");
  const visibleThread = await createMessage(
    thread.id,
    "user",
    fixture.ownerId,
    `${marker} visible private thread reply`,
  );

  const hiddenPrivate = await createChannel(fixture.serverId, `agent-api-hidden-private-${randomUUID()}`, undefined, "private");
  await addHuman(hiddenPrivate.id, fixture.ownerId);
  const hidden = await createMessage(
    hiddenPrivate.id,
    "user",
    fixture.ownerId,
    `${marker} hidden private direct`,
  );

  await db.update(messages)
    .set({ createdAt: new Date("2026-07-09T01:00:00.000Z") })
    .where(eq(messages.id, visibleDirect.id));
  await db.update(messages)
    .set({ createdAt: new Date("2026-07-09T01:01:00.000Z") })
    .where(eq(messages.id, parent.id));
  await db.update(messages)
    .set({ createdAt: new Date("2026-07-09T01:02:00.000Z") })
    .where(eq(messages.id, visibleThread.id));
  await db.update(messages)
    .set({ createdAt: new Date("2026-07-09T01:03:00.000Z") })
    .where(eq(messages.id, hidden.id));

  const params = new URLSearchParams({
    q: marker,
    sort: "recent",
    limit: "10",
  });
  // These dates are older than the free plan's history window, which agent
  // search honours like every read; an unlimited plan finds them.
  const freeRes = await fetch(`${app.baseUrl}/internal/agent-api/search?${params}`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  const freeBody = await freeRes.json() as { error?: string; results: Array<{ id: string }> };
  assert.equal(freeRes.status, 200, freeBody.error);
  assert.deepEqual(freeBody.results, [], "free plan: messages older than the history window are not found");
  await db.update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, fixture.serverId));

  const res = await fetch(`${app.baseUrl}/internal/agent-api/search?${params}`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  const body = await res.json() as {
    error?: string;
    results: Array<{ id: string; channelId: string; parentChannelId: string; content: string }>;
  };
  assert.equal(res.status, 200, body.error);
  assert.deepEqual(body.results.map((result) => result.id), [
    visibleThread.id,
    parent.id,
    visibleDirect.id,
  ]);
  assert.equal(body.results[0]?.channelId, thread.id);
  assert.equal(body.results[0]?.parentChannelId, visiblePrivate.id);
  assert.ok(body.results.every((result) => result.id !== hidden.id));
  assert.ok(body.results.every((result) => !result.content.includes("hidden private")));
});

test("agent-api search sender handles cloak hidden human directory from member agents", async ({ app }) => {
  const fixture = await seedAuthFixture();
  const db = getDb();
  await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, fixture.serverId));
  const [hiddenHuman] = await db.insert(users).values({
    email: `agent-api-hidden-human-${randomUUID()}@slock.test`,
    name: `agent-api-hidden-human-${randomUUID()}`,
    displayName: "Agent API Hidden Human",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  await db.insert(serverMembers).values({
    serverId: fixture.serverId,
    userId: hiddenHuman.id,
    role: "member",
  });

  const hiddenParams = new URLSearchParams({
    sender: hiddenHuman.name,
    sort: "recent",
  });
  const hiddenRes = await fetch(`${app.baseUrl}/internal/agent-api/search?${hiddenParams}`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  const hiddenBody = await hiddenRes.json() as { error?: string; errorCode?: string };
  assert.equal(hiddenRes.status, 404);
  assert.equal(hiddenBody.errorCode, "member_not_found");

  const unknownParams = new URLSearchParams({
    sender: `missing-${randomUUID()}`,
    sort: "recent",
  });
  const unknownRes = await fetch(`${app.baseUrl}/internal/agent-api/search?${unknownParams}`, {
    headers: jsonHeaders(fixture.agentApiKey),
  });
  assert.equal(unknownRes.status, hiddenRes.status);
  const unknownBody = await unknownRes.json() as { errorCode?: string };
  assert.equal(unknownBody.errorCode, hiddenBody.errorCode);
});
