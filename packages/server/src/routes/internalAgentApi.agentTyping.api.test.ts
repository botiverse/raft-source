import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index";
import { messages, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, createChannel } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";

// Agent typing line: the agent send route tells the orchestrator its message
// landed, so the typing registry ends that agent's lines into the conversation
// (agentOrchestrator.agentTyping.test.ts covers what the registry does then).

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type PostedCall = { agentId: string; serverId: string; channelId: string; channelType: string; target?: string };

async function seed() {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `agent-typing-${suffix}@slock.test`,
    name: `agent-typing-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Agent Typing", `agent-typing-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, "TypingBot", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, `typing-${suffix.slice(0, 8)}`);
  await addAgent(channel.id, agent.id);
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "agent-typing", issuedVia: "computer", createdByUserId: null });
  return { serverId: server.id, agentId: agent.id, channel, apiKey: minted.apiKey };
}

async function send(baseUrl: string, apiKey: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

test("a sent message reports its conversation to the typing line; a thread reply names the thread", async ({ app }) => {
  const f = await seed();
  const calls: PostedCall[] = [];
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  orchestrator.endAgentTypingForPostedMessage = async (input: PostedCall) => { calls.push(input); };
  try {
    const target = `#${f.channel.name}`;
    const sent = await send(app.baseUrl, f.apiKey, { target, content: "hello" });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "sent");
    assert.deepEqual(calls, [{ agentId: f.agentId, serverId: f.serverId, channelId: f.channel.id, channelType: "channel", target }]);

    const [root] = await getDb().insert(messages).values({ channelId: f.channel.id, senderType: "agent", senderId: f.agentId, content: "root" }).returning();
    const threadTarget = `${target}:${root!.id.slice(0, 8)}`;
    const reply = await send(app.baseUrl, f.apiKey, { target: threadTarget, content: "in thread" });
    assert.equal(reply.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.channelType, "thread");
    assert.equal(calls[1]!.target, threadTarget);
    assert.notEqual(calls[1]!.channelId, f.channel.id, "the thread channel, resolved to its root by the orchestrator");

    // A refused send reports nothing.
    const refused = await send(app.baseUrl, f.apiKey, { target: "#does-not-exist", content: "nope" });
    assert.equal(refused.status, 404);
    assert.equal(calls.length, 2);
  } finally {
    delete orchestrator.endAgentTypingForPostedMessage;
  }
});
