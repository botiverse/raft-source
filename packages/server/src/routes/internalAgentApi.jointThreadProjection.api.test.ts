import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// #bug-triage task #31 (follow-up to #29 / #10325): a joint (cross-server)
// thread is reached on each server through a local projection that carries no
// parent_message_id and stores no messages; its messages and parent live on
// the canonical thread. The agent API must read that canonical thread when it
// runs the freshness gate and when it labels a message for an agent.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channelAgents, channels, jointChannels, jointChannelServers, messages, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addHuman, getOrCreateThreadForChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import * as attestedSendService from "../services/attestedSendService";
import { resolveAgentVisibleMessagePayload } from "./internal";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const originalAttestedSendMode = process.env.SLOCK_ATTESTED_SEND_MODE;

beforeEach(() => {
  process.env.SLOCK_ATTESTED_SEND_MODE = "force";
});

afterEach(() => {
  attestedSendService.__resetAttestedSendStateForTest();
  if (originalAttestedSendMode === undefined) {
    delete process.env.SLOCK_ATTESTED_SEND_MODE;
  } else {
    process.env.SLOCK_ATTESTED_SEND_MODE = originalAttestedSendMode;
  }
});

/** A joint channel hosted elsewhere, its local projection on the agent's server, and a joint thread under it. */
async function seedJointThread() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `joint-thread-${suffix}@slock.test`,
    name: `joint-thread-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Joint Thread Local", `joint-thread-local-${suffix}`, owner!.id);
  const host = await createServer("Joint Thread Host", `joint-thread-host-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, "JointThreadBot", { runtime: "claude", model: "sonnet" });
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "joint-thread", issuedVia: "computer", createdByUserId: null });

  const [canonical, hostLocal, local] = await db.insert(channels).values([
    { serverId: host.id, name: `joint-canonical-${suffix}`, type: "joint" },
    { serverId: host.id, name: `joint-host-${suffix}`, type: "joint" },
    { serverId: server.id, name: `joint-local-${suffix}`, type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical!.id, createdByServerId: host.id, createdByUserId: owner!.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: host.id, localChannelId: hostLocal!.id, role: "host", status: "active", joinedByUserId: owner!.id },
    { jointChannelId: joint!.id, serverId: server.id, localChannelId: local!.id, role: "participant", status: "active", joinedByUserId: owner!.id },
  ]);
  await addHuman(local!.id, owner!.id);
  await db.insert(channelAgents).values({ channelId: local!.id, agentId: agent.id });

  const root = await createMessage(canonical!.id, "user", owner!.id, "joint thread root");
  const thread = await getOrCreateThreadForChannel(local!.id, root.id, owner!.id, "user");
  const [localThread] = await db.select().from(channels).where(eq(channels.id, thread.id));
  assert.ok(localThread && localThread.parentMessageId === null, "the local thread is a projection with no parent message");
  assert.ok(thread.canonicalThreadChannelId && thread.canonicalThreadChannelId !== thread.id, "messages live on a separate canonical thread");

  return {
    ownerId: owner!.id,
    serverId: server.id,
    agentId: agent.id,
    apiKey,
    localName: local!.name,
    root,
    localThreadId: thread.id,
    canonicalThreadId: thread.canonicalThreadChannelId!,
  };
}

async function agentSend(baseUrl: string, apiKey: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

// Guard, not a fix: this already resolves on staging through the name-based
// fallback (resolveChannelByName → resolveThreadByShortId, server-wide).
test("an agent can send to a joint thread named by its local thread id", async ({ app }) => {
  const fx = await seedJointThread();
  const reply = await createMessage(fx.canonicalThreadId, "user", fx.ownerId, "first reply");

  const sent = await agentSend(app.baseUrl, fx.apiKey, {
    target: `#${fx.localName}:${fx.localThreadId.slice(0, 8)}`,
    content: "reply via the thread id",
    seenUpToSeq: reply.seq,
  });

  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.state, "sent", JSON.stringify(sent.body));
  const [row] = await getDb().select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, sent.body.messageId));
  assert.equal(row?.channelId, fx.canonicalThreadId, "the reply is stored on the canonical thread");
});

test("the freshness gate holds a stale send into a joint thread", async ({ app }) => {
  const fx = await seedJointThread();
  const seen = await createMessage(fx.canonicalThreadId, "user", fx.ownerId, "reply the agent saw");
  const fresh = await createMessage(fx.canonicalThreadId, "user", fx.ownerId, "reply the agent has not seen");

  const held = await agentSend(app.baseUrl, fx.apiKey, {
    target: `#${fx.localName}:${fx.root.id.slice(0, 8)}`,
    content: "stale draft",
    seenUpToSeq: seen.seq,
  });

  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.state, "held", JSON.stringify(held.body));
  assert.deepEqual(held.body.heldMessages.map((message: { id: string }) => message.id), [fresh.id]);
});

test("a joint thread message resolves with its parent channel and parent short id", async ({ app }) => {
  assert.ok(app.baseUrl);
  const fx = await seedJointThread();
  const reply = await createMessage(fx.canonicalThreadId, "user", fx.ownerId, "reply to resolve");

  const payload = await resolveAgentVisibleMessagePayload(reply.id, fx.serverId, fx.agentId);

  assert.ok(payload, "the agent can resolve a message in a joint thread it can see");
  assert.equal(payload.channel_type, "thread");
  assert.equal(payload.channel_name, fx.root.id.slice(0, 8), "a thread is named by its parent message short id");
  assert.equal(payload.parent_channel_name, fx.localName, "the parent is this server's projection of the joint channel");
  assert.equal(payload.parent_channel_type, "channel");
});
