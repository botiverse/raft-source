import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { AGENT_LOUNGE_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentLounges, channelAgents, channelHumans, featureFlagRules, featureFlags, messageMentions, serverMembers, threadFollows, users } from "../db/schema";
import { createAgent, deleteAgent } from "../services/agentService";
import { openOrCreateAgentLounge } from "../services/agentLoungeService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createChannel, findOrCreateUserDM, getOrCreateThread, listChannelsForAgent, updateChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import { seedBoundGuest } from "../test/guestFixture";

// Agent Lounge v0 (#proj-chat:#15): one public channel per agent where every
// non-guest human of the Server talks with that agent. Other agents may read it
// but never take part, are never notified there, and are not shown it in their
// channel list; Guests cannot see it.
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
  return user!;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function enableLoungeFlag(serverId: string) {
  await getDb().insert(featureFlags)
    .values({ key: AGENT_LOUNGE_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: AGENT_LOUNGE_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

/** A Server with an owner, a member, a Guest, the lounge's agent and another agent (server admin role). */
async function seedWorld(baseUrl: string, options: { flag?: boolean } = {}) {
  const tag = randomUUID().slice(0, 8);
  const owner = await seedUser(`lounge-owner-${tag}`);
  const member = await seedUser(`lounge-member-${tag}`);
  const guest = await seedUser(`lounge-guest-${tag}`);
  const server = await createServer("Lounge", `lounge-${tag}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const room = await createChannel(server.id, `lounge-room-${tag}`, undefined, "channel", { type: "user", id: owner.id });
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: room.id });
  const host = await createAgent(server.id, `host${tag}`, { runtime: "codex" });
  const other = await createAgent(server.id, `other${tag}`, { runtime: "codex" });
  const otherKey = (await mintAgentCredential({ agentId: other.id, scopes: ["channels", "read", "send"], name: "other", issuedVia: "human", createdByUserId: owner.id })).apiKey;
  const hostKey = (await mintAgentCredential({ agentId: host.id, scopes: ["channels", "read", "send"], name: "host", issuedVia: "human", createdByUserId: owner.id })).apiKey;
  if (options.flag !== false) await enableLoungeFlag(server.id);
  const tokens = {
    owner: await login(baseUrl, owner.email),
    member: await login(baseUrl, member.email),
    guest: await login(baseUrl, guest.email),
  };
  const human = (as: keyof typeof tokens, method: string, path: string, body?: unknown) => fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokens[as]}`, "Content-Type": "application/json", "X-Server-Id": server.id },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const agentApi = (key: string, method: string, path: string, body?: unknown) => fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { tag, owner, member, guest, server, room, host, other, otherKey, hostKey, human, agentApi };
}

type World = Awaited<ReturnType<typeof seedWorld>>;

/** A database error from the guard triggers (Drizzle wraps it; the message is on the cause). */
function guardError(pattern: RegExp) {
  return (error: unknown) => {
    const cause = (error as { cause?: { message?: string } }).cause;
    assert.match(String(cause?.message ?? error), pattern);
    return true;
  };
}

async function openLounge(world: World, as: "owner" | "member" = "member") {
  const response = await world.human(as, "POST", `/agents/${world.host.id}/lounge`);
  assert.ok(response.status === 200 || response.status === 201, `open: ${response.status}`);
  return (await response.json()) as { channel: { id: string; name: string; type: string; loungeAgentId: string }; joined: boolean; canPost: boolean };
}

test("opening: 404 with the flag off, 403 for a Guest, created once, not joined until the first post", async ({ app }) => {
  const off = await seedWorld(app.baseUrl, { flag: false });
  assert.equal((await off.human("member", "POST", `/agents/${off.host.id}/lounge`)).status, 404);

  const world = await seedWorld(app.baseUrl);
  assert.equal((await world.human("guest", "POST", `/agents/${world.host.id}/lounge`)).status, 403);
  assert.equal((await world.human("member", "POST", `/agents/${randomUUID()}/lounge`)).status, 404);

  const first = await world.human("member", "POST", `/agents/${world.host.id}/lounge`);
  assert.equal(first.status, 201);
  const opened = (await first.json()) as Awaited<ReturnType<typeof openLounge>>;
  assert.equal(opened.channel.type, "channel");
  assert.equal(opened.channel.loungeAgentId, world.host.id);
  assert.equal(opened.channel.name, `host${world.tag}-lounge`);
  assert.deepEqual([opened.joined, opened.canPost], [false, true]);
  const again = await openLounge(world, "owner");
  assert.equal(again.channel.id, opened.channel.id);

  // The lounge's agent is its one agent member; nobody became a channel admin.
  assert.deepEqual(
    (await getDb().select({ agentId: channelAgents.agentId, role: channelAgents.role }).from(channelAgents).where(eq(channelAgents.channelId, opened.channel.id))),
    [{ agentId: world.host.id, role: "member" }],
  );
  assert.equal((await getDb().select().from(channelHumans).where(eq(channelHumans.channelId, opened.channel.id))).length, 0);

  const posted = await world.human("member", "POST", "/messages", { channelId: opened.channel.id, content: "hello" });
  assert.equal(posted.status, 200, await posted.text());
  assert.deepEqual(
    (await getDb().select({ userId: channelHumans.userId, role: channelHumans.role }).from(channelHumans).where(eq(channelHumans.channelId, opened.channel.id))),
    [{ userId: world.member.id, role: "member" }],
    "the first post joins, as a plain member",
  );
  const fetched = await world.human("member", "GET", `/channels/${opened.channel.id}`);
  assert.equal(fetched.status, 200);
  const fetchedBody = (await fetched.json()) as { loungeAgentId: string | null; joined: boolean };
  assert.deepEqual([fetchedBody.loungeAgentId, fetchedBody.joined], [world.host.id, true]);
});

test("Guests cannot read, post in or be added to a lounge", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { channel } = await openLounge(world);
  assert.equal((await world.human("guest", "GET", `/channels/${channel.id}`)).status, 404);
  assert.equal((await world.human("guest", "POST", "/messages", { channelId: channel.id, content: "hi" })).status, 403);
  const add = await world.human("owner", "POST", `/channels/${channel.id}/members`, { userId: world.guest.id });
  assert.notEqual(add.status, 200);
  assert.equal((await getDb().select().from(channelHumans).where(and(eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, world.guest.id)))).length, 0);
});

test("the database refuses any agent but the lounge's own as a member", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { channel } = await openLounge(world);
  await assert.rejects(
    getDb().insert(channelAgents).values({ channelId: channel.id, agentId: world.other.id, role: "member" }),
    guardError(/may not join agent lounge/),
  );
  // Nor can a channel other agents are in become a lounge, or a binding move.
  const crowded = await createChannel(world.server.id, `crowded-${world.tag}`, undefined, "channel");
  await getDb().insert(channelAgents).values({ channelId: crowded.id, agentId: world.other.id, role: "member" });
  await assert.rejects(
    getDb().insert(agentLounges).values({ channelId: crowded.id, serverId: world.server.id, agentId: world.host.id }),
    guardError(/cannot become a lounge/),
  );
  await assert.rejects(
    getDb().update(agentLounges).set({ agentId: world.other.id }).where(eq(agentLounges.channelId, channel.id)),
    guardError(/binding is immutable/),
  );
});

test("another agent reads the lounge but cannot join, post, react, follow, mute, be added or archive it", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { channel } = await openLounge(world);
  const posted = await createMessage(channel.id, "user", world.member.id, "question for the host");
  const thread = await getOrCreateThread(posted.id, world.member.id, "user");
  assert.ok(thread);

  // Reading is the one thing it may do.
  const read = await world.agentApi(world.otherKey, "GET", `/history?channel=${encodeURIComponent(`#${channel.name}`)}`);
  assert.equal(read.status, 200, await read.text());

  const join = await world.agentApi(world.otherKey, "POST", `/channels/${channel.id}/join`);
  assert.equal(join.status, 403);
  assert.equal(((await join.json()) as { code?: string }).code, "agent_lounge_outsider");

  const send = await world.agentApi(world.otherKey, "POST", "/send", { target: `#${channel.name}`, content: "hi" });
  assert.equal(send.status, 403, await send.text());
  const reply = await world.agentApi(world.otherKey, "POST", "/send", { target: `#${channel.name}:${posted.id.slice(0, 8)}`, content: "hi" });
  assert.equal(reply.status, 403, await reply.text());
  const react = await world.agentApi(world.otherKey, "POST", `/messages/${posted.id}/reactions`, { emoji: "👍" });
  assert.equal(react.status, 403, await react.text());
  const follow = await world.agentApi(world.otherKey, "POST", "/threads/follow", { thread: thread.id });
  assert.equal(follow.status, 403, await follow.text());
  assert.equal((await getDb().select().from(threadFollows).where(and(eq(threadFollows.threadChannelId, thread.id), eq(threadFollows.followerId, world.other.id)))).length, 0);
  const mute = await world.agentApi(world.otherKey, "POST", `/channels/${channel.id}/mute`);
  assert.ok(mute.status >= 400, `mute: ${mute.status}`);
  const archive = await world.agentApi(world.otherKey, "POST", "/channels/archive", { channel: `#${channel.name}` });
  assert.ok(archive.status >= 400, `archive: ${archive.status}`);

  // Added by a person (owner) or by itself through the agent route: refused.
  const added = await world.human("owner", "POST", `/channels/${channel.id}/members`, { agentId: world.other.id });
  assert.equal(added.status, 403);
  const batch = await world.human("owner", "POST", `/channels/${channel.id}/members/batch`, { userIds: [], agentIds: [world.other.id] });
  assert.equal(batch.status, 403);
  const selfAdd = await world.agentApi(world.otherKey, "POST", `/channels/${channel.id}/members`, { agentId: world.other.id });
  assert.ok(selfAdd.status >= 400, `self add: ${selfAdd.status}`);

  assert.deepEqual(
    (await getDb().select({ agentId: channelAgents.agentId }).from(channelAgents).where(eq(channelAgents.channelId, channel.id))).map((row) => row.agentId),
    [world.host.id],
  );
});

test("the lounge's own agent posts there; no agent manages it", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { channel } = await openLounge(world);
  const send = await world.agentApi(world.hostKey, "POST", "/send", { target: `#${channel.name}`, content: "hello all" });
  assert.equal(send.status, 200, await send.text());
  const archive = await world.agentApi(world.hostKey, "POST", "/channels/archive", { channel: `#${channel.name}` });
  assert.ok(archive.status >= 400, `the agent cannot close its own lounge: ${archive.status}`);
});

test("nobody is promoted to channel admin there, even by the server owner (no channel-level archive/unarchive)", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { channel } = await openLounge(world);
  const posted = await world.human("member", "POST", "/messages", { channelId: channel.id, content: "hello" });
  assert.equal(posted.status, 200, await posted.text());
  const send = await world.agentApi(world.hostKey, "POST", "/send", { target: `#${channel.name}`, content: "hi" });
  assert.equal(send.status, 200, await send.text());
  for (const [targetType, id] of [["user", world.member.id], ["agent", world.host.id]] as const) {
    const promoted = await world.human("owner", "PATCH", `/channels/${channel.id}/members/${targetType}/${id}/role`, { role: "admin" });
    assert.equal(promoted.status, 400, `${targetType}: ${promoted.status}`);
    assert.equal(((await promoted.json()) as { code: string }).code, "unsupported_channel_shape");
  }
  const archive = await world.human("member", "POST", `/channels/${channel.id}/archive`);
  assert.equal(archive.status, 403, "a member still cannot archive it");
});

test("listing: other agents and the human channel list do not show it; the lounge's agent does", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { channel } = await openLounge(world);
  assert.ok((await listChannelsForAgent(world.server.id, world.host.id)).some((row) => row.id === channel.id));
  assert.ok(!(await listChannelsForAgent(world.server.id, world.other.id)).some((row) => row.id === channel.id));
  const list = await world.human("member", "GET", "/channels");
  assert.equal(list.status, 200);
  assert.ok(!((await list.json()) as Array<{ id: string }>).some((row) => row.id === channel.id));
});

test("name, visibility and type are fixed, even for the server owner", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { channel } = await openLounge(world);
  await assert.rejects(updateChannel(channel.id, { name: "renamed" }), /cannot be renamed/);
  await assert.rejects(updateChannel(channel.id, { type: "private" }), /cannot be renamed/);
  await assert.rejects(updateChannel(channel.id, { guestVisible: true }), /cannot be renamed/);
  const patched = await world.human("owner", "PATCH", `/channels/${channel.id}`, { name: "renamed" });
  assert.equal(patched.status, 409);
  await updateChannel(channel.id, { description: "Ask the host anything" });
});

test("mentioning another agent there delivers nothing and leaves no pending mention (it works like a DM)", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { channel } = await openLounge(world);
  const posted = await world.human("member", "POST", "/messages", {
    channelId: channel.id,
    content: `@${world.other.name} can you look?`,
  });
  const body = (await posted.json()) as { pendingMentionActions?: Array<{ targetHandle: string }> };
  assert.equal(posted.status, 200, JSON.stringify(body));
  assert.deepEqual(body.pendingMentionActions ?? [], [], "no pending mention, so no 'won't be notified' line");
});

test("the DM list carries the agent's lounge (once it exists) and whether you joined it", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const dmBefore = await world.human("member", "POST", "/channels/dm", { agentId: world.host.id });
  assert.equal(dmBefore.status, 200, await dmBefore.text());
  const listBefore = (await (await world.human("member", "GET", "/channels/dm")).json()) as Array<{ peerId: string; lounge?: unknown }>;
  assert.equal(listBefore.find((row) => row.peerId === world.host.id)?.lounge, undefined, "no lounge yet: no field");

  const { channel } = await openLounge(world, "owner");
  // The owner joins by posting; the member has not joined.
  const posted = await world.human("owner", "POST", "/messages", { channelId: channel.id, content: "hello" });
  assert.equal(posted.status, 200);

  const list = (await (await world.human("member", "GET", "/channels/dm")).json()) as Array<{ peerId: string; lounge?: { channelId: string; joined: boolean } }>;
  assert.deepEqual(list.find((row) => row.peerId === world.host.id)?.lounge, { channelId: channel.id, joined: false });
  assert.equal((await world.human("owner", "POST", "/channels/dm", { agentId: world.host.id })).status, 200);
  const ownerList = (await (await world.human("owner", "GET", "/channels/dm")).json()) as Array<{ peerId: string; lounge?: { channelId: string; joined: boolean } }>;
  assert.deepEqual(ownerList.find((row) => row.peerId === world.host.id)?.lounge, { channelId: channel.id, joined: true });
});

test("mentioning a person who has not joined reminds nobody: no pending action, and notify is refused", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { channel } = await openLounge(world, "owner");
  const posted = await world.human("owner", "POST", "/messages", { channelId: channel.id, content: `@${world.member.name} have a look` });
  const body = (await posted.json()) as { pendingMentionActions?: Array<{ targetHandle: string }> };
  assert.equal(posted.status, 200, JSON.stringify(body));
  assert.deepEqual(body.pendingMentionActions ?? [], [], "no Notify / Add for a person in a lounge");
  const [row] = await getDb().select({ id: messageMentions.id }).from(messageMentions)
    .where(and(eq(messageMentions.channelId, channel.id), eq(messageMentions.targetId, world.member.id)));
  assert.ok(row, "the mention itself is recorded");
  const notify = await world.human("owner", "POST", "/messages/mention-actions/execute", { action: "notify", resolutionIds: [row.id] });
  assert.ok(!JSON.stringify(await notify.json()).includes('"queued"'), "notify does not reach them afterwards");
});

type SidebarPinResponse = {
  pinned: Array<{ kind: string; id: string }>;
  pinnedChannelIds: string[];
  pinnedOrder: string[];
  hiddenDmIds: string[];
};

async function closeRows(world: World, as: "owner" | "member" | "guest", ids: string[]) {
  const response = await world.human(as, "PATCH", `/servers/${world.server.id}/sidebar-order`, { hiddenDmIds: ids });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as SidebarPinResponse).hiddenDmIds;
}

async function pinChannels(world: World, as: "owner" | "member" | "guest", channelIds: string[]) {
  const response = await world.human(as, "PATCH", `/servers/${world.server.id}/sidebar-order`, {
    pinned: channelIds.map((id) => ({ kind: "channel", id })),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as SidebarPinResponse;
}

async function getSidebar(world: World, as: "owner" | "member" | "guest") {
  const response = await world.human(as, "GET", `/servers/${world.server.id}/sidebar-order`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as SidebarPinResponse;
}

function pinnedChannelShape(ids: string[]) {
  return { pinned: ids.map((id) => ({ kind: "channel", id })), pinnedChannelIds: ids, pinnedOrder: ids };
}

function pinShape(body: SidebarPinResponse) {
  return { pinned: body.pinned, pinnedChannelIds: body.pinnedChannelIds, pinnedOrder: body.pinnedOrder };
}

test("sidebar pin and close: a non-guest member pins and closes a lounge they have not joined; it sticks and nobody joins", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { channel } = await openLounge(world);

  const patched = await pinChannels(world, "member", [channel.id, world.room.id]);
  assert.deepEqual(pinShape(patched), pinnedChannelShape([channel.id, world.room.id]));
  assert.deepEqual(pinShape(await getSidebar(world, "member")), pinnedChannelShape([channel.id, world.room.id]));

  // A sidebar preference only: no lounge membership, and nobody else's sidebar changes.
  assert.equal((await getDb().select().from(channelHumans).where(eq(channelHumans.channelId, channel.id))).length, 0);
  assert.deepEqual((await getSidebar(world, "owner")).pinned, []);

  // An older client's legacy fields carry it the same way.
  const legacy = await world.human("owner", "PATCH", `/servers/${world.server.id}/sidebar-order`, {
    pinnedChannelIds: [channel.id],
    pinnedOrder: [channel.id],
  });
  const legacyText = await legacy.text();
  assert.equal(legacy.status, 200, legacyText);
  assert.deepEqual(pinShape(JSON.parse(legacyText) as SidebarPinResponse), pinnedChannelShape([channel.id]));

  // Closing the row (hiddenDmIds) follows the same rule, next to a closed DM.
  const dm = await findOrCreateUserDM(world.server.id, world.member.id, world.owner.id);
  assert.ok(dm);
  const dmId = dm.id;
  assert.deepEqual(await closeRows(world, "member", [channel.id, dmId]), [channel.id, dmId]);
  assert.deepEqual((await getSidebar(world, "member")).hiddenDmIds, [channel.id, dmId]);
  assert.deepEqual((await getSidebar(world, "owner")).hiddenDmIds, []);
  assert.deepEqual(await closeRows(world, "member", [dmId]), [dmId], "reopening removes it");

  // Mute (inbox target) is accepted for a member who has not joined, and does not join either.
  const muted = await world.human("member", "PATCH", `/channels/${channel.id}/notification-settings`, { activityMuted: true });
  const mutedText = await muted.text();
  assert.equal(muted.status, 200, mutedText);
  assert.equal((JSON.parse(mutedText) as { activityMuted: boolean }).activityMuted, true);
  assert.equal((await getDb().select().from(channelHumans).where(eq(channelHumans.channelId, channel.id))).length, 0);
});

test("sidebar pin and close: another Server's lounge, a Guest, a gone agent and the flag off all drop the lounge", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const { channel } = await openLounge(world);
  const elsewhere = await seedWorld(app.baseUrl);
  const foreign = await openLounge(elsewhere);

  assert.deepEqual(pinShape(await pinChannels(world, "member", [foreign.channel.id, world.room.id])), pinnedChannelShape([world.room.id]));
  assert.deepEqual(await closeRows(world, "member", [foreign.channel.id]), []);

  // Guests cannot read a lounge, so they cannot pin it (their own channel still pins).
  assert.deepEqual(pinShape(await pinChannels(world, "guest", [channel.id, world.room.id])), pinnedChannelShape([world.room.id]));
  assert.deepEqual(pinShape(await getSidebar(world, "guest")), pinnedChannelShape([world.room.id]));
  assert.deepEqual(await closeRows(world, "guest", [channel.id]), []);

  // The agent is deleted: the stored pin is dropped like any vanished channel.
  assert.deepEqual(pinShape(await pinChannels(world, "owner", [channel.id])), pinnedChannelShape([channel.id]));
  assert.deepEqual(await closeRows(world, "owner", [channel.id]), [channel.id]);
  await deleteAgent(world.host.id);
  const afterDelete = await getSidebar(world, "owner");
  assert.deepEqual(pinShape(afterDelete), pinnedChannelShape([]));
  assert.deepEqual(afterDelete.hiddenDmIds, []);

  // agent_lounge_v0 off for the Server: no lounge pin.
  const off = await seedWorld(app.baseUrl, { flag: false });
  const offLounge = await openOrCreateAgentLounge(off.server.id, off.host.id);
  assert.deepEqual(pinShape(await pinChannels(off, "member", [offLounge.channel.id])), pinnedChannelShape([]));
  assert.deepEqual(await closeRows(off, "member", [offLounge.channel.id]), []);
});
