import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, archiveChannel, createChannel, findOrCreateDM, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/**
 * A history read carries the card of the channel it is in (for a thread, its
 * parent channel): the fields the passive-AX `channel` resource versions with
 * `channelCardRev`. DMs have no card.
 */
async function seedFixture() {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `glimpse-card-${suffix}@slock.test`,
    name: `glimpse-card-${suffix}`,
    displayName: "Card Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Channel Card Test", `glimpse-card-${suffix.slice(0, 8)}`, owner.id);
  const agent = await createAgent(server.id, "CardBot", { runtime: "claude", model: "sonnet" });

  const ops = await createChannel(server.id, "ops", "Release coordination. Post go/no-go here.");
  const secret = await createChannel(server.id, "incident", undefined, "private");
  for (const channel of [ops, secret]) {
    await addHuman(channel.id, owner.id);
    await addAgent(channel.id, agent.id);
  }
  const anchor = await createMessage(ops.id, "user", owner.id, "deploy at 5?", "chat");
  const thread = await getOrCreateThread(anchor.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "yes", "chat");
  await createMessage(secret.id, "user", owner.id, "postmortem draft", "chat");
  await archiveChannel(secret.id, owner.id);
  const dm = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);
  await createMessage(dm.id, "user", owner.id, "hello", "chat");

  const credential = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "glimpse-card", issuedVia: "computer", createdByUserId: null });
  return { owner, ops, secret, anchor, apiKey: credential.apiKey };
}

async function read(baseUrl: string, apiKey: string, target: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(target)}&consume=false`, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

test("history reads carry the channel card; a thread carries its parent's; a DM none", async ({ onTestFinished }) => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  onTestFinished(() => app.close());
  const fx = await seedFixture();

  const opsCard = {
    id: fx.ops.id,
    name: "ops",
    type: "channel",
    description: "Release coordination. Post go/no-go here.",
    archived: false,
  };
  const channelRead = await read(app.baseUrl, fx.apiKey, "#ops");
  assert.equal(channelRead.status, 200);
  assert.deepEqual(channelRead.body.channel_card, opsCard);

  const threadRead = await read(app.baseUrl, fx.apiKey, `#ops:${fx.anchor.id.slice(0, 8)}`);
  assert.equal(threadRead.status, 200);
  assert.deepEqual(threadRead.body.channel_card, opsCard);

  const archivedRead = await read(app.baseUrl, fx.apiKey, "#incident");
  assert.equal(archivedRead.status, 200);
  assert.deepEqual(archivedRead.body.channel_card, {
    id: fx.secret.id,
    name: "incident",
    type: "private",
    description: null,
    archived: true,
  });

  const dmRead = await read(app.baseUrl, fx.apiKey, `dm:@${fx.owner.name}`);
  assert.equal(dmRead.status, 200);
  assert.equal(dmRead.body.channel_card, undefined);
});
