import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { channels, serverAgentMembers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { addAgent, addHuman, createChannel, isChannelAgent } from "../services/channelService";
import { createServer } from "../services/serverService";

// A private channel goes with its last member: it is deleted with all its
// messages. The web asks a person "Leave and Delete Channel?" first; an agent
// passes deleteIfLast, and without it the Server refuses and changes nothing.

const test = createApiTest();

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function fixture(prefix: string) {
  const owner = await seedUser(`${prefix}-owner-${randomUUID().slice(0, 6)}`);
  const server = await createServer(`${prefix} server`, `${prefix}-${randomUUID()}`, owner.id);
  const agent = await createAgent(server.id, `${prefix}-agent`, { runtime: "codex" });
  await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(
    eq(serverAgentMembers.serverId, server.id),
    eq(serverAgentMembers.agentId, agent.id),
  ));
  const credential = await mintAgentCredential({ agentId: agent.id, scopes: ["channels", "read", "send"], name: prefix, issuedVia: "human", createdByUserId: owner.id });
  const channel = await createChannel(server.id, `${prefix}-room`, undefined, "private");
  await addAgent(channel.id, agent.id);
  return { owner, server, agent, channel, apiKey: credential.apiKey };
}

/** Leaving or removing a private channel's member purges that agent's inbox for it; the test app's orchestrator has no inbox. */
function stubInboxPurge(app: { app: { get(name: string): unknown } }) {
  (app.app.get("agentOrchestrator") as { purgeAgentInboxForChannelTree: () => Promise<void> }).purgeAgentInboxForChannelTree = async () => {};
}

function call(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function deletedAt(channelId: string) {
  const [row] = await getDb().select({ deletedAt: channels.deletedAt }).from(channels).where(eq(channels.id, channelId));
  return row?.deletedAt ?? null;
}

type Refusal = { error?: string; code?: string; suggestedNextAction?: string };

test("leave: a private channel's last member is refused without deleteIfLast, nothing changed; with it the channel is deleted and the answer says so", async ({ app }) => {
  stubInboxPurge(app);
  const f = await fixture("last-leave");
  const room = `#${f.channel.name}`;

  for (const body of [undefined, {}, { deleteIfLast: false }]) {
    const refused = await call(app.baseUrl, f.apiKey, "POST", `/channels/${f.channel.id}/leave`, body);
    assert.equal(refused.status, 409, JSON.stringify(body));
    const refusal = await refused.json() as Refusal;
    assert.deepEqual(refusal, {
      error: `You are the last member of ${room}, a private channel: leaving would delete the channel and all its messages, and that can't be undone. Nothing changed.`,
      code: "last_member_deletes_channel",
      errorCode: "last_member_deletes_channel",
      suggestedNextAction: `Only if the channel and all its messages should go: raft channel leave --target "${room}" --delete-if-last. Otherwise stay in it, or ask a person to add someone else first.`,
    });
    assert.equal(await isChannelAgent(f.channel.id, f.agent.id), true, "the refused leave rolled back");
    assert.equal(await deletedAt(f.channel.id), null);
  }

  const left = await call(app.baseUrl, f.apiKey, "POST", `/channels/${f.channel.id}/leave`, { deleteIfLast: true });
  assert.equal(left.status, 200);
  assert.equal(((await left.json()) as { channelDeleted?: boolean }).channelDeleted, true);
  assert.equal(await isChannelAgent(f.channel.id, f.agent.id), false);
  assert.ok(await deletedAt(f.channel.id), "deleted with its last member");
});

test("leave: with another member left, deleteIfLast changes nothing and the answer has no channelDeleted", async ({ app }) => {
  stubInboxPurge(app);
  const f = await fixture("not-last");
  await addHuman(f.channel.id, f.owner.id);
  const left = await call(app.baseUrl, f.apiKey, "POST", `/channels/${f.channel.id}/leave`);
  assert.equal(left.status, 200);
  assert.equal("channelDeleted" in (await left.json() as object), false);
  assert.equal(await deletedAt(f.channel.id), null);
});

// An agent sees a private channel only as its member, so the last member it
// can remove is itself.
test("remove-member: an agent removing itself as the last member is refused the same way, and deleted with deleteIfLast", async ({ app }) => {
  stubInboxPurge(app);
  const f = await fixture("last-self");
  const room = `#${f.channel.name}`;
  const refused = await call(app.baseUrl, f.apiKey, "DELETE", `/channels/${f.channel.id}/members`, { agent: f.agent.name });
  assert.equal(refused.status, 409);
  const refusal = await refused.json() as Refusal;
  assert.equal(refusal.code, "last_member_deletes_channel");
  assert.equal(refusal.suggestedNextAction, `Only if the channel and all its messages should go: raft channel remove-member --target "${room}" --agent @${f.agent.name} --delete-if-last. Otherwise leave them in it.`);
  assert.equal(await isChannelAgent(f.channel.id, f.agent.id), true);

  const removed = await call(app.baseUrl, f.apiKey, "DELETE", `/channels/${f.channel.id}/members`, { agent: f.agent.name, deleteIfLast: true });
  assert.equal(removed.status, 200);
  assert.equal(((await removed.json()) as { channelDeleted?: boolean }).channelDeleted, true);
  assert.ok(await deletedAt(f.channel.id));
});
