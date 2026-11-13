// The typed `reactions` of the agent API's message envelope (#wg-ax:#26 §2):
// per emoji its count and who reacted, by handle and kind, at most
// AGENT_API_MESSAGE_REACTION_REACTORS_MAX named. On every read that hands
// messages over, with no flag: `agent_reaction_notices_v0` is off here.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { AGENT_API_MESSAGE_REACTION_REACTORS_MAX, agentApiMessageEnvelopeSchema, type AgentApiMessageEnvelope } from "@botiverse/raft-shared";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { messageReactions, thirdPartyAgentEvents } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent } from "../services/channelService";
import { createMessage } from "../services/messageService";

const test = createApiTest();

test("history and the reaction routes: each message's reactions name who reacted, by handle and kind, capped; none when it has none", async ({ app, seed }) => {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seed.human({ name: `tygg-${suffix}`, displayName: "Tygg Display" });
  const people = [];
  for (let index = 0; index < AGENT_API_MESSAGE_REACTION_REACTORS_MAX; index += 1) people.push(await seed.human());
  const server = await seed.server({ owner, members: people });
  const channel = await seed.channel({ server, members: [owner, ...people], name: `proj-${suffix}` });
  const reader = await createAgent(server.id, `Reader${suffix}`, { runtime: "claude", model: "sonnet" });
  const other = await createAgent(server.id, `Other${suffix}`, { runtime: "claude", model: "sonnet" });
  await addAgent(channel.id, reader.id);
  await addAgent(channel.id, other.id);
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send", "reactions"], name: `mr-${suffix}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const [readerKey, otherKey] = [await key(reader.id), await key(other.id)];
  const reacted = await createMessage(channel.id, "agent", reader.id, "Deploy plan is ready");
  const plain = await createMessage(channel.id, "user", owner.id, "no reactions here");

  // ✅ by tygg then the other agent; 👍 by tygg and five more people (six in all), in that order.
  const at = Date.now() - 60_000;
  const react = (reactorType: "user" | "agent", reactorId: string, emoji: string, order: number) =>
    getDb().insert(messageReactions).values({ messageId: reacted.id, reactorType, reactorId, emoji, createdAt: new Date(at + order * 1000) });
  await react("user", owner.id, "✅", 0);
  await react("agent", other.id, "✅", 1);
  await react("user", owner.id, "👍", 2);
  for (const [index, person] of people.entries()) await react("user", person.id, "👍", 3 + index);

  const history = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${channel.name}`)}&limit=50&consume=false`, {
    headers: { Authorization: `Bearer ${readerKey}` },
  });
  assert.equal(history.status, 200, await history.clone().text());
  const body = await history.json() as { messages: AgentApiMessageEnvelope[] };
  for (const message of body.messages) assert.equal(agentApiMessageEnvelopeSchema.safeParse(message).success, true);
  const envelope = body.messages.find((message) => message.id === reacted.id)!;
  assert.deepEqual(envelope.reactions?.map((reaction) => ({ emoji: reaction.emoji, count: reaction.count, reactors: reaction.reactors })), [
    {
      emoji: "✅",
      count: 2,
      reactors: [{ name: owner.name, kind: "human" }, { name: other.name, kind: "agent" }],
    },
    {
      emoji: "👍",
      // The true total; the list names the first five, in the order they reacted.
      count: AGENT_API_MESSAGE_REACTION_REACTORS_MAX + 1,
      reactors: [owner, ...people].slice(0, AGENT_API_MESSAGE_REACTION_REACTORS_MAX).map((person) => ({ name: person.name, kind: "human" })),
    },
  ]);
  assert.deepEqual(body.messages.find((message) => message.id === plain.id)!.reactions ?? [], []);

  // The reaction routes answer the same envelope.
  const add = await fetch(`${app.baseUrl}/internal/agent-api/messages/${plain.id}/reactions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${otherKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ emoji: "👀" }),
  });
  assert.equal(add.status, 200, await add.clone().text());
  const added = await add.json() as AgentApiMessageEnvelope;
  assert.deepEqual(added.reactions?.map((reaction) => ({ emoji: reaction.emoji, count: reaction.count, reactors: reaction.reactors })), [
    { emoji: "👀", count: 1, reactors: [{ name: other.name, kind: "agent" }] },
  ]);

  // Not gated: no reaction notice flag exists here, and nothing was queued for the reactions above.
  assert.deepEqual(await getDb().select({ id: thirdPartyAgentEvents.id }).from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.agentId, reader.id)), []);
});
