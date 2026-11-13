import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { insertAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { getDb } from "../db/index";
import { attachmentObjects, attachments, featureFlags, messages, serverMembers, servers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { prepareActionCard } from "../services/actionCardsService";
import { seedJointChannel } from "../test/integration/jointFixture";
import { asServerId } from "@botiverse/raft-shared";

const test = createApiTest();

// Acting on one message by id, on a Free server, when the message is older
// than the plan's 30-day window (services/historyWindow.ts; cindyz,
// #proj-commercial task #8: one rule for every read, no exceptions). Each
// path checks after its access check, so nothing is said about a message the
// caller may not read.

const HUMAN = "This message is older than the 30-day history on the Free plan.";
const AGENT = "This message is older than the 30-day history on the Free plan. Upgrading to Pro restores the full history.";
const AGENT_FILE = "This file is in a message older than the 30-day history on the Free plan. Upgrading to Pro restores the full history.";

async function seedFixture() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `history-by-id-${suffix}@slock.test`,
    name: `history-by-id-${suffix}`,
    displayName: "By Id Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("History By Id", `history-by-id-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `ByIdBot${suffix}`, { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, `by-id-${suffix}`);
  const destination = await createChannel(server.id, `by-id-dest-${suffix}`);
  for (const id of [channel.id, destination.id]) {
    await addHuman(id, owner!.id);
    await addAgent(id, agent.id);
  }
  const old = await createMessage(channel.id, "user", owner!.id, "an old decision", "chat");
  const recent = await createMessage(channel.id, "user", owner!.id, "a recent decision", "chat");
  await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${old.id}::uuid`);
  const fileOf = async (messageId: string, name: string) => (await insertAttachmentsWithObjects(db, {
    messageId,
    channelId: channel.id,
    uploaderId: owner!.id,
    uploaderType: "user",
    filename: name,
    mimeType: "text/plain",
    sizeBytes: 4,
    storageKey: `${server.id}/${name}`,
  }))[0]!;
  const oldFile = await fileOf(old.id, "old.txt");
  const recentFile = await fileOf(recent.id, "recent.txt");
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks", "reactions"],
    name: `by-id-${suffix}`,
    issuedVia: "computer",
    createdByUserId: null,
  });
  // A member who can't read the private channel: never told an old message there exists.
  const [outsider] = await db.insert(users).values({
    email: `history-by-id-outsider-${suffix}@slock.test`,
    name: `history-by-id-outsider-${suffix}`,
    displayName: "By Id Outsider",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: outsider!.id, role: "member" }).onConflictDoNothing();
  const secret = await createChannel(server.id, `by-id-secret-${suffix}`, undefined, "private");
  await addHuman(secret.id, owner!.id);
  await addAgent(secret.id, agent.id);
  const secretOld = await createMessage(secret.id, "user", owner!.id, "an old private decision", "chat");
  await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${secretOld.id}::uuid`);
  return {
    server, owner: owner!, agent, channel, destination, old, recent, oldFile, recentFile, apiKey, secret, secretOld,
    token: await tokenForHuman(owner!.email),
    outsiderToken: await tokenForHuman(outsider!.email),
  };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

function human(baseUrl: string, fx: Fixture, path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${init.token ?? fx.token}`, "X-Server-Id": fx.server.id, "Content-Type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function agentCall(baseUrl: string, fx: Fixture, path: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}/internal/agent-api${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${fx.apiKey}`, "Content-Type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

test("a person's by-id actions on a message behind the window answer history_limited; inside it they work", async ({ app }) => {
  const fx = await seedFixture();
  const base = app.baseUrl;

  const oldReaction = await human(base, fx, `/api/messages/${fx.old.id}/reactions`, { method: "POST", body: { emoji: "👍" } });
  assert.equal(oldReaction.status, 404);
  assert.deepEqual(await oldReaction.json(), { error: HUMAN, code: "history_limited" });
  assert.equal((await human(base, fx, `/api/messages/${fx.recent.id}/reactions`, { method: "POST", body: { emoji: "👍" } })).status, 200);

  assert.equal((await human(base, fx, `/api/attachments/${fx.oldFile.id}/comments`)).status, 404, "a file in an old message is behind the window too");
  assert.equal((await human(base, fx, `/api/attachments/${fx.recentFile.id}/comments`)).status, 200);

  const convert = await human(base, fx, "/api/tasks/convert-message", { method: "POST", body: { messageId: fx.old.id } });
  assert.equal(convert.status, 404);
  assert.equal(((await convert.json()) as { code?: string }).code, "history_limited");

  await getDb().insert(featureFlags)
    .values({ key: "message_forwarding_v0", randomizationUnit: "server", salt: "test", defaultEnabled: true, enabled: true })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true, defaultEnabled: true, killSwitch: false } });
  const forward = await human(base, fx, "/api/messages/forward", {
    method: "POST",
    body: { destinationChannelId: fx.destination.id, sourceMessageIds: [fx.old.id], note: "" },
  });
  assert.equal(forward.status, 404, await forward.clone().text());
  assert.equal(((await forward.json()) as { code?: string }).code, "history_limited");

  // Pro keeps everything.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  assert.equal((await human(base, fx, `/api/messages/${fx.old.id}/reactions`, { method: "POST", body: { emoji: "👍" } })).status, 200);
  assert.equal((await human(base, fx, `/api/attachments/${fx.oldFile.id}/comments`)).status, 200);
});

test("an agent's by-id actions on a message behind the window answer HISTORY_LIMITED", async ({ app }) => {
  const fx = await seedFixture();
  const base = app.baseUrl;

  const reaction = await agentCall(base, fx, `/messages/${fx.old.id}/reactions`, { method: "POST", body: { emoji: "👍" } });
  assert.equal(reaction.status, 404);
  const reactionBody = await reaction.json() as { errorCode?: string; error?: string };
  assert.equal(reactionBody.errorCode, "HISTORY_LIMITED");
  assert.equal(reactionBody.error, AGENT);
  assert.equal((await agentCall(base, fx, `/messages/${fx.recent.id}/reactions`, { method: "POST", body: { emoji: "👍" } })).status, 200);

  const comments = await agentCall(base, fx, `/attachments/${fx.oldFile.id}/comments`);
  assert.equal(comments.status, 404);
  const commentsBody = await comments.json() as { errorCode?: string; error?: string };
  assert.equal(commentsBody.errorCode, "HISTORY_LIMITED");
  assert.equal(commentsBody.error, AGENT_FILE);
  assert.equal((await agentCall(base, fx, `/attachments/${fx.recentFile.id}/comments`)).status, 200);

  const download = await agentCall(base, fx, `/attachments/${fx.oldFile.id}`);
  assert.equal(download.status, 404);
  assert.equal(((await download.json()) as { errorCode?: string }).errorCode, "HISTORY_LIMITED");

  const convert = await agentCall(base, fx, "/tasks/convert", { method: "POST", body: { channel: `#${fx.channel.name}`, message_id: fx.old.id } });
  assert.equal(convert.status, 404, await convert.clone().text());
  assert.equal(((await convert.json()) as { errorCode?: string }).errorCode, "HISTORY_LIMITED");
});

test("someone who can't read the channel is never told an old message there exists", async ({ app }) => {
  const fx = await seedFixture();
  const base = app.baseUrl;
  const reaction = await human(base, fx, `/api/messages/${fx.secretOld.id}/reactions`, { method: "POST", body: { emoji: "👍" }, token: fx.outsiderToken });
  assert.equal(reaction.status, 404);
  const body = await reaction.json() as { code?: string; error?: string };
  assert.equal(body.code, undefined, "a plain not found, as for a message that isn't there");

  // An action card behind the window: its member is told why, the outsider is not.
  const card = await prepareActionCard({
    serverId: asServerId(fx.server.id),
    requesterAgentId: fx.agent.id,
    targetChannelId: fx.secret.id,
    action: { type: "channel:create", name: `history-card-${randomUUID().slice(0, 6)}`, visibility: "public" },
  });
  await getDb().update(messages).set({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) }).where(eq(messages.id, card.messageId));
  const memberExecute = await human(base, fx, `/api/actions/${card.messageId}/execute`, { method: "POST", body: { expectedState: "prepared" } });
  assert.equal(memberExecute.status, 404);
  assert.equal(((await memberExecute.json()) as { code?: string }).code, "history_limited");
  const outsiderExecute = await human(base, fx, `/api/actions/${card.messageId}/execute`, { method: "POST", body: { expectedState: "prepared" }, token: fx.outsiderToken });
  assert.equal(outsiderExecute.status, 404);
  assert.notEqual(((await outsiderExecute.json()) as { code?: string }).code, "history_limited");
});

test("a forward with one source behind the window posts nothing", async ({ app }) => {
  const fx = await seedFixture();
  const base = app.baseUrl;
  await getDb().insert(featureFlags)
    .values({ key: "message_forwarding_v0", randomizationUnit: "server", salt: "test", defaultEnabled: true, enabled: true })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true, defaultEnabled: true, killSwitch: false } });
  const forward = await human(base, fx, "/api/messages/forward", {
    method: "POST",
    body: { destinationChannelId: fx.destination.id, sourceMessageIds: [fx.recent.id, fx.old.id], note: "" },
  });
  assert.equal(forward.status, 404);
  assert.equal(((await forward.json()) as { code?: string }).code, "history_limited");
  const posted = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, fx.destination.id));
  assert.deepEqual(posted, [], "nothing reaches the destination");
});

test("a file in a forward inside the window still opens when its source is behind it", async ({ app }) => {
  const fx = await seedFixture();
  const base = app.baseUrl;
  const db = getDb();
  // A bound file (a projection of a stored object), which a forward projects
  // again, bound to the forward itself.
  const source = await createMessage(fx.channel.id, "user", fx.owner.id, "a screenshot", "chat");
  const [object] = await db.insert(attachmentObjects).values({
    originServerId: fx.server.id,
    uploaderId: fx.owner.id,
    uploaderType: "user",
    mimeType: "image/png",
    sizeBytes: 4,
    storageKey: `${fx.server.id}/forwarded.png`,
  }).returning();
  const [sourceFile] = await db.insert(attachments).values({
    objectId: object!.id,
    messageId: source.id,
    channelId: fx.channel.id,
    uploaderId: fx.owner.id,
    uploaderType: "user",
    filename: "forwarded.png",
  }).returning();
  await db.insert(featureFlags)
    .values({ key: "message_forwarding_v0", randomizationUnit: "server", salt: "test", defaultEnabled: true, enabled: true })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true, defaultEnabled: true, killSwitch: false } });
  const forward = await human(base, fx, "/api/messages/forward", {
    method: "POST",
    body: { destinationChannelId: fx.destination.id, sourceMessageIds: [source.id], note: "" },
  });
  assert.equal(forward.status, 200, await forward.clone().text());
  const forwarded = await forward.json() as { id: string; actionMetadata: { forwardedItems: Array<{ attachmentSnapshots: Array<{ id: string }> }> } };
  const copyId = forwarded.actionMetadata.forwardedItems[0]!.attachmentSnapshots[0]!.id;

  // Forwarded 10 days ago, from a message now 40 days old.
  await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${source.id}::uuid`);
  await db.execute(sql`UPDATE messages SET created_at = now() - interval '10 days' WHERE id = ${forwarded.id}::uuid`);

  const copyUrl = await human(base, fx, `/api/attachments/${copyId}/url`);
  assert.equal(copyUrl.status, 200, `the forward's image opens: ${await copyUrl.clone().text()}`);
  assert.equal((await human(base, fx, `/api/attachments/${copyId}/comments`)).status, 200);
  assert.equal((await agentCall(base, fx, `/attachments/${copyId}/comments`)).status, 200, "for an agent too");
  assert.equal((await human(base, fx, `/api/attachments/${sourceFile!.id}/url`)).status, 404, "the source's own file is behind the window");
  // A bound file's window check reads the time its authority context read.
  const agentSource = await agentCall(base, fx, `/attachments/${sourceFile!.id}/comments`);
  assert.equal(agentSource.status, 404);
  assert.equal(((await agentSource.json()) as { errorCode?: string }).errorCode, "HISTORY_LIMITED");
});

test("an agent can't turn a message behind the window into a task by claiming it", async ({ app }) => {
  const fx = await seedFixture();
  const base = app.baseUrl;
  const claim = await agentCall(base, fx, "/tasks/claim", { method: "POST", body: { channel: `#${fx.channel.name}`, message_ids: [fx.old.id, fx.recent.id] } });
  assert.equal(claim.status, 200, await claim.clone().text());
  const results = ((await claim.json()) as { results: Array<{ messageId: string; success: boolean; reason?: string }> }).results;
  const byId = new Map(results.map((result) => [result.messageId, result]));
  assert.equal(byId.get(fx.old.id)?.success, false);
  assert.equal(byId.get(fx.old.id)?.reason, AGENT);
  assert.equal(byId.get(fx.recent.id)?.success, true, "a recent message still converts");
});

test("in a Joint Channel the reading server's plan decides", async ({ app }) => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `history-by-id-joint-${suffix}@slock.test`,
    name: `history-by-id-joint-${suffix}`,
    displayName: "Joint Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const freeServer = await createServer("By Id Joint Free", `by-id-joint-free-${suffix}`, owner!.id);
  const proServer = await createServer("By Id Joint Pro", `by-id-joint-pro-${suffix}`, owner!.id);
  const joint = await seedJointChannel({ name: `by-id-joint-${suffix}`, serverIds: [freeServer.id, proServer.id], createdByUserId: owner!.id });
  for (const projection of joint.projections) await addHuman(projection.id, owner!.id);
  const old = await createMessage(joint.canonical.id, "user", owner!.id, "an old joint message", "chat");
  await db.execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${old.id}::uuid`);
  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, freeServer.id));
  await db.update(servers).set({ plan: "pro" }).where(eq(servers.id, proServer.id));
  const token = await tokenForHuman(owner!.email);
  const react = (serverId: string) => fetch(`${app.baseUrl}/api/messages/${old.id}/reactions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" },
    body: JSON.stringify({ emoji: "👍" }),
  });
  const fromFree = await react(freeServer.id);
  assert.equal(fromFree.status, 404);
  assert.equal(((await fromFree.json()) as { code?: string }).code, "history_limited");
  assert.equal((await react(proServer.id)).status, 200, "the Pro server keeps the whole history");
});
