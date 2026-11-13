// A card never carries a computer's name (Tenny, #14226 follow-up): computers
// are listed only to those with viewMachines, so a Guest, or a viewer from
// another server in a shared channel, could otherwise read a computer's name
// off a card. agent:create's suggested/required computer and agent:migrate's
// current and suggested computer are references by id only; a viewer who may
// list computers names them from their own list. Checked on what such a
// viewer's client receives, and on every stored message (the card's spec, its
// plain-text summary, a done card rebuilt by mark-executed, the result reply).
import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agentMigrations, agents, jointChannels, jointChannelServers, machines, messages, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import * as channelService from "../services/channelService";
import { prepareActionCard } from "../services/actionCardsService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@test.invalid`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

function stubOrchestrator(app: { app: { set: (key: string, value: unknown) => void } }) {
  const deliverMessage = async () => ({ status: "queued", reason: "test" });
  app.app.set("agentOrchestrator", {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<unknown>) => batch.map(() => deliverMessage()),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
}

/** Two computers on `serverId` with names that appear nowhere else, and an agent on the first. */
async function seedComputersAndAgent(serverId: string, ownerId: string, channelId: string) {
  const tag = randomUUID().slice(0, 6);
  const sourceName = `secret-source-${tag}`;
  const targetName = `secret-target-${tag}`;
  const [source, target] = await getDb().insert(machines).values([
    { serverId, userId: ownerId, name: sourceName, apiKeyHash: `noname-src-${randomUUID()}`, runtimes: ["claude"] },
    { serverId, userId: ownerId, name: targetName, apiKeyHash: `noname-dst-${randomUUID()}`, runtimes: ["claude"] },
  ]).returning();
  const agent = await createAgent(serverId, `noname-agent-${tag}`, { runtime: "claude" });
  await getDb().update(agents).set({ creatorType: "user", creatorId: ownerId, machineId: source!.id }).where(eq(agents.id, agent.id));
  await channelService.addAgent(channelId, agent.id);
  return { source: source!, target: target!, agent, secretNames: [sourceName, targetName] };
}

/** Every card type that shows a computer, prepared by name as an agent writes it. */
async function prepareComputerCards(serverId: string, agentId: string, channelId: string, sourceName: string, targetName: string) {
  const prepare = (action: Record<string, unknown>) => prepareActionCard({
    serverId, requesterAgentId: agentId, targetChannelId: channelId, agentAuthored: true,
    action: action as Parameters<typeof prepareActionCard>[0]["action"],
  });
  return {
    createSuggested: await prepare({ type: "agent:create", name: `scribe-${randomUUID().slice(0, 6)}`, suggestedComputer: targetName }),
    createRequired: await prepare({ type: "agent:create", name: `scribe-${randomUUID().slice(0, 6)}`, requiredComputer: sourceName }),
    migrate: await prepare({ type: "agent:migrate", suggestedComputer: targetName }),
  };
}

async function startMigration(serverId: string, agentId: string, sourceId: string, targetId: string) {
  const deadline = new Date(Date.now() + 10 * 60_000);
  await getDb().insert(agentMigrations).values({
    contractVersion: 2, serverId, agentId, sourceMachineId: sourceId, targetMachineId: targetId,
    sourceMachineNameSnapshot: "s", targetMachineNameSnapshot: "t", state: "prep",
    grantKey: `noname:${randomUUID()}`, prepDeadlineAt: deadline, transferDeadlineAt: deadline, arrivalDeadlineAt: deadline,
  });
}

function assertNoName(text: string, secretNames: readonly string[], where: string) {
  for (const name of secretNames) assert.equal(text.includes(name), false, `${where} names computer ${name}`);
}

test("a Guest in the card's channel receives every computer card, prepared and done, with no computer's name in it", async ({ app }) => {
  stubOrchestrator(app);
  const owner = await seedUser("noname-owner");
  const guest = await seedUser("noname-guest");
  const server = await createServer("No Name", `noname-${randomUUID().slice(0, 8)}`, owner.id);
  const channel = await channelService.createChannel(server.id, `noname-${randomUUID().slice(0, 6)}`);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: guest.id, role: "guest", guestChannelId: channel.id });
  for (const user of [owner, guest]) await channelService.addHuman(channel.id, user.id);
  const f = await seedComputersAndAgent(server.id, owner.id, channel.id);
  const cards = await prepareComputerCards(server.id, f.agent.id, channel.id, f.secretNames[0]!, f.secretNames[1]!);

  // The cards do show the computers, by id.
  const migrateSpec = JSON.stringify(cards.migrate.metadata.presentation?.card);
  assert.ok(migrateSpec.includes(f.source.id) && migrateSpec.includes(f.target.id), migrateSpec);

  // Done: the owner records the move; mark-executed rebuilds the card and posts the result reply.
  await startMigration(server.id, f.agent.id, f.source.id, f.target.id);
  const ownerHeaders = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "Content-Type": "application/json", "X-Server-Id": server.id };
  const done = await fetch(`${app.baseUrl}/api/actions/${cards.migrate.messageId}/mark-executed`, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ result: { kind: "agent-migration", agentId: f.agent.id, targetMachineId: f.target.id } }),
  });
  assert.equal(done.status, 200, await done.clone().text());
  assertNoName(await done.text(), f.secretNames, "the mark-executed answer");

  // What the Guest's client receives.
  const read = await fetch(`${app.baseUrl}/api/messages/channel/${channel.id}?limit=50`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(guest.email)}`, "X-Server-Id": server.id },
  });
  const body = await read.text();
  assert.equal(read.status, 200, body);
  for (const card of Object.values(cards)) assert.ok(body.includes(card.messageId), `the Guest reads card ${card.messageId}`);
  assertNoName(body, f.secretNames, "the Guest's channel read");

  // And nothing stored names them: carriers (spec, legacy fields, plain-text summary), the done card, the result reply.
  const stored = await getDb().select({ content: messages.content, actionMetadata: messages.actionMetadata }).from(messages);
  assertNoName(JSON.stringify(stored), f.secretNames, "a stored message");
});

test("a viewer from another server in a Joint channel receives the card with no computer's name in it", async ({ app }) => {
  stubOrchestrator(app);
  const db = getDb();
  const hostOwner = await seedUser("noname-joint-host");
  const peerOwner = await seedUser("noname-joint-peer");
  const hostServer = await createServer("NoName Host", `noname-host-${randomUUID().slice(0, 8)}`, hostOwner.id);
  const peerServer = await createServer("NoName Peer", `noname-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
  const canonical = await channelService.createChannel(hostServer.id, `noname-joint-storage-${randomUUID().slice(0, 4)}`, undefined, "channel");
  const hostProjection = await channelService.createChannel(hostServer.id, `noname-joint-${randomUUID().slice(0, 4)}`, undefined, "joint");
  const peerProjection = await channelService.createChannel(peerServer.id, `noname-joint-${randomUUID().slice(0, 4)}`, undefined, "joint");
  await channelService.addHuman(hostProjection.id, hostOwner.id);
  await channelService.addHuman(peerProjection.id, peerOwner.id);
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: hostServer.id, createdByUserId: hostOwner.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: hostOwner.id },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await fillJointMembersFromChannelHumans();
  const f = await seedComputersAndAgent(hostServer.id, hostOwner.id, hostProjection.id);
  const cards = await prepareComputerCards(hostServer.id, f.agent.id, hostProjection.id, f.secretNames[0]!, f.secretNames[1]!);

  // The peer server's owner reads the shared channel from their own server.
  const read = await fetch(`${app.baseUrl}/api/messages/channel/${peerProjection.id}?limit=50`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(peerOwner.email)}`, "X-Server-Id": peerServer.id },
  });
  const body = await read.text();
  assert.equal(read.status, 200, body);
  for (const card of Object.values(cards)) assert.ok(body.includes(card.messageId), `the peer reads card ${card.messageId}`);
  assertNoName(body, f.secretNames, "the peer's channel read");
  const stored = await db.select({ actionMetadata: messages.actionMetadata }).from(messages)
    .where(and(eq(messages.channelId, canonical.id)));
  assertNoName(JSON.stringify(stored), f.secretNames, "a stored carrier");
});
