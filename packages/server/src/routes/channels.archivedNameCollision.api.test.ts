import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { getDb } from "../db/index";
import { users, serverMembers } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, archiveChannel, createChannel } from "../services/channelService";
import { createChannelForAgent } from "./agentChannelCreate";

// A channel name an archived channel holds (#proj-chat:#19): someone who can
// see that channel is told which one it is (to restore or open it); anyone else
// gets the plain "already taken", so trying a name does not reveal a private
// archived channel. Create and rename alike.

const test = createApiTest();

type Fixtures = {
  serverId: string;
  ownerId: string;
  ownerToken: string;
  memberToken: string;
  memberChannelId: string;
  ownerChannelId: string;
  privateArchivedId: string;
  publicArchivedId: string;
  agent: { id: string; name: string; serverId: string };
};

async function login(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `${email} login must succeed`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function seed(baseUrl: string): Promise<Fixtures> {
  const db = getDb();
  const insertUser = async (key: string) => {
    const [user] = await db.insert(users).values({
      email: `archived-name-${key}@slock.test`,
      name: `archived-name-${key}`,
      displayName: `Archived Name ${key}`,
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    return user;
  };
  const owner = await insertUser("owner");
  const member = await insertUser("member");
  const server = await createServer("Archived Name Server", "archived-name", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const agent = await createAgent(server.id, "archived-name-agent", { runtime: "codex" });

  // Private, archived, only the owner in it: the member and the agent can't see it.
  const privateArchived = await createChannel(server.id, "secret-room", undefined, "private");
  await addHuman(privateArchived.id, owner.id);
  await archiveChannel(privateArchived.id, owner.id);
  // Public, archived: everyone in the server can see it.
  const publicArchived = await createChannel(server.id, "old-room");
  await addHuman(publicArchived.id, owner.id);
  await archiveChannel(publicArchived.id, owner.id);

  const memberChannel = await createChannel(server.id, "member-room");
  await addHuman(memberChannel.id, member.id, { role: "admin" });
  await addAgent(memberChannel.id, agent.id);
  const ownerChannel = await createChannel(server.id, "owner-room");
  await addHuman(ownerChannel.id, owner.id);

  return {
    serverId: server.id,
    ownerId: owner.id,
    ownerToken: await login(baseUrl, owner.email),
    memberToken: await login(baseUrl, member.email),
    memberChannelId: memberChannel.id,
    ownerChannelId: ownerChannel.id,
    privateArchivedId: privateArchived.id,
    publicArchivedId: publicArchived.id,
    agent: { id: agent.id, name: agent.name, serverId: server.id },
  };
}

function headers(token: string, serverId: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Server-Id": serverId };
}

async function createAs(baseUrl: string, token: string, f: Fixtures, name: string) {
  const res = await fetch(`${baseUrl}/api/channels`, {
    method: "POST",
    headers: headers(token, f.serverId),
    body: JSON.stringify({ name }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function renameAs(baseUrl: string, token: string, f: Fixtures, channelId: string, name: string) {
  const res = await fetch(`${baseUrl}/api/channels/${channelId}`, {
    method: "PATCH",
    headers: headers(token, f.serverId),
    body: JSON.stringify({ name }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

function assertGenericTaken(result: { status: number; body: Record<string, unknown> }, name: string) {
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: `Channel name "${name}" is already taken` });
}

test("creating a channel: who can see the archived holder is told which one; who can't gets the plain answer", async ({ app }) => {
  const baseUrl = app.baseUrl;
  const f = await seed(baseUrl);

  const ownerResult = await createAs(baseUrl, f.ownerToken, f, "secret-room");
  assert.equal(ownerResult.status, 409);
  assert.equal(ownerResult.body.code, "archived_name_collision");
  assert.equal(ownerResult.body.archivedChannelId, f.privateArchivedId);
  assert.equal(ownerResult.body.archivedChannelName, "secret-room");
  assert.equal(ownerResult.body.canUnarchiveArchivedChannel, true);

  assertGenericTaken(await createAs(baseUrl, f.memberToken, f, "secret-room"), "secret-room");

  const memberPublic = await createAs(baseUrl, f.memberToken, f, "old-room");
  assert.equal(memberPublic.status, 409);
  assert.equal(memberPublic.body.code, "archived_name_collision");
  assert.equal(memberPublic.body.archivedChannelId, f.publicArchivedId);
});

test("renaming a channel to a name an archived channel holds answers the same way", async ({ app }) => {
  const baseUrl = app.baseUrl;
  const f = await seed(baseUrl);

  const ownerResult = await renameAs(baseUrl, f.ownerToken, f, f.ownerChannelId, "secret-room");
  assert.equal(ownerResult.status, 409);
  assert.equal(ownerResult.body.code, "archived_name_collision");
  assert.equal(ownerResult.body.archivedChannelId, f.privateArchivedId);

  assertGenericTaken(await renameAs(baseUrl, f.memberToken, f, f.memberChannelId, "secret-room"), "secret-room");

  const memberPublic = await renameAs(baseUrl, f.memberToken, f, f.memberChannelId, "old-room");
  assert.equal(memberPublic.status, 409);
  assert.equal(memberPublic.body.code, "archived_name_collision");
  assert.equal(memberPublic.body.archivedChannelId, f.publicArchivedId);

  // A live channel holding the name is still the plain answer.
  assertGenericTaken(await renameAs(baseUrl, f.memberToken, f, f.memberChannelId, "owner-room"), "owner-room");
});

test("an agent that can't see the private archived holder gets the plain answer", async ({ app }) => {
  const baseUrl = app.baseUrl;
  const f = await seed(baseUrl);
  const hidden = await createChannelForAgent({ actor: f.agent, serverId: f.serverId, body: { name: "secret-room" } });
  assert.equal(hidden.status, 409);
  assert.deepEqual(hidden.body, { error: `Channel name "secret-room" is already taken` });

  const visible = await createChannelForAgent({ actor: f.agent, serverId: f.serverId, body: { name: "old-room" } });
  assert.equal(visible.status, 409);
  assert.equal((visible.body as Record<string, unknown>).code, "archived_name_collision");
});
