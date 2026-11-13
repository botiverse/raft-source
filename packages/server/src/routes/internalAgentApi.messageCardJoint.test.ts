// RFC 082 v1.8: a card message in a Joint Channel, stored once, in canonical
// storage: sent through the sender's own Server's projection (a channel or a
// thread in it), behind the sender's Server's `message_cards` flag only, or
// moved there by a conversion. Its sender updates it through its OWN Server's
// projection, found by the credential's Server, with the checks a send there
// gets; every other caller, and a sender whose side of the joint is gone, gets
// the unknown message's 404. Its revisions are read through the viewer's own
// Server's projection, under that Server's history window. A Slack-bridged
// joint mirrors and edits only what is sent through the host's projection.
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { messageCardMetadataAtSend, parseMessageCard, type MessageCardInput } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import {
  channelConversionJobs,
  channels,
  externalCardEditSyncs,
  externalOutboundDeliveries,
  jointChannels,
  jointChannelServers,
  messageCardRevisions,
  messages,
  serverExternalFreezes,
  servers,
  tasks,
  users,
} from "../db/schema";
import { addMember, createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, archiveChannel, createChannel, removeAgent, unarchiveChannel } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createMessage } from "../services/messageService";
import { applyMessageCardUpdate } from "../services/messageCardService";
import { runChannelConversionJob, startChannelToJointConversion } from "../services/channelConversionService";
import * as planService from "../services/planService";
import { JOINT_CHANNEL_READ_ONLY_ERROR } from "../services/planService";
import * as taskService from "../services/taskService";
import { seedJointChannel } from "../test/integration/jointFixture";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import { enableExternalChannelsFlag } from "../test/externalInviteFixture";
import { confirmOriginal, CONVERSATION, seedJointSlackCardEditPair, TS } from "../test/slackCardEditFixture";
import { createSlackBridgeDatabaseOutboundRuntime } from "../services/slackBridgeDatabaseOutboundRuntime";
import type { SlackBridgeProviderRuntime } from "../services/slackBridgeProviderRuntime";
import type { SlackBridgeRenderSnapshot } from "../services/externalDeliveryOutboxService";
import { readSlackCardEditSyncState } from "../services/slackCardEditSync";
import { processSlackCardEditSyncOnce } from "../services/slackCardEditWorkerService";
import { SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA, type SlackWebApiRequest } from "../services/slackProviderAdapter";

const test = createApiTest();

afterEach(() => {
  vi.restoreAllMocks();
});

type Human = typeof users.$inferSelect;
type Plan = "free" | "pro" | "founder";

async function seedHuman(label: string): Promise<Human> {
  const suffix = randomUUID().slice(0, 8);
  const [human] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return human!;
}

async function credentialFor(agentId: string): Promise<string> {
  return (await mintAgentCredential({ agentId, scopes: ["send", "read", "tasks"], name: "message-card-joint-test", issuedVia: "computer", createdByUserId: null })).apiKey;
}

async function setPlan(serverId: string, plan: Plan) {
  await getDb().update(servers).set({ plan }).where(eq(servers.id, serverId));
}

async function serverWithCards(label: string, ownerId: string) {
  return createServer(`Joint Card ${label}`, `joint-card-${label}-${randomUUID().slice(0, 8)}`, ownerId);
}

/**
 * A joint channel #builds-… between Host (its host) and Peer, shaped like
 * production (seedJointChannel): each side's owner and agent in its own
 * projection, Host's Reviewer agent too, and Server C outside the joint with
 * an agent of its own.
 */
async function seedJointFixture() {
  const hostOwner = await seedHuman("host-owner");
  const peerOwner = await seedHuman("peer-owner");
  const cOwner = await seedHuman("c-owner");
  const host = await serverWithCards("host", hostOwner.id);
  const peer = await serverWithCards("peer", peerOwner.id);
  const serverC = await serverWithCards("c", cOwner.id);
  const name = `builds-${randomUUID().slice(0, 8)}`;
  const joint = await seedJointChannel({ name, serverIds: [host.id, peer.id], createdByUserId: hostOwner.id });
  const [hostProjection, peerProjection] = joint.projections as [typeof joint.projections[0], typeof joint.projections[0]];
  await addHuman(hostProjection.id, hostOwner.id);
  await addHuman(peerProjection.id, peerOwner.id);
  const hostAgent = await createAgent(host.id, "HandsBot", { runtime: "claude", model: "sonnet" });
  const reviewer = await createAgent(host.id, "Reviewer", { runtime: "claude", model: "sonnet" });
  const peerAgent = await createAgent(peer.id, "PeerBot", { runtime: "claude", model: "sonnet" });
  const cAgent = await createAgent(serverC.id, "Stranger", { runtime: "claude", model: "sonnet" });
  await addAgent(hostProjection.id, hostAgent.id);
  await addAgent(hostProjection.id, reviewer.id);
  await addAgent(peerProjection.id, peerAgent.id);
  for (const server of [host, peer, serverC]) await setPlan(server.id, "founder");
  return {
    hostOwner, peerOwner, cOwner, host, peer, serverC, name, joint, hostProjection, peerProjection,
    hostAgent, reviewer, peerAgent, cAgent,
    hostKey: await credentialFor(hostAgent.id),
    reviewerKey: await credentialFor(reviewer.id),
    peerKey: await credentialFor(peerAgent.id),
    cKey: await credentialFor(cAgent.id),
  };
}
type Fixture = Awaited<ReturnType<typeof seedJointFixture>>;

async function call(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as any };
}

const sendText = (baseUrl: string, apiKey: string, target: string) => call(baseUrl, apiKey, "POST", "/v2/send", { target, content: `text ${randomUUID().slice(0, 6)}` });
const sendCard = (baseUrl: string, apiKey: string, target: string, state: string, extra: Record<string, unknown> = {}) =>
  call(baseUrl, apiKey, "POST", "/v2/send", { target, card: buildCard(state), ...extra });
const updateCard = (baseUrl: string, apiKey: string, messageId: string, body: Record<string, unknown>) =>
  call(baseUrl, apiKey, "PUT", `/messages/${encodeURIComponent(messageId)}/card`, body);

function buildCard(state: string): MessageCardInput {
  return {
    version: 1,
    root: "root",
    elements: {
      root: { type: "Stack", props: {}, children: ["title", "state"] },
      title: { type: "Text", props: { text: "Raft App 1.19.0 (11900001)" } },
      state: { type: "Badge", props: { text: state } },
    },
  };
}

/** The fallback Raft derives from buildCard when the sender writes no content (RFC 082 §4.1: the card as markdown). */
function fallbackOf(state: string): string {
  return `Raft App 1.19.0 (11900001)\n\n[${state}]`;
}

/**
 * A card message (revision 1) of `agentId` stored where a joint's messages
 * live, its canonical channel or thread: what a card send through that
 * agent's projection would store (one row, in canonical storage).
 */
async function seedStoredCard(storageChannelId: string, agentId: string) {
  const parsed = parseMessageCard(buildCard("In review"));
  assert.ok(parsed.ok);
  // The fallback as a Server before the markdown rendering derived it: a stored card keeps what it was sent with.
  const content = "Raft App 1.19.0 (11900001) · In review";
  const message = await createMessage(storageChannelId, "agent", agentId, content, "chat", undefined, {
    actionMetadata: messageCardMetadataAtSend(parsed.card, new Date()),
  });
  await getDb().insert(messageCardRevisions).values({ messageId: message.id, revision: 1, card: parsed.card, content, senderAgentId: agentId });
  return message;
}

async function messageRow(id: string) {
  const [row] = await getDb().select().from(messages).where(eq(messages.id, id));
  return row!;
}

async function revisionsOf(messageId: string) {
  return getDb().select().from(messageCardRevisions).where(eq(messageCardRevisions.messageId, messageId)).orderBy(messageCardRevisions.revision);
}

function recordingIo() {
  const emits: Array<{ room: string; event: string; payload: any }> = [];
  const joinRooms = { in: () => joinRooms, socketsJoin() {} };
  return { emits, io: {
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { emits.push({ room, event, payload }); } }),
    // A send joins thread / DM participants to the room first.
    in: () => joinRooms,
  } };
}

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

async function notFoundBody(baseUrl: string, apiKey: string) {
  const unknown = await updateCard(baseUrl, apiKey, UNKNOWN_ID, { card: buildCard("x") });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "message_card_not_found");
  return unknown.body;
}

function assertNotFound(refused: { status: number; body: unknown }, unknownBody: unknown, label: string) {
  assert.equal(refused.status, 404, `${label}: ${JSON.stringify(refused.body)}`);
  assert.deepEqual(refused.body, unknownBody, `${label}: the unknown message's answer`);
}

test("a joint card: the Host-side sender and the Peer-side sender each update theirs through their own Server's projection", async ({ app }) => {
  const fx = await seedJointFixture();
  const hostCard = await seedStoredCard(fx.joint.canonical.id, fx.hostAgent.id);
  const peerCard = await seedStoredCard(fx.joint.canonical.id, fx.peerAgent.id);
  const { emits, io } = recordingIo();
  app.app.set("io", io);

  const fromHost = await updateCard(app.baseUrl, fx.hostKey, hostCard.id, { card: buildCard("Ready for testing") });
  assert.equal(fromHost.status, 200, JSON.stringify(fromHost.body));
  assert.equal(fromHost.body.revision, 2);
  // The short id names it from the Peer side too (the id lookup through Peer's projection).
  const fromPeer = await updateCard(app.baseUrl, fx.peerKey, peerCard.id.slice(0, 8), { card: buildCard("Approved") });
  assert.equal(fromPeer.status, 200, JSON.stringify(fromPeer.body));
  assert.equal(fromPeer.body.messageId, peerCard.id);
  assert.equal(fromPeer.body.revision, 2);

  assert.equal((await messageRow(hostCard.id)).content, fallbackOf("Ready for testing"));
  assert.equal((await messageRow(peerCard.id)).channelId, fx.joint.canonical.id, "still stored once, in canonical storage");
  assert.deepEqual((await revisionsOf(peerCard.id)).map((r) => [r.revision, r.senderAgentId]), [[1, fx.peerAgent.id], [2, fx.peerAgent.id]]);
  // message:updated reaches every Server's projection.
  for (const projection of [fx.hostProjection, fx.peerProjection]) {
    assert.ok(emits.some((emit) => emit.event === "message:updated" && emit.room === `channel:${projection.id}` && emit.payload.id === peerCard.id),
      `message:updated on ${projection.id}`);
  }
});

test("anyone but the sender, on either Server or outside the joint, gets the unknown message's 404", async ({ app }) => {
  const fx = await seedJointFixture();
  const hostCard = await seedStoredCard(fx.joint.canonical.id, fx.hostAgent.id);
  const peerCard = await seedStoredCard(fx.joint.canonical.id, fx.peerAgent.id);
  const body = { card: buildCard("Ready for testing") };
  const unknown = await notFoundBody(app.baseUrl, fx.hostKey);

  assertNotFound(await updateCard(app.baseUrl, fx.reviewerKey, hostCard.id, body), unknown, "another agent in Host's projection");
  assertNotFound(await updateCard(app.baseUrl, fx.peerKey, hostCard.id, body), unknown, "Peer's agent on Host's card");
  assertNotFound(await updateCard(app.baseUrl, fx.hostKey, peerCard.id, body), unknown, "Host's agent on Peer's card");
  // Server C is in no joint: the mapping is the credential's Server's, never another's.
  assertNotFound(await updateCard(app.baseUrl, fx.cKey, hostCard.id, body), unknown, "an agent of Server C");
  assertNotFound(await updateCard(app.baseUrl, fx.cKey, hostCard.id.slice(0, 8), body), unknown, "an agent of Server C, by short id");
  // A Host agent outside Host's projection.
  const outsider = await createAgent(fx.host.id, "Outsider", { runtime: "claude", model: "sonnet" });
  assertNotFound(await updateCard(app.baseUrl, await credentialFor(outsider.id), hostCard.id, body), unknown, "a Host agent outside the joint");

  for (const id of [hostCard.id, peerCard.id]) assert.equal((await revisionsOf(id)).length, 1, `${id}: nothing changed`);
});

test("the sender's side of the joint gone (removed from its projection, the projection disconnected, the joint closed): the same 404", async ({ app }) => {
  const fx = await seedJointFixture();
  const peerCard = await seedStoredCard(fx.joint.canonical.id, fx.peerAgent.id);
  const body = { card: buildCard("Ready for testing") };
  const unknown = await notFoundBody(app.baseUrl, fx.peerKey);
  const db = getDb();

  await removeAgent(fx.peerProjection.id, fx.peerAgent.id);
  assertNotFound(await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body), unknown, "removed from Peer's projection");
  await addAgent(fx.peerProjection.id, fx.peerAgent.id);
  assert.equal((await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body)).status, 200, "a member again");

  const projectionRow = and(eq(jointChannelServers.jointChannelId, fx.joint.jointChannelId), eq(jointChannelServers.serverId, fx.peer.id));
  await db.update(jointChannelServers).set({ status: "disconnected", disconnectedAt: new Date() }).where(projectionRow);
  assertNotFound(await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body), unknown, "Peer's projection disconnected");
  await db.update(jointChannelServers).set({ status: "active", disconnectedAt: null }).where(projectionRow);

  await db.update(jointChannels).set({ status: "closed" }).where(eq(jointChannels.id, fx.joint.jointChannelId));
  assertNotFound(await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body), unknown, "the joint closed");
  await db.update(jointChannels).set({ status: "active" }).where(eq(jointChannels.id, fx.joint.jointChannelId));

  assert.equal((await updateCard(app.baseUrl, fx.peerKey, peerCard.id, { card: buildCard("Approved") })).status, 200);
  assert.equal((await revisionsOf(peerCard.id)).length, 3, "only the two updates the sender could make");
});

test("a committed joint card update, then its sender removed from its projection: the same key answers the first update again; a new key is the unknown message's 404", async ({ app }) => {
  const fx = await seedJointFixture();
  const peerCard = await seedStoredCard(fx.joint.canonical.id, fx.peerAgent.id);
  const unknown = await notFoundBody(app.baseUrl, fx.peerKey);
  const body = { card: buildCard("Ready for testing"), idempotencyKey: "joint-ready-11900001" };
  const first = await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.revision, 2);

  await removeAgent(fx.peerProjection.id, fx.peerAgent.id);
  const { emits, io } = recordingIo();
  app.app.set("io", io);
  // The retry of a committed update answers before every check (RFC 082, #12806), lost access included.
  const retried = await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.deepEqual(retried.body, first.body, "the first answer again");
  assert.deepEqual(emits, [], "a replay changes nothing and emits nothing");
  // Anything new runs the checks: no longer the sender's to update from there.
  assertNotFound(await updateCard(app.baseUrl, fx.peerKey, peerCard.id, { ...body, idempotencyKey: "joint-ready-11900001-again" }),
    unknown, "a new key after the removal");
  assertNotFound(await updateCard(app.baseUrl, fx.peerKey, peerCard.id, { card: buildCard("Approved") }), unknown, "no key after the removal");
  assert.equal((await revisionsOf(peerCard.id)).length, 2, "one revision for the key, nothing after the removal");
});

test("an archived joint: 409 channel_archived as a send there; the archive is on the projections, not the canonical row; a removed sender still learns nothing", async ({ app }) => {
  const fx = await seedJointFixture();
  const hostCard = await seedStoredCard(fx.joint.canonical.id, fx.hostAgent.id);
  const peerCard = await seedStoredCard(fx.joint.canonical.id, fx.peerAgent.id);
  const body = { card: buildCard("Ready for testing") };
  const unknown = await notFoundBody(app.baseUrl, fx.peerKey);
  await archiveChannel(fx.hostProjection.id, fx.hostOwner.id);
  const [canonical] = await getDb().select({ archivedAt: channels.archivedAt }).from(channels).where(eq(channels.id, fx.joint.canonical.id));
  assert.equal(canonical!.archivedAt, null, "archiving a joint archives its projections only");

  const sent = await sendText(app.baseUrl, fx.peerKey, `#${fx.name}`);
  assert.equal(sent.status, 409, JSON.stringify(sent.body));
  for (const [label, key, id] of [["Host", fx.hostKey, hostCard.id], ["Peer", fx.peerKey, peerCard.id]] as const) {
    const refused = await updateCard(app.baseUrl, key, id, body);
    assert.equal(refused.status, 409, `${label}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, sent.body.code, `${label}: refused as the send is`);
    assert.equal(refused.body.code, "channel_archived");
  }
  // Removed from the projection: the unknown message's answer, not why it can't change.
  await removeAgent(fx.peerProjection.id, fx.peerAgent.id);
  assertNotFound(await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body), unknown, "a removed sender in an archived joint");

  await unarchiveChannel(fx.hostProjection.id);
  assert.equal((await updateCard(app.baseUrl, fx.hostKey, hostCard.id, body)).status, 200);
  assert.equal((await revisionsOf(peerCard.id)).length, 1);
});

test("a joint over its free-server limit (frozen): 403 with the send's body; writable again once it is not", async ({ app }) => {
  const fx = await seedJointFixture();
  const peerCard = await seedStoredCard(fx.joint.canonical.id, fx.peerAgent.id);
  const body = { card: buildCard("Ready for testing") };
  await getDb().update(jointChannels).set({ overLimitSince: new Date(Date.now() - 60 * 24 * 60 * 60_000) })
    .where(eq(jointChannels.id, fx.joint.jointChannelId));

  const sent = await sendText(app.baseUrl, fx.peerKey, `#${fx.name}`);
  assert.equal(sent.status, 403, JSON.stringify(sent.body));
  const refused = await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.deepEqual(refused.body, sent.body, "the send's refusal");
  assert.deepEqual(refused.body, { error: JOINT_CHANNEL_READ_ONLY_ERROR, code: "channel_read_only", errorCode: "channel_read_only" });

  await getDb().update(jointChannels).set({ overLimitSince: null }).where(eq(jointChannels.id, fx.joint.jointChannelId));
  assert.equal((await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body)).status, 200);
});

test("a free Peer frozen out of its external channels: 403 external_limit_frozen as its send; Host's side keeps updating", async ({ app }) => {
  const fx = await seedJointFixture();
  // Peer free, in two joints (external channels), its freeze time passed.
  await setPlan(fx.peer.id, "free");
  await enableExternalChannelsFlag(fx.peer.id);
  const otherOwner = await seedHuman("other-host");
  const other = await serverWithCards("other", otherOwner.id);
  await setPlan(other.id, "founder");
  await seedJointChannel({ name: `other-${randomUUID().slice(0, 8)}`, serverIds: [other.id, fx.peer.id], createdByUserId: otherOwner.id });
  await getDb().insert(serverExternalFreezes).values({ serverId: fx.peer.id, freezeAt: new Date(Date.now() - 60_000) });
  const hostCard = await seedStoredCard(fx.joint.canonical.id, fx.hostAgent.id);
  const peerCard = await seedStoredCard(fx.joint.canonical.id, fx.peerAgent.id);
  const body = { card: buildCard("Ready for testing") };

  const sent = await sendText(app.baseUrl, fx.peerKey, `#${fx.name}`);
  assert.equal(sent.status, 403, JSON.stringify(sent.body));
  assert.equal(sent.body.code, "external_limit_frozen");
  const refused = await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.deepEqual(refused.body, sent.body, "the send's refusal");
  assert.equal((await updateCard(app.baseUrl, fx.hostKey, hostCard.id, body)).status, 200, "a paid side of the joint is not frozen");
  assert.equal((await revisionsOf(peerCard.id)).length, 1);
});

test("the channel quota's read-only is the sender's own projection's", async ({ app }) => {
  const fx = await seedJointFixture();
  const hostCard = await seedStoredCard(fx.joint.canonical.id, fx.hostAgent.id);
  const peerCard = await seedStoredCard(fx.joint.canonical.id, fx.peerAgent.id);
  // No plan caps channels today; the quota rule read-only for Peer's projection only.
  const quota = vi.spyOn(planService, "isChannelReadOnlyByQuota").mockImplementation(async (channelId) => channelId === fx.peerProjection.id);
  const refused = await updateCard(app.baseUrl, fx.peerKey, peerCard.id, { card: buildCard("Ready for testing") });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "channel_read_only");
  assert.ok(quota.mock.calls.some(([channelId, serverId]) => channelId === fx.peerProjection.id && serverId === fx.peer.id), "checked on Peer's projection, for Peer");
  assert.equal((await updateCard(app.baseUrl, fx.hostKey, hostCard.id, { card: buildCard("Ready for testing") })).status, 200);
  assert.equal((await revisionsOf(peerCard.id)).length, 1);
});

test("a sender removed after the route's checks: the write re-checks its joint posting authority under its locks and writes nothing", async ({ app }) => {
  const fx = await seedJointFixture();
  const peerCard = await seedStoredCard(fx.joint.canonical.id, fx.peerAgent.id);
  const unknown = await notFoundBody(app.baseUrl, fx.peerKey);
  // The last check before the write (the quota) is where the removal lands.
  vi.spyOn(planService, "isChannelReadOnlyByQuota").mockImplementation(async (channelId) => {
    if (channelId === fx.peerProjection.id) await removeAgent(fx.peerProjection.id, fx.peerAgent.id);
    return false;
  });
  assertNotFound(await updateCard(app.baseUrl, fx.peerKey, peerCard.id, { card: buildCard("Ready for testing") }), unknown, "removed between the checks and the write");
  assert.equal((await revisionsOf(peerCard.id)).length, 1, "nothing written");
  assert.equal((await messageRow(peerCard.id)).content, "Raft App 1.19.0 (11900001) · In review");

  // The write on its own: the authority is the projection it is given.
  vi.restoreAllMocks();
  await addAgent(fx.peerProjection.id, fx.peerAgent.id);
  const parsed = parseMessageCard(buildCard("Approved"));
  assert.ok(parsed.ok);
  const write = (jointPostingAuthorityChannelId: string) => applyMessageCardUpdate({
    messageId: peerCard.id, senderAgentId: fx.peerAgent.id, card: parsed.card, content: "Approved", jointPostingAuthorityChannelId,
  });
  assert.equal((await write(fx.hostProjection.id)).kind, "not_found", "another Server's projection grants Peer's agent nothing");
  assert.equal((await write(fx.peerProjection.id)).kind, "updated");
});

test("a joint thread's card: updated through the sender's own local thread, the archive and membership of its local parent", async ({ app }) => {
  const fx = await seedJointFixture();
  const root = await sendText(app.baseUrl, fx.hostKey, `#${fx.name}`);
  assert.equal(root.status, 200, JSON.stringify(root.body));
  // Peer's agent replies in the thread (text), which opens Peer's local thread.
  const reply = await sendText(app.baseUrl, fx.peerKey, `#${fx.name}:${(root.body.messageId as string).slice(0, 8)}`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const canonicalThreadId = (await messageRow(reply.body.messageId)).channelId;
  assert.notEqual(canonicalThreadId, fx.joint.canonical.id);
  const peerCard = await seedStoredCard(canonicalThreadId, fx.peerAgent.id);
  const body = { card: buildCard("Ready for testing") };
  const unknown = await notFoundBody(app.baseUrl, fx.peerKey);

  assert.equal((await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body)).status, 200);
  assertNotFound(await updateCard(app.baseUrl, fx.hostKey, peerCard.id, body), unknown, "Host's agent on Peer's thread card");
  await archiveChannel(fx.hostProjection.id, fx.hostOwner.id);
  const archived = await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body);
  assert.equal(archived.status, 409, JSON.stringify(archived.body));
  assert.equal(archived.body.code, "channel_archived");
  await unarchiveChannel(fx.hostProjection.id);
  await removeAgent(fx.peerProjection.id, fx.peerAgent.id);
  assertNotFound(await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body), unknown, "removed from the thread's local parent");
  assert.equal((await revisionsOf(peerCard.id)).length, 2);
});

test("a historical joint task's conversation, from the participant's side: 403 joint_task_read_only as a reply there", async ({ app }) => {
  const fx = await seedJointFixture();
  await enableTaskV2ConversationsForServer(fx.host.id);
  await enableTaskV2ConversationsForServer(fx.peer.id);
  const { tasks: [task] } = await taskService.createTasks(fx.joint.canonical.id, "user", fx.hostOwner.id, [{ title: "ship 1.19.0" }], { initiatingServerId: fx.host.id });
  // Peer's agent replies (text): the task's conversation, and Peer's local face of it.
  const replied = await call(app.baseUrl, fx.peerKey, "POST", "/tasks/reply", { channel: `#${fx.name}`, task_number: task!.taskNumber, content: "on it" });
  assert.equal(replied.status, 200, JSON.stringify(replied.body));
  const [stored] = await getDb().select({ conversationChannelId: tasks.conversationChannelId }).from(tasks).where(eq(tasks.id, task!.id));
  assert.ok(stored!.conversationChannelId);
  const peerCard = await seedStoredCard(stored!.conversationChannelId, fx.peerAgent.id);
  const body = { card: buildCard("Ready for testing") };
  assert.equal((await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body)).status, 200, "a task from after the conversion");

  // The channel became joint by a conversion after the task was created: historical on Peer's side.
  await getDb().insert(channelConversionJobs).values({
    serverId: fx.host.id,
    sourceChannelId: fx.hostProjection.id,
    sourceChannelType: "channel",
    status: "done",
    phase: "done", state: "succeeded",
    canonicalChannelId: fx.joint.canonical.id,
    jointChannelId: fx.joint.jointChannelId,
    createdByUserId: fx.hostOwner.id,
    createdAt: new Date(),
    completedAt: new Date(),
  });
  await getDb().update(tasks).set({ createdAt: new Date(Date.now() - 24 * 60 * 60_000) }).where(eq(tasks.id, task!.id));
  const sentRefused = await call(app.baseUrl, fx.peerKey, "POST", "/tasks/reply", { channel: `#${fx.name}`, task_number: task!.taskNumber, content: "again" });
  assert.equal(sentRefused.status, 403, JSON.stringify(sentRefused.body));
  const refused = await updateCard(app.baseUrl, fx.peerKey, peerCard.id, body);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, sentRefused.body.code);
  assert.equal(refused.body.code, "joint_task_read_only");
  assert.equal((await revisionsOf(peerCard.id)).length, 2);
});

// ---------------------------------------------------------------------------
// Revisions (§4.5): through the viewer's own Server's projection and window.

async function readRevisions(baseUrl: string, human: Human, serverId: string, messageId: string) {
  const res = await fetch(`${baseUrl}/api/messages/${messageId}/card-revisions`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(human.email)}`, "X-Server-Id": serverId },
  });
  return { status: res.status, body: await res.json() as any };
}

test("revisions of a joint card: a member on each Server reads them through their projection; anyone else gets the unknown message's 404", async ({ app }) => {
  const fx = await seedJointFixture();
  const peerCard = await seedStoredCard(fx.joint.canonical.id, fx.peerAgent.id);
  assert.equal((await updateCard(app.baseUrl, fx.peerKey, peerCard.id, { card: buildCard("Ready for testing") })).status, 200);

  for (const [human, serverId] of [[fx.hostOwner, fx.host.id], [fx.peerOwner, fx.peer.id]] as const) {
    const read = await readRevisions(app.baseUrl, human, serverId, peerCard.id);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.body.revisions.map((r: { revision: number }) => r.revision), [1, 2]);
  }
  // A Host member outside Host's projection, and Server C's owner.
  const hostMember = await seedHuman("host-member");
  await addMember(fx.host.id, hostMember.id);
  for (const [label, human, serverId] of [["Host member outside the joint", hostMember, fx.host.id], ["Server C's owner", fx.cOwner, fx.serverC.id]] as const) {
    const refused = await readRevisions(app.baseUrl, human, serverId, peerCard.id);
    const unknown = await readRevisions(app.baseUrl, human, serverId, UNKNOWN_ID);
    assert.equal(refused.status, 404, label);
    assert.deepEqual([refused.status, refused.body], [unknown.status, unknown.body], `${label}: the unknown message's answer`);
  }
  // Peer's side disconnected: Peer's owner no longer reads them.
  await getDb().update(jointChannelServers).set({ status: "disconnected", disconnectedAt: new Date() })
    .where(and(eq(jointChannelServers.jointChannelId, fx.joint.jointChannelId), eq(jointChannelServers.serverId, fx.peer.id)));
  assert.equal((await readRevisions(app.baseUrl, fx.peerOwner, fx.peer.id, peerCard.id)).status, 404);
});

test("revisions of a joint card outside the viewer's history window: each Server's own plan decides", async ({ app }) => {
  const fx = await seedJointFixture();
  const card = await seedStoredCard(fx.joint.canonical.id, fx.hostAgent.id);
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${card.id}::uuid`);
  await setPlan(fx.host.id, "free");
  await setPlan(fx.peer.id, "founder");
  assert.equal((await readRevisions(app.baseUrl, fx.hostOwner, fx.host.id, card.id)).status, 404, "behind Host's 30-day window");
  const fromPeer = await readRevisions(app.baseUrl, fx.peerOwner, fx.peer.id, card.id);
  assert.equal(fromPeer.status, 200, "Peer keeps the whole history");
  assert.deepEqual(fromPeer.body.revisions.map((r: { revision: number }) => r.revision), [1]);
  await setPlan(fx.host.id, "founder");
  await setPlan(fx.peer.id, "free");
  assert.equal((await readRevisions(app.baseUrl, fx.hostOwner, fx.host.id, card.id)).status, 200);
  assert.equal((await readRevisions(app.baseUrl, fx.peerOwner, fx.peer.id, card.id)).status, 404, "behind Peer's window now");
  // An ordinary channel's card on a free Server: the same window.
  const room = await createChannel(fx.host.id, `room-${randomUUID().slice(0, 6)}`);
  await addHuman(room.id, fx.hostOwner.id);
  const local = await seedStoredCard(room.id, fx.hostAgent.id);
  await setPlan(fx.host.id, "free");
  assert.equal((await readRevisions(app.baseUrl, fx.hostOwner, fx.host.id, local.id)).status, 200);
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${local.id}::uuid`);
  assert.equal((await readRevisions(app.baseUrl, fx.hostOwner, fx.host.id, local.id)).status, 404);
});

// ---------------------------------------------------------------------------
// Sending a card in a joint (v1.8): through the sender's own projection,
// stored once, behind the sender's Server's flag only.

async function humanMessages(baseUrl: string, human: Human, serverId: string, channelId: string) {
  const res = await fetch(`${baseUrl}/api/messages/channel/${channelId}?limit=50`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(human.email)}`, "X-Server-Id": serverId },
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json() as { messages: Array<{ id: string; content: string; actionMetadata?: { kind?: string; revision?: number } }> }).messages;
}

async function agentHistory(baseUrl: string, apiKey: string, target: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(target)}&consume=false`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json() as { messages: Array<{ id: string; message_card?: { revision: number } }> }).messages;
}

async function cardMessagesIn(channelId: string) {
  return (await getDb().select().from(messages).where(eq(messages.channelId, channelId)))
    .filter((row) => (row.actionMetadata as { kind?: string } | null)?.kind === "message-card");
}

test("a card sent in a joint by an agent of each Server: stored once in canonical storage (revision 1, the receipt says so), on every Server's projection, then updated by its sender", async ({ app }) => {
  const fx = await seedJointFixture();
  const { emits, io } = recordingIo();
  app.app.set("io", io);
  const fromHost = await sendCard(app.baseUrl, fx.hostKey, `#${fx.name}`, "In review");
  const peerBody = { idempotencyKey: "joint-peer-11900001" };
  const fromPeer = await sendCard(app.baseUrl, fx.peerKey, `#${fx.name}`, "Testing", peerBody);
  for (const [label, sent, agentId] of [["Host", fromHost, fx.hostAgent.id], ["Peer", fromPeer, fx.peerAgent.id]] as const) {
    assert.equal(sent.status, 200, `${label}: ${JSON.stringify(sent.body)}`);
    assert.equal(sent.body.state, "sent");
    assert.deepEqual(sent.body.messageCard, { revision: 1 }, `${label}: the receipt says a card was stored`);
    const row = await messageRow(sent.body.messageId);
    assert.equal(row.channelId, fx.joint.canonical.id, `${label}: stored once, in canonical storage`);
    assert.equal((row.actionMetadata as { kind: string; revision: number }).kind, "message-card");
    assert.deepEqual((await revisionsOf(row.id)).map((r) => [r.revision, r.senderAgentId]), [[1, agentId]]);
    // message:new, with the card, reaches every Server's projection.
    for (const projection of [fx.hostProjection, fx.peerProjection]) {
      assert.ok(emits.some((emit) => emit.event === "message:new" && emit.room === `channel:${projection.id}`
        && emit.payload.id === row.id && emit.payload.actionMetadata?.kind === "message-card"), `${label}: message:new with its card on ${projection.id}`);
    }
  }
  for (const projection of [fx.hostProjection, fx.peerProjection]) {
    assert.deepEqual(await cardMessagesIn(projection.id), [], "no copy on a projection");
  }

  // Each Server's members read both cards through their own projection; agents read card=r1.
  for (const [label, human, serverId, projection, key] of [
    ["Host", fx.hostOwner, fx.host.id, fx.hostProjection, fx.hostKey],
    ["Peer", fx.peerOwner, fx.peer.id, fx.peerProjection, fx.peerKey],
  ] as const) {
    const read = await humanMessages(app.baseUrl, human, serverId, projection.id);
    const agentRead = await agentHistory(app.baseUrl, key, `#${fx.name}`);
    for (const sent of [fromHost, fromPeer]) {
      const message = read.find((candidate) => candidate.id === sent.body.messageId);
      assert.deepEqual([message?.actionMetadata?.kind, message?.actionMetadata?.revision], ["message-card", 1], `${label}'s owner reads ${sent.body.messageId}`);
      assert.equal(agentRead.find((candidate) => candidate.id === sent.body.messageId)?.message_card?.revision, 1, `${label}'s agent reads ${sent.body.messageId}`);
    }
  }

  // The same key answers the first send again (#12806): one message, one revision.
  const again = await sendCard(app.baseUrl, fx.peerKey, `#${fx.name}`, "Testing", peerBody);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.messageId, fromPeer.body.messageId);
  assert.deepEqual(again.body.messageCard, { revision: 1 });
  assert.equal((await cardMessagesIn(fx.joint.canonical.id)).length, 2);

  // Then each sender updates its own through its projection (and only its own).
  const unknown = await notFoundBody(app.baseUrl, fx.hostKey);
  assertNotFound(await updateCard(app.baseUrl, fx.hostKey, fromPeer.body.messageId, { card: buildCard("x") }), unknown, "Host's agent on Peer's card");
  for (const [label, key, sent] of [["Host", fx.hostKey, fromHost], ["Peer", fx.peerKey, fromPeer]] as const) {
    const updated = await updateCard(app.baseUrl, key, sent.body.messageId, { card: buildCard("Ready for testing"), expectedRevision: 1 });
    assert.equal(updated.status, 200, `${label}: ${JSON.stringify(updated.body)}`);
    assert.equal(updated.body.revision, 2);
  }
  const peerRead = (await humanMessages(app.baseUrl, fx.peerOwner, fx.peer.id, fx.peerProjection.id)).find((m) => m.id === fromHost.body.messageId);
  assert.equal(peerRead?.actionMetadata?.revision, 2, "Host's update reads on Peer's side");
  assert.equal(peerRead?.content, fallbackOf("Ready for testing"));
});

test("a card in a joint thread, from either side: stored once in the canonical thread, updated through the sender's own local thread", async ({ app }) => {
  const fx = await seedJointFixture();
  const root = await sendText(app.baseUrl, fx.hostKey, `#${fx.name}`);
  assert.equal(root.status, 200, JSON.stringify(root.body));
  const thread = `#${fx.name}:${(root.body.messageId as string).slice(0, 8)}`;
  // Peer's agent first: its reply opens Peer's local face of the thread.
  const fromPeer = await sendCard(app.baseUrl, fx.peerKey, thread, "In review");
  const fromHost = await sendCard(app.baseUrl, fx.hostKey, thread, "Testing");
  for (const [label, sent] of [["Peer", fromPeer], ["Host", fromHost]] as const) {
    assert.equal(sent.status, 200, `${label}: ${JSON.stringify(sent.body)}`);
    assert.deepEqual(sent.body.messageCard, { revision: 1 }, label);
  }
  const canonicalThreadId = (await messageRow(fromPeer.body.messageId)).channelId;
  assert.notEqual(canonicalThreadId, fx.joint.canonical.id, "in the thread, not the channel");
  assert.equal((await messageRow(fromHost.body.messageId)).channelId, canonicalThreadId, "one thread for both sides");
  const [threadRow] = await getDb().select().from(channels).where(eq(channels.id, canonicalThreadId));
  assert.equal(threadRow!.serverId, fx.joint.canonical.serverId, "the canonical thread, in joint storage");
  assert.equal(threadRow!.parentMessageId, root.body.messageId);

  const unknown = await notFoundBody(app.baseUrl, fx.peerKey);
  assertNotFound(await updateCard(app.baseUrl, fx.peerKey, fromHost.body.messageId, { card: buildCard("x") }), unknown, "Peer's agent on Host's thread card");
  for (const [label, key, sent] of [["Peer", fx.peerKey, fromPeer], ["Host", fx.hostKey, fromHost]] as const) {
    const updated = await updateCard(app.baseUrl, key, sent.body.messageId, { card: buildCard("Ready for testing") });
    assert.equal(updated.status, 200, `${label}: ${JSON.stringify(updated.body)}`);
    assert.equal(updated.body.revision, 2);
  }
});

test("an agent of a Server outside the joint can't send a card there, as it can't send text", async ({ app }) => {
  const fx = await seedJointFixture();
  const root = await sendText(app.baseUrl, fx.hostKey, `#${fx.name}`);
  for (const target of [`#${fx.name}`, `#${fx.name}:${(root.body.messageId as string).slice(0, 8)}`]) {
    const text = await sendText(app.baseUrl, fx.cKey, target);
    const card = await sendCard(app.baseUrl, fx.cKey, target, "In review");
    assert.notEqual(text.status, 200, `${target}: text ${JSON.stringify(text.body)}`);
    assert.deepEqual([card.status, card.body], [text.status, text.body], `${target}: the card gets the text's answer`);
  }
  assert.deepEqual(await cardMessagesIn(fx.joint.canonical.id), []);
});

// ---------------------------------------------------------------------------
// A card message moved into a joint by a conversion of its channel.

test("a card sent in an ordinary channel, then the channel converted to joint: its sender still updates it, and its revisions still read", async ({ app }) => {
  const owner = await seedHuman("convert-owner");
  const server = await serverWithCards("convert", owner.id);
  const agent = await createAgent(server.id, "HandsBot", { runtime: "claude", model: "sonnet" });
  await setPlan(server.id, "founder");
  const room = await createChannel(server.id, `release-${randomUUID().slice(0, 8)}`);
  await addHuman(room.id, owner.id);
  await addAgent(room.id, agent.id);
  const key = await credentialFor(agent.id);
  const sent = await call(app.baseUrl, key, "POST", "/v2/send", { target: `#${room.name}`, card: buildCard("In review") });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const messageId = sent.body.messageId as string;
  assert.equal((await updateCard(app.baseUrl, key, messageId, { card: buildCard("Testing") })).status, 200, "before the conversion");

  const job = await startChannelToJointConversion({ serverId: server.id, sourceChannelId: room.id, createdByUserId: owner.id });
  await runChannelConversionJob(job.id);
  const [converted] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, room.id));
  assert.equal(converted!.type, "joint", "the channel is now the host's projection");
  const moved = await messageRow(messageId);
  assert.notEqual(moved.channelId, room.id, "the card moved to canonical storage");

  const updated = await updateCard(app.baseUrl, key, messageId, { card: buildCard("Ready for testing") });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.revision, 3);
  assert.equal((await messageRow(messageId)).content, fallbackOf("Ready for testing"));
  const read = await readRevisions(app.baseUrl, owner, server.id, messageId);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.revisions.map((r: { revision: number }) => r.revision), [1, 2, 3]);
  // Still the sender's only.
  const reviewer = await createAgent(server.id, "Reviewer", { runtime: "claude", model: "sonnet" });
  await addAgent(room.id, reviewer.id);
  const refused = await updateCard(app.baseUrl, await credentialFor(reviewer.id), messageId, { card: buildCard("x") });
  assert.equal(refused.status, 404);
});

test("its channel converted to joint between the route's checks and the write: nothing written, the unknown message's 404; the retry updates it through the projection", async ({ app }) => {
  const owner = await seedHuman("race-owner");
  const server = await serverWithCards("race", owner.id);
  const agent = await createAgent(server.id, "HandsBot", { runtime: "claude", model: "sonnet" });
  await setPlan(server.id, "founder");
  const room = await createChannel(server.id, `race-${randomUUID().slice(0, 8)}`);
  await addHuman(room.id, owner.id);
  await addAgent(room.id, agent.id);
  const key = await credentialFor(agent.id);
  const sent = await call(app.baseUrl, key, "POST", "/v2/send", { target: `#${room.name}`, card: buildCard("In review") });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const messageId = sent.body.messageId as string;
  const unknown = await notFoundBody(app.baseUrl, key);

  // The last check before the write (the quota) is where the conversion lands:
  // the route resolved an ordinary channel (no joint authority to lock).
  let converted = false;
  vi.spyOn(planService, "isChannelReadOnlyByQuota").mockImplementation(async () => {
    if (!converted) {
      converted = true;
      const job = await startChannelToJointConversion({ serverId: server.id, sourceChannelId: room.id, createdByUserId: owner.id });
      await runChannelConversionJob(job.id);
    }
    return false;
  });
  const raced = await updateCard(app.baseUrl, key, messageId, { card: buildCard("Ready for testing") });
  assert.ok(converted, "the conversion ran between the checks and the write");
  assertNotFound(raced, unknown, "moved under the update");
  assert.notEqual((await messageRow(messageId)).channelId, room.id, "the conversion moved it to canonical storage");
  assert.equal((await revisionsOf(messageId)).length, 1, "nothing written");
  assert.equal((await messageRow(messageId)).content, fallbackOf("In review"));

  vi.restoreAllMocks();
  const retried = await updateCard(app.baseUrl, key, messageId, { card: buildCard("Ready for testing") });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.revision, 2, "the retry resolves it through the host's projection");
});

// ---------------------------------------------------------------------------
// A Slack-bridged joint (the bridge is on the host's projection only): a card
// sent through the host's projection is mirrored and its updates edit that
// Slack message; one sent through a participant's is not bridged, as its text
// is not.

test("a Slack-bridged joint: the host side's card is delivered and its update edits the Slack copy; the participant side's card, like its text, never reaches Slack", async ({ app, db }) => {
  const pair = await seedJointSlackCardEditPair(db);
  const hostKey = await credentialFor(pair.agent.id);
  const otherKey = await credentialFor(pair.joint.otherAgent.id);
  const target = `#${pair.channel.name}`;
  // The real outbound admission (which pair, which side), no delivery worker.
  const runtime = createSlackBridgeDatabaseOutboundRuntime({
    db, provider: {} as unknown as SlackBridgeProviderRuntime, reconciliationKey: "joint-card-send-test",
    registrationId: pair.registration.id, workerIntervalMs: 60_000,
    async runWorkerOnce() { return { kind: "empty" }; },
  });
  runtime.start();
  let sent: Awaited<ReturnType<typeof call>>;
  let otherCard: Awaited<ReturnType<typeof call>>;
  let otherText: Awaited<ReturnType<typeof call>>;
  try {
    sent = await sendCard(app.baseUrl, hostKey, target, "In review");
    otherCard = await sendCard(app.baseUrl, otherKey, target, "In review");
    otherText = await sendText(app.baseUrl, otherKey, target);
  } finally {
    await runtime.stop();
  }
  for (const [label, answer] of [["host card", sent], ["participant card", otherCard], ["participant text", otherText]] as const) {
    assert.equal(answer.status, 200, `${label}: ${JSON.stringify(answer.body)}`);
  }
  assert.deepEqual(sent.body.messageCard, { revision: 1 });
  assert.deepEqual(otherCard.body.messageCard, { revision: 1 });
  const message = await messageRow(sent.body.messageId);
  assert.equal(message.channelId, pair.joint.canonical.id, "stored in canonical storage, not on the bridged projection");
  const deliveriesOf = (messageId: string) => db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.sourceMessageId, messageId));
  const [delivery, ...more] = await deliveriesOf(message.id);
  assert.ok(delivery, "the host side's card is queued for Slack");
  assert.equal(more.length, 0);
  assert.equal(delivery.bindingId, pair.binding.id);
  const snapshot = delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  assert.equal(snapshot.sanitizedText, fallbackOf("In review"), "the card's first fallback, text only");
  assert.equal(snapshot.canonicalConversationId, pair.joint.canonical.id);
  assert.equal(snapshot.bindingAuthority.raftChannelId, pair.channel.id, "under the host projection's binding");
  for (const id of [otherCard.body.messageId, otherText.body.messageId]) {
    assert.deepEqual(await deliveriesOf(id), [], "the participant's side is not bridged");
  }

  // Slack accepts the original; then each sender updates its card.
  await confirmOriginal(db, { delivery, install: pair.install, binding: pair.binding, message });
  const updated = await updateCard(app.baseUrl, hostKey, message.id, { card: buildCard("Ready for testing"), expectedRevision: 1 });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.revision, 2);
  const otherUpdated = await updateCard(app.baseUrl, otherKey, otherCard.body.messageId, { card: buildCard("Ready for testing") });
  assert.equal(otherUpdated.status, 200, JSON.stringify(otherUpdated.body));
  assert.deepEqual(await db.select().from(externalCardEditSyncs).where(eq(externalCardEditSyncs.sourceMessageId, otherCard.body.messageId)), [],
    "no Slack copy, no edit to sync");

  // The card edit worker edits the host side's Slack copy, once.
  const requests: SlackWebApiRequest[] = [];
  const result = await processSlackCardEditSyncOnce({
    db, leaseOwner: "joint-card-send-test",
    dependencies: {
      registrationId: pair.registration.id,
      transport: {
        evidence: "double",
        async call(request: SlackWebApiRequest) {
          requests.push(structuredClone(request));
          assert.equal(request.method, "chat.update", "only an edit");
          return { kind: "response", status: 200, headers: {}, body: { ok: true, channel: CONVERSATION, ts: String(request.body.ts) },
            observedAuthority: { providerAppId: pair.install.providerAppId, providerAuthorityId: pair.install.providerAuthorityId } };
        },
      },
      async leaseCredential({ fence, now }) {
        return {
          schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA, leaseId: randomUUID(), installId: fence.installId,
          providerAppId: fence.providerAppId, providerAuthorityId: fence.providerAuthorityId,
          connectionEpoch: fence.connectionEpoch, credentialRevision: fence.credentialRevision,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
        };
      },
      async releaseCredential() {},
      now: () => new Date(),
    },
  });
  assert.equal(result.kind === "attempted" ? result.outcome : JSON.stringify(result), "succeeded");
  assert.deepEqual(requests.map((request) => [request.method, request.body.channel, request.body.ts]), [["chat.update", CONVERSATION, TS]]);
  assert.equal(requests[0]!.body.text, fallbackOf("Ready for testing"));
  assert.equal((requests[0]!.body.metadata as { event_payload: { card_revision: number } }).event_payload.card_revision, 2);
  const [state] = await readSlackCardEditSyncState(db, message.id);
  assert.equal(state!.status.summary, "confirmed");
});
