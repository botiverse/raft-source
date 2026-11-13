// Cards stored before cards stopped writing computer names (#14234) keep the
// name in their row: no backfill (Tenny). Every exit that serves a card
// strips it at read time instead (withStoredActionCardSpec), for every
// reader, so a guest or a viewer from another server never reads a computer's
// name off a card. Here a card is stored WITH the names, as such rows are,
// read through each exit by an owner, a guest and another server's reader,
// and the row is left as it was (reads never write).
import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agentMigrations, agents, jointChannels, jointChannelServers, machines, messages, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import * as channelService from "../services/channelService";
import * as messageService from "../services/messageService";
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

/** Two computers with names that appear nowhere else, and an agent on the first, in `channelId`. */
async function seedComputers(serverId: string, ownerId: string, channelId: string) {
  const tag = randomUUID().slice(0, 6);
  const names = { source: `legacy-source-${tag}`, target: `legacy-target-${tag}` };
  const [source, target] = await getDb().insert(machines).values([
    { serverId, userId: ownerId, name: names.source, apiKeyHash: `strip-src-${randomUUID()}`, runtimes: ["claude"] },
    { serverId, userId: ownerId, name: names.target, apiKeyHash: `strip-dst-${randomUUID()}`, runtimes: ["claude"] },
  ]).returning();
  const agent = await createAgent(serverId, `strip-agent-${tag}`, { runtime: "claude" });
  await getDb().update(agents).set({ creatorType: "user", creatorId: ownerId, machineId: source!.id }).where(eq(agents.id, agent.id));
  await channelService.addAgent(channelId, agent.id);
  const byId = { [source!.id]: names.source, [target!.id]: names.target };
  return { source: source!, target: target!, agent, secretNames: Object.values(names), byId };
}

/**
 * The card as a row stored before #14234 holds it: every computer reference's
 * fallback is the computer's name. Written straight to the message row.
 */
async function storeWithComputerNames(messageId: string, byId: Record<string, string>): Promise<string> {
  const [row] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId));
  const named = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(named);
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    if (record.kind === "computer" && typeof record.id === "string" && byId[record.id]) return { ...record, fallback: byId[record.id] };
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, named(child)]));
  };
  const metadata = named(row!.actionMetadata);
  await getDb().update(messages).set({ actionMetadata: metadata as object }).where(eq(messages.id, messageId));
  const stored = JSON.stringify(metadata);
  assert.ok(Object.values(byId).some((name) => stored.includes(name)), `the stored card names a computer (fixture): ${stored}`);
  return stored;
}

async function storedMetadata(messageId: string): Promise<string> {
  const [row] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId));
  return JSON.stringify(row!.actionMetadata);
}

function assertNoName(text: string, secretNames: readonly string[], where: string) {
  for (const name of secretNames) assert.equal(text.includes(name), false, `${where} names computer ${name}`);
}

async function read(baseUrl: string, path: string, user: { email: string }, serverId: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${await tokenForHuman(user.email)}`, "X-Server-Id": serverId } });
  const body = await response.text();
  assert.equal(response.status, 200, `${path}: ${body}`);
  return body;
}

test("a card stored with computer names is served without them, to an owner and a Guest, by every exit; the row is unchanged", async ({ app }) => {
  stubOrchestrator(app);
  const owner = await seedUser("strip-owner");
  const guest = await seedUser("strip-guest");
  const server = await createServer("Strip", `strip-${randomUUID().slice(0, 8)}`, owner.id);
  const channel = await channelService.createChannel(server.id, `strip-${randomUUID().slice(0, 6)}`);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: guest.id, role: "guest", guestChannelId: channel.id });
  for (const user of [owner, guest]) await channelService.addHuman(channel.id, user.id);
  const f = await seedComputers(server.id, owner.id, channel.id);
  const prepare = (action: Record<string, unknown>, targetChannelId = channel.id) => prepareActionCard({
    serverId: server.id, requesterAgentId: f.agent.id, targetChannelId, agentAuthored: true,
    action: action as Parameters<typeof prepareActionCard>[0]["action"],
  });

  // A prepared agent:create card, and an agent:migrate card done (its rebuilt card never rebuilt again).
  const create = await prepare({ type: "agent:create", name: `scribe-${randomUUID().slice(0, 6)}`, suggestedComputer: f.target.id });
  const migrate = await prepare({ type: "agent:migrate", suggestedComputer: f.target.id });
  const deadline = new Date(Date.now() + 10 * 60_000);
  await getDb().insert(agentMigrations).values({
    contractVersion: 2, serverId: server.id, agentId: f.agent.id, sourceMachineId: f.source.id, targetMachineId: f.target.id,
    sourceMachineNameSnapshot: "s", targetMachineNameSnapshot: "t", state: "prep",
    grantKey: `strip:${randomUUID()}`, prepDeadlineAt: deadline, transferDeadlineAt: deadline, arrivalDeadlineAt: deadline,
  });
  const ownerHeaders = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "Content-Type": "application/json", "X-Server-Id": server.id };
  const markMigrate = () => fetch(`${app.baseUrl}/api/actions/${migrate.messageId}/mark-executed`, {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ result: { kind: "agent-migration", agentId: f.agent.id, targetMachineId: f.target.id } }),
  });
  assert.equal((await markMigrate()).status, 200);
  // A card in a thread (a thread read).
  const thread = await channelService.getOrCreateThreadForChannel(channel.id, create.messageId, owner.id, "user");
  await channelService.addHuman(thread.id, guest.id).catch(() => undefined);
  const inThread = await prepare({ type: "agent:create", name: `scribe-${randomUUID().slice(0, 6)}`, requiredComputer: f.source.id }, thread.id);

  const cards = [create, migrate, inThread];
  const before = new Map<string, string>();
  for (const card of cards) before.set(card.messageId, await storeWithComputerNames(card.messageId, f.byId));

  for (const user of [owner, guest]) {
    const who = user === owner ? "owner" : "guest";
    const channelRead = await read(app.baseUrl, `/api/messages/channel/${channel.id}?limit=50`, user, server.id);
    assert.ok(channelRead.includes(create.messageId) && channelRead.includes(migrate.messageId), `${who}: channel read has the cards`);
    assertNoName(channelRead, f.secretNames, `${who}: the channel read`);
    const around = await read(app.baseUrl, `/api/messages/context/${migrate.messageId}?channelId=${channel.id}`, user, server.id);
    assert.ok(around.includes(migrate.messageId), `${who}: around read has the card`);
    assertNoName(around, f.secretNames, `${who}: the read around a message`);
    const threadRead = await read(app.baseUrl, `/api/messages/channel/${thread.id}?limit=50`, user, server.id);
    assert.ok(threadRead.includes(inThread.messageId), `${who}: thread read has the card`);
    assertNoName(threadRead, f.secretNames, `${who}: the thread read`);
  }
  const sync = await read(app.baseUrl, `/api/messages/sync?since_seq=0&channel_id=${channel.id}`, owner, server.id);
  assert.ok(sync.includes(migrate.messageId), "sync has the card");
  assertNoName(sync, f.secretNames, "the sync read");
  // What a socket payload is built from (emitActionCardCarrierMessage reads the card by id).
  assertNoName(JSON.stringify(await messageService.listMessagesByIds(cards.map((card) => card.messageId))), f.secretNames, "the by-id read (socket payloads)");
  // The card routes: marking the done card again answers with the card.
  const again = await markMigrate();
  const againBody = await again.text();
  assert.equal(again.status, 200, againBody);
  assert.ok(againBody.includes(f.target.id), "the answer has the card");
  assertNoName(againBody, f.secretNames, "the mark-executed answer");

  // Reads never write: each row still holds what it was stored with.
  for (const card of cards) assert.equal(await storedMetadata(card.messageId), before.get(card.messageId), `the row of ${card.messageId} is unchanged`);
});

test("a card stored with computer names is served without them to another server's reader in a Joint channel; the row is unchanged", async ({ app }) => {
  stubOrchestrator(app);
  const db = getDb();
  const hostOwner = await seedUser("strip-joint-host");
  const peerOwner = await seedUser("strip-joint-peer");
  const hostServer = await createServer("Strip Host", `strip-host-${randomUUID().slice(0, 8)}`, hostOwner.id);
  const peerServer = await createServer("Strip Peer", `strip-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
  const canonical = await channelService.createChannel(hostServer.id, `strip-joint-storage-${randomUUID().slice(0, 4)}`, undefined, "channel");
  const hostProjection = await channelService.createChannel(hostServer.id, `strip-joint-${randomUUID().slice(0, 4)}`, undefined, "joint");
  const peerProjection = await channelService.createChannel(peerServer.id, `strip-joint-${randomUUID().slice(0, 4)}`, undefined, "joint");
  await channelService.addHuman(hostProjection.id, hostOwner.id);
  await channelService.addHuman(peerProjection.id, peerOwner.id);
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: hostServer.id, createdByUserId: hostOwner.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: hostOwner.id },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await fillJointMembersFromChannelHumans();
  const f = await seedComputers(hostServer.id, hostOwner.id, hostProjection.id);
  const card = await prepareActionCard({
    serverId: hostServer.id, requesterAgentId: f.agent.id, targetChannelId: hostProjection.id, agentAuthored: true,
    action: { type: "agent:migrate", suggestedComputer: f.target.id },
  });
  const before = await storeWithComputerNames(card.messageId, f.byId);

  for (const [user, serverId, channelId, who] of [
    [peerOwner, peerServer.id, peerProjection.id, "the peer"],
    [hostOwner, hostServer.id, hostProjection.id, "the host owner"],
  ] as const) {
    const body = await read(app.baseUrl, `/api/messages/channel/${channelId}?limit=50`, user, serverId);
    assert.ok(body.includes(card.messageId), `${who} reads the card`);
    assertNoName(body, f.secretNames, `${who}'s channel read`);
  }
  assert.equal(await storedMetadata(card.messageId), before, "the row is unchanged");
});
