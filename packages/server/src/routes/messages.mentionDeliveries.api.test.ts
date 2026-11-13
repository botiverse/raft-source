import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { users, servers, serverMembers, channels, channelHumans, agents, messages, messageMentions } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import * as occurrenceService from "../services/mentionDeliveryOccurrenceService";

const test = createApiTest();
afterEach(() => vi.restoreAllMocks());

async function seed() {
  const db = getDb();
  const id = randomUUID();
  const humans = await db.insert(users).values(["author", "peer"].map((name) => ({
    email: `${name}-${id}@raft.test`, name: `${name}-${id}`, passwordHash: "hash",
    emailVerified: true, profileSetupCompletedAt: new Date(),
  }))).returning();
  const [author, peer] = humans;
  const [server, otherServer] = await db.insert(servers).values(["one", "two"].map((name) => ({ name, slug: `${name}-${id}`, ownerId: author.id }))).returning();
  await db.insert(serverMembers).values(humans.flatMap((human) => [server, otherServer].map((s) => ({ userId: human.id, serverId: s.id, role: "member" as const }))));
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: id, type: "private" }).returning();
  await db.insert(channelHumans).values(humans.map((human) => ({ channelId: channel.id, userId: human.id })));
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: id, runtime: "codex" }).returning();
  const [message] = await db.insert(messages).values({ channelId: channel.id, senderType: "user", senderId: author.id, content: "synthetic", seq: 1 }).returning();
  const [mention] = await db.insert(messageMentions).values({ messageId: message.id, messageSeq: 1, serverId: server.id, channelId: channel.id, targetType: "agent", targetId: agent.id, handleAtSendTime: "original-name" }).returning();
  const payload = { channel_id: channel.id, channel_name: channel.name, channel_type: "private" as const, sender_id: author.id, sender_name: author.name, sender_type: "human" as const, content: "synthetic", timestamp: new Date().toISOString(), message_id: message.id, seq: 1 };
  const identity = { machineId: randomUUID(), launchId: "private-launch", sessionId: "private-session" };
  await occurrenceService.ensureMentionDeliveryOccurrences([{ occurrenceId: mention.id, messageId: message.id, serverId: server.id, agentId: agent.id, deliveryPayload: payload }]);
  await occurrenceService.recordMentionDeliveryServerDecision({ occurrenceId: mention.id, payload, identity });
  await occurrenceService.recordMentionDeliveryTerminalError({ occurrenceId: mention.id, messageId: message.id, agentId: agent.id, identity, code: "IDENTITY_DRIFT" });
  return { author, peer, server, otherServer, channel, agent, message, mention };
}

test("only the author with current conversation access sees coarse failures; denials cannot enumerate", async ({ http }) => {
  const s = await seed();
  const path = `/api/messages/${s.message.id}/mention-deliveries`;
  const result = await http.as(s.author, s.server).get(path);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { messageId: s.message.id, deliveries: [{ targetId: s.agent.id, targetHandle: "original-name", outcome: "lost", reasonCategory: "unclassified" }] });
  for (const [human, server, url] of [
    [s.peer, s.server, path], [s.author, s.otherServer, path],
    [s.author, s.server, `/api/messages/${randomUUID()}/mention-deliveries`],
  ] as const) {
    const denied = await http.as(human, server).get(url);
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { status: "NOT_JOINABLE" });
  }
  await getDb().delete(channelHumans).where(eq(channelHumans.userId, s.author.id));
  const revoked = await http.as(s.author, s.server).get(path);
  assert.equal(revoked.status, 404);
  assert.deepEqual(await revoked.json(), { status: "NOT_JOINABLE" });
});

test("missing occurrence is unknown and failed lookup is not an empty success", async ({ http }) => {
  const s = await seed();
  const path = `/api/messages/${s.message.id}/mention-deliveries`;
  const spy = vi.spyOn(occurrenceService, "listMentionDeliveryOccurrencesForMessage").mockResolvedValue([]);
  const missing = await http.as(s.author, s.server).get(path);
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), { messageId: s.message.id, deliveries: [{ targetId: s.agent.id, targetHandle: "original-name", outcome: "unknown" }] });
  spy.mockRejectedValue(new Error("synthetic database outage"));
  const failed = await http.as(s.author, s.server).get(path);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { status: "LOOKUP_FAILED" });
});


test("agent credentials cannot read another human sender's projection", async ({ http }) => {
  const s = await seed();
  const credential = await mintAgentCredential({ agentId: s.agent.id, scopes: ["mentions"], issuedVia: "human", createdByUserId: s.author.id });
  const response = await http.as(s.author, s.server).request(`/api/messages/${s.message.id}/mention-deliveries`, {
    method: "GET", headers: { Authorization: `Bearer ${credential.apiKey}` },
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal("deliveries" in body, false);
});
