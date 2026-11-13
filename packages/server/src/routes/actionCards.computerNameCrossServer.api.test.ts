// For an agent of another server, a computer's name is never shown (product
// rule; hover cards since #14009). Action cards name no computer to anyone
// (#14234, #14240): a computer on a card is a reference by id, and only a
// viewer who may list the card server's computers (viewMachines there) names
// it, from their own list. Here, in a Joint channel, every exit that serves an
// agent:create (suggested and required computer) or agent:migrate card
// (current and suggested computer, the done card's target) is checked for
// each reader: the host server's owner gets the id and can name it from the
// host's computer list; another server's owner and another server's agent get
// no name and cannot list the host's computers. Exits: the history read, the
// per-server socket fanout (message:new and message:updated), the card
// route's answer, and the agent API. A Guest (who cannot be in a Joint
// channel) is checked in the card's own server's channel: no name, and no
// computer list to name it from.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agentMigrations, agents, jointChannels, jointChannelServers, machines, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import * as channelService from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { updateAgentScopes } from "../services/agentScopesService";
import { emitActionCardMessageUpdated, prepareActionCard } from "../services/actionCardsService";
import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";

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

/** The test orchestrator, delivering nothing (the computer list it also serves keeps working). */
function stubDelivery(app: { app: { get: (key: string) => unknown } }) {
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  const deliverMessage = async () => ({ status: "queued", reason: "test" });
  Object.assign(orchestrator, {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<unknown>) => batch.map(() => deliverMessage()),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
}

type Emitted = { room: string; event: string; payload: unknown };

/** A socket server that records what the card fanout emits, room by room. */
function recordingIo() {
  const emitted: Emitted[] = [];
  const io = {
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); return true; } }),
    in: (_room: string) => ({ socketsJoin: () => undefined }),
  };
  return { emitted, io: io as unknown as NonNullable<Parameters<typeof prepareActionCard>[0]["io"]> };
}

function assertNoName(text: string, secretNames: readonly string[], where: string) {
  for (const name of secretNames) assert.equal(text.includes(name), false, `${where} names computer ${name}`);
}

async function get(baseUrl: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { status: response.status, body: await response.text() };
}

async function seedJoint() {
  const db = getDb();
  const hostOwner = await seedUser("xs-host");
  const peerOwner = await seedUser("xs-peer");
  const hostServer = await createServer("XS Host", `xs-host-${randomUUID().slice(0, 8)}`, hostOwner.id);
  const peerServer = await createServer("XS Peer", `xs-peer-${randomUUID().slice(0, 8)}`, peerOwner.id);
  const canonical = await channelService.createChannel(hostServer.id, `xs-joint-storage-${randomUUID().slice(0, 4)}`, undefined, "channel");
  const hostProjection = await channelService.createChannel(hostServer.id, `xs-joint-${randomUUID().slice(0, 4)}`, undefined, "joint");
  const peerProjection = await channelService.createChannel(peerServer.id, `xs-joint-${randomUUID().slice(0, 4)}`, undefined, "joint");
  await channelService.addHuman(hostProjection.id, hostOwner.id);
  await channelService.addHuman(peerProjection.id, peerOwner.id);
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: hostServer.id, createdByUserId: hostOwner.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: hostOwner.id },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  // Joint access is computed membership only: give both owners their J member rows.
  await fillJointMembersFromChannelHumans([joint!.id]);

  // Two host computers with names that appear nowhere else; the host agent runs on the first.
  const tag = randomUUID().slice(0, 6);
  const secretNames = [`xs-source-${tag}`, `xs-target-${tag}`];
  const [source, target] = await db.insert(machines).values([
    { serverId: hostServer.id, userId: hostOwner.id, name: secretNames[0]!, apiKeyHash: `xs-src-${randomUUID()}`, runtimes: ["claude"] },
    { serverId: hostServer.id, userId: hostOwner.id, name: secretNames[1]!, apiKeyHash: `xs-dst-${randomUUID()}`, runtimes: ["claude"] },
  ]).returning();
  const hostAgent = await createAgent(hostServer.id, `xs-host-agent-${tag}`, { runtime: "claude" });
  await db.update(agents).set({ creatorType: "user", creatorId: hostOwner.id, machineId: source!.id }).where(eq(agents.id, hostAgent.id));
  await channelService.addAgent(hostProjection.id, hostAgent.id);

  // The peer server's agent reads the shared channel from its own server.
  const peerAgent = await createAgent(peerServer.id, `xs-peer-agent-${tag}`, { runtime: "claude" });
  await channelService.addAgent(peerProjection.id, peerAgent.id);
  await updateAgentScopes({ agentId: peerAgent.id, scopes: ["message:read"], updatedByUserId: peerOwner.id });
  const peerAgentKey = (await mintAgentCredential({ agentId: peerAgent.id, scopes: ["read"], name: "xs-peer", issuedVia: "computer", createdByUserId: null })).apiKey;

  const human = async (user: { email: string }, serverId: string) => ({ Authorization: `Bearer ${await tokenForHuman(user.email)}`, "X-Server-Id": serverId });
  return {
    hostServer, peerServer, hostProjection, peerProjection, hostAgent, source: source!, target: target!, secretNames,
    hostOwnerHeaders: await human(hostOwner, hostServer.id),
    peerOwnerHeaders: await human(peerOwner, peerServer.id),
    peerAgentHeaders: { Authorization: `Bearer ${peerAgentKey}` },
  };
}

type Card = { messageId: string };
type ReadMessage = { id: string; actionMetadata?: { presentation?: { card?: unknown } } };

/** The card messages in a human channel read; each must be there. */
function cardsIn(body: string, cards: readonly Card[], who: string): ReadMessage[] {
  const read = (JSON.parse(body) as { messages: ReadMessage[] }).messages;
  return cards.map((card) => {
    const message = read.find((candidate) => candidate.id === card.messageId);
    assert.ok(message, `${who} reads card ${card.messageId}`);
    return message;
  });
}

test("in a Joint channel only the host server's members can name a card's computer; another server's members and agents get no name by any exit", async ({ app }) => {
  stubDelivery(app);
  const f = await seedJoint();
  const { emitted, io } = recordingIo();
  const prepare = (action: Record<string, unknown>) => prepareActionCard({
    serverId: f.hostServer.id, requesterAgentId: f.hostAgent.id, targetChannelId: f.hostProjection.id, agentAuthored: true,
    action: action as Parameters<typeof prepareActionCard>[0]["action"], io,
  });
  // Prepared by name, as an agent writes them.
  const createSuggested = await prepare({ type: "agent:create", name: `xs-scribe-${randomUUID().slice(0, 6)}`, suggestedComputer: f.secretNames[1] });
  const createRequired = await prepare({ type: "agent:create", name: `xs-scribe-${randomUUID().slice(0, 6)}`, requiredComputer: f.secretNames[0] });
  const migrate = await prepare({ type: "agent:migrate", suggestedComputer: f.secretNames[1] });
  const cards = [createSuggested, createRequired, migrate];

  // The migrate card done: mark-executed rebuilds it with its target, then the fanout sends the update.
  const deadline = new Date(Date.now() + 10 * 60_000);
  await getDb().insert(agentMigrations).values({
    contractVersion: 2, serverId: f.hostServer.id, agentId: f.hostAgent.id, sourceMachineId: f.source.id, targetMachineId: f.target.id,
    sourceMachineNameSnapshot: f.secretNames[0]!, targetMachineNameSnapshot: f.secretNames[1]!, state: "prep",
    grantKey: `xs:${randomUUID()}`, prepDeadlineAt: deadline, transferDeadlineAt: deadline, arrivalDeadlineAt: deadline,
  });
  const done = await fetch(`${app.baseUrl}/api/actions/${migrate.messageId}/mark-executed`, {
    method: "POST", headers: { ...f.hostOwnerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ result: { kind: "agent-migration", agentId: f.hostAgent.id, targetMachineId: f.target.id } }),
  });
  const doneBody = await done.text();
  assert.equal(done.status, 200, doneBody);
  assertNoName(doneBody, f.secretNames, "the mark-executed answer");
  await emitActionCardMessageUpdated(io, { id: migrate.messageId });

  // The host owner: the cards carry the computers by id, and the host's computer list names them.
  const hostRead = await get(app.baseUrl, `/api/messages/channel/${f.hostProjection.id}?limit=50`, f.hostOwnerHeaders);
  assert.equal(hostRead.status, 200, hostRead.body);
  const [hostSuggested, hostRequired, hostMigrate] = cardsIn(hostRead.body, cards, "the host owner").map((m) => JSON.stringify(m.actionMetadata?.presentation?.card));
  assert.ok(hostSuggested!.includes(f.target.id), "agent:create shows its suggested computer by id");
  assert.ok(hostRequired!.includes(f.source.id), "agent:create shows its required computer by id");
  assert.ok(hostMigrate!.includes(f.source.id) && hostMigrate!.includes(f.target.id), "agent:migrate shows its current and target computers by id");
  assertNoName(hostRead.body, f.secretNames, "the host owner's channel read");
  const hostList = await get(app.baseUrl, `/api/servers/${f.hostServer.id}/machines`, f.hostOwnerHeaders);
  assert.equal(hostList.status, 200, hostList.body);
  for (const name of f.secretNames) assert.ok(hostList.body.includes(name), `the host owner's computer list names ${name}`);

  // Another server's owner: the same cards, no name, and no host computer list to name them from.
  const peerRead = await get(app.baseUrl, `/api/messages/channel/${f.peerProjection.id}?limit=50`, f.peerOwnerHeaders);
  assert.equal(peerRead.status, 200, peerRead.body);
  cardsIn(peerRead.body, cards, "the peer owner");
  assertNoName(peerRead.body, f.secretNames, "the peer owner's channel read");
  const peerHostList = await get(app.baseUrl, `/api/servers/${f.hostServer.id}/machines`, f.peerOwnerHeaders);
  assert.notEqual(peerHostList.status, 200, "the peer owner cannot list the host's computers");
  assertNoName(peerHostList.body, f.secretNames, "the peer owner's attempt to list the host's computers");
  const peerList = await get(app.baseUrl, `/api/servers/${f.peerServer.id}/machines`, f.peerOwnerHeaders);
  assert.equal(peerList.status, 200, peerList.body);
  assertNoName(peerList.body, f.secretNames, "the peer server's computer list");

  // The socket fanout: one payload per server's room, each naming no computer.
  for (const card of cards) {
    const news = emitted.filter((e) => e.event === "message:new" && (e.payload as { id?: string }).id === card.messageId);
    assert.deepEqual(news.map((e) => e.room).sort(), [`channel:${f.hostProjection.id}`, `channel:${f.peerProjection.id}`].sort(), `card ${card.messageId} reaches both servers' rooms`);
  }
  const updates = emitted.filter((e) => e.event === "message:updated" && (e.payload as { id?: string }).id === migrate.messageId);
  assert.deepEqual(updates.map((e) => e.room).sort(), [`channel:${f.hostProjection.id}`, `channel:${f.peerProjection.id}`].sort(), "the done card reaches both servers' rooms");
  const peerPayload = updates.find((e) => e.room === `channel:${f.peerProjection.id}`)!.payload as { channelId?: string; actionMetadata?: { presentation?: { card?: unknown } } };
  assert.equal(peerPayload.channelId, f.peerProjection.id, "the peer room's payload is projected to the peer's channel");
  assert.ok(JSON.stringify(peerPayload.actionMetadata?.presentation?.card).includes(f.target.id), "the done card's target is there by id");
  assertNoName(JSON.stringify(emitted), f.secretNames, "a socket payload");

  // Another server's agent reading the shared channel: no card, no name.
  const agentRead = await get(app.baseUrl, `/internal/agent-api/history?channel=${encodeURIComponent(`#${f.peerProjection.name}`)}&limit=50&consume=false`, f.peerAgentHeaders);
  assert.equal(agentRead.status, 200, agentRead.body);
  for (const card of cards) assert.ok(agentRead.body.includes(card.messageId), `the peer agent reads card ${card.messageId}`);
  assertNoName(agentRead.body, f.secretNames, "the peer agent's history read");
});

test("a Guest in the card's channel gets the computer cards with no name and cannot list the server's computers to name them", async ({ app }) => {
  stubDelivery(app);
  const db = getDb();
  const owner = await seedUser("xs-guest-owner");
  const guest = await seedUser("xs-guest");
  const server = await createServer("XS Guest", `xs-guest-${randomUUID().slice(0, 8)}`, owner.id);
  const channel = await channelService.createChannel(server.id, `xs-guest-${randomUUID().slice(0, 6)}`);
  await db.insert(serverMembers).values({ serverId: server.id, userId: guest.id, role: "guest", guestChannelId: channel.id });
  for (const user of [owner, guest]) await channelService.addHuman(channel.id, user.id);
  const tag = randomUUID().slice(0, 6);
  const secretNames = [`xs-guest-src-${tag}`, `xs-guest-dst-${tag}`];
  const [source, target] = await db.insert(machines).values([
    { serverId: server.id, userId: owner.id, name: secretNames[0]!, apiKeyHash: `xs-gsrc-${randomUUID()}`, runtimes: ["claude"] },
    { serverId: server.id, userId: owner.id, name: secretNames[1]!, apiKeyHash: `xs-gdst-${randomUUID()}`, runtimes: ["claude"] },
  ]).returning();
  const agent = await createAgent(server.id, `xs-guest-agent-${tag}`, { runtime: "claude" });
  await db.update(agents).set({ creatorType: "user", creatorId: owner.id, machineId: source!.id }).where(eq(agents.id, agent.id));
  await channelService.addAgent(channel.id, agent.id);
  const { emitted, io } = recordingIo();
  const prepare = (action: Record<string, unknown>) => prepareActionCard({
    serverId: server.id, requesterAgentId: agent.id, targetChannelId: channel.id, agentAuthored: true,
    action: action as Parameters<typeof prepareActionCard>[0]["action"], io,
  });
  const cards = [
    await prepare({ type: "agent:create", name: `xs-scribe-${randomUUID().slice(0, 6)}`, requiredComputer: secretNames[0] }),
    await prepare({ type: "agent:migrate", suggestedComputer: target!.id }),
  ];
  const guestHeaders = { Authorization: `Bearer ${await tokenForHuman(guest.email)}`, "X-Server-Id": server.id };
  const read = await get(app.baseUrl, `/api/messages/channel/${channel.id}?limit=50`, guestHeaders);
  assert.equal(read.status, 200, read.body);
  cardsIn(read.body, cards, "the Guest");
  assertNoName(read.body, secretNames, "the Guest's channel read");
  assert.equal(emitted.filter((e) => e.event === "message:new").length, cards.length, "each card is sent to the channel's room");
  assertNoName(JSON.stringify(emitted), secretNames, "a socket payload");
  const list = await get(app.baseUrl, `/api/servers/${server.id}/machines`, guestHeaders);
  assert.equal(list.status, 403, list.body);
  assertNoName(list.body, secretNames, "the Guest's attempt to list computers");
});
