import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, messageMentions, mentionDeliveryOccurrences, messages, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { mintAgentCredential, type AgentCapability } from "../services/agentCredentialService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";

/**
 * task #153, tooth T2. The author-scoped read must not become an existence
 * oracle: a non-author has to receive the SAME body a non-participant receives,
 * so that a caller cannot learn whether someone else's message exists by
 * comparing responses.
 */

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function jsonHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function mintAgentKey(agentId: string, scopes: readonly AgentCapability[]): Promise<string> {
  const minted = await mintAgentCredential({
    agentId,
    scopes,
    name: `sender-mention-deliveries-${agentId}`,
    issuedVia: "computer",
    createdByUserId: null,
  });
  return minted.apiKey;
}

async function seed() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `smd-${suffix}@slock.test`,
    name: `smd-${suffix}`,
    displayName: "Sender Mention Deliveries Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("SMD Test", `smd-${suffix}`, owner.id);
  const author = await createAgent(server.id, `SmdAuthor${suffix.slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const stranger = await createAgent(server.id, `SmdStranger${suffix.slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, `smd-${suffix.slice(0, 8)}`);
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, author.id);
  await addAgent(channel.id, stranger.id);
  const message = await createMessage(channel.id, "agent", author.id, `seed for sender-side delivery read ${suffix}`);
  return {
    serverId: server.id,
    channelId: channel.id,
    targetAgentId: stranger.id,
    authorKey: await mintAgentKey(author.id, ["mentions"]),
    strangerKey: await mintAgentKey(stranger.id, ["mentions"]),
    messageId: message.id,
  };
}

test("T2: a non-author gets the byte-identical not-found body a non-participant gets", async ({ app }) => {
  const { strangerKey, messageId } = await seed();

  const notMine = await fetch(`${app.baseUrl}/internal/agent-api/messages/${messageId}/mention-deliveries`, {
    headers: jsonHeaders(strangerKey),
  });
  const doesNotExist = await fetch(`${app.baseUrl}/internal/agent-api/messages/${randomUUID()}/mention-deliveries`, {
    headers: jsonHeaders(strangerKey),
  });

  assert.equal(notMine.status, 404);
  assert.equal(doesNotExist.status, 404);
  // Byte-identical: if these ever diverge, the difference itself answers
  // "does that message exist?" for a caller with no right to ask.
  const notMineBody = await notMine.json();
  const doesNotExistBody = await doesNotExist.json();
  assert.deepEqual(notMineBody, doesNotExistBody);
  assert.deepEqual(notMineBody, { status: "NOT_JOINABLE" });
});

test("the author can read their own message's delivery rows", async ({ app }) => {
  const { authorKey, messageId } = await seed();

  const res = await fetch(`${app.baseUrl}/internal/agent-api/messages/${messageId}/mention-deliveries`, {
    headers: jsonHeaders(authorKey),
  });

  assert.equal(res.status, 200);
  const body = await res.json() as { messageId: string; deliveries: unknown[] };
  assert.equal(body.messageId, messageId);
  assert.ok(Array.isArray(body.deliveries));
});

test("a malformed message id is not distinguishable from a foreign one", async ({ app }) => {
  const { strangerKey } = await seed();
  const res = await fetch(`${app.baseUrl}/internal/agent-api/messages/not-a-uuid/mention-deliveries`, {
    headers: jsonHeaders(strangerKey),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { status: "NOT_JOINABLE" });
});

test("@Stone finding 1: the sender sees the handle they AUTHORED, not the target's current name", async ({ app }) => {
  const db = getDb();
  const { authorKey, messageId, targetAgentId, serverId, channelId } = await seed();

  // The author wrote "@OldName"; the agent is later renamed. The sender is
  // diagnosing the token they typed, so a rename must not rewrite history under
  // them — otherwise they search their own message for a handle that is no
  // longer in it.
  const [row] = await db
    .select({ seq: messages.seq })
    .from(messages).where(eq(messages.id, messageId)).limit(1);
  const [mention] = await db.insert(messageMentions).values({
    messageId,
    messageSeq: row.seq,
    serverId,
    channelId,
    targetType: "agent",
    targetId: targetAgentId,
    handleAtSendTime: "@OldName",
  }).returning();
  await db.insert(mentionDeliveryOccurrences).values({
    occurrenceId: mention.id,
    messageId,
    serverId,
    agentId: targetAgentId,
    state: "recorded",
    mentionRecordedAt: new Date(),
  });
  await db.update(agents).set({ name: "RenamedSinceSend" }).where(eq(agents.id, targetAgentId));

  const res = await fetch(`${app.baseUrl}/internal/agent-api/messages/${messageId}/mention-deliveries`, {
    headers: jsonHeaders(authorKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { deliveries: Array<{ targetHandle: string }> };
  const handles = body.deliveries.map((row) => row.targetHandle);
  assert.ok(handles.includes("@OldName"), `expected the authored handle, got ${JSON.stringify(handles)}`);
  assert.equal(handles.includes("RenamedSinceSend"), false, "must not show the post-rename name");
});
