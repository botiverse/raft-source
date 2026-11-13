import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { messages, serverAgentMembers, serverMembers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { addAgent, createChannel, findOrCreateDM, findOrCreateUserDM, getOrCreateThread, getSystemAllChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { registerMachine } from "../services/machineService";
import { createServer } from "../services/serverService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { addChannelMemberForAgent, removeChannelMemberForAgent } from "./agentChannelMembers";

// #wg-rbac B8 + B14: #all join/leave answer like the human route, and an agent
// asking about a channel it cannot see gets 404 whatever the channel's type.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function fixture(prefix: string) {
  const owner = await seedUser(`${prefix}-owner-${randomUUID().slice(0, 6)}`);
  const peer = await seedUser(`${prefix}-peer-${randomUUID().slice(0, 6)}`);
  const server = await createServer(`${prefix} server`, `${prefix}-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: peer.id, role: "member" });
  const agent = await createAgent(server.id, `${prefix}-agent`, { runtime: "codex" });
  await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(
    eq(serverAgentMembers.serverId, server.id),
    eq(serverAgentMembers.agentId, agent.id),
  ));
  const credential = await mintAgentCredential({ agentId: agent.id, scopes: ["channels", "read", "send"], name: prefix, issuedVia: "human", createdByUserId: owner.id });
  return { owner, peer, server, agent, apiKey: credential.apiKey };
}

test("an agent joining #all gets ok without announcing itself; a human leaving #all gets 403", async ({ app }) => {
  const f = await fixture("all-join");
  const all = await getSystemAllChannel(f.server.id);
  assert.ok(all);

  for (let i = 0; i < 2; i++) {
    const join = await fetch(`${app.baseUrl}/internal/agent-api/channels/${all.id}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.apiKey}` },
    });
    assert.equal(join.status, 200);
  }
  const announcements = await getDb().select({ id: messages.id }).from(messages)
    .where(and(eq(messages.channelId, all.id), eq(messages.content, `@${f.agent.name} joined this channel.`)));
  assert.equal(announcements.length, 0, "joining #all posts no join notice");

  const token = await login(app.baseUrl, f.peer.email);
  const leave = await fetch(`${app.baseUrl}/api/channels/${all.id}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" },
  });
  assert.equal(leave.status, 403);
  assert.equal(((await leave.json()) as { code?: string }).code, "all_channel_membership_fixed");

  const agentLeave = await fetch(`${app.baseUrl}/internal/agent-api/channels/${all.id}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.apiKey}` },
  });
  assert.equal(agentLeave.status, 403);
  assert.equal(((await agentLeave.json()) as { code?: string }).code, "all_channel_membership_fixed");

  const actor = { id: f.agent.id, name: f.agent.name, serverId: f.server.id };
  const removeFromAll = await removeChannelMemberForAgent({ actor, serverId: f.server.id, channelId: all.id, body: { userId: f.peer.id } });
  assert.equal(removeFromAll.status, 403);
  assert.equal((removeFromAll.body as { code?: string }).code, "all_channel_membership_fixed");
});

test("an agent gets 404 for a DM or private channel it cannot see, whatever the type", async ({ app }) => {
  const f = await fixture("oracle");
  const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
  assert.ok(dm);
  const privateChannel = await createChannel(f.server.id, `oracle-private-${randomUUID().slice(0, 6)}`, undefined, "private");
  const actor = { id: f.agent.id, name: f.agent.name, serverId: f.server.id };

  const addToDm = await addChannelMemberForAgent({ actor, serverId: f.server.id, channelId: dm.id, body: { userId: f.peer.id } });
  assert.equal(addToDm.status, 404, JSON.stringify(addToDm.body));

  const missing = await fetch(`${app.baseUrl}/internal/agent-api/channels/${randomUUID()}/join`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.apiKey}` },
  });
  assert.equal(missing.status, 404, "an id that does not exist");
  const missingBody = await missing.json() as { code?: string };
  assert.equal(missingBody.code, "channel_not_found");
  for (const channelId of [dm.id, privateChannel.id]) {
    const join = await fetch(`${app.baseUrl}/internal/agent-api/channels/${channelId}/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.apiKey}` },
    });
    assert.equal(join.status, 404, `join ${channelId}`);
    assert.deepEqual(await join.json(), missingBody, `join ${channelId}: same body as an id that does not exist`);
  }
});

test("remove-member and leave answer 404 for a channel the agent cannot see, same as a random id", async ({ app }) => {
  const f = await fixture("oracle-rm");
  const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
  assert.ok(dm);
  const privateChannel = await createChannel(f.server.id, `oracle-rm-private-${randomUUID().slice(0, 6)}`, undefined, "private");
  const jointChannel = await createChannel(f.server.id, `oracle-rm-joint-${randomUUID().slice(0, 6)}`, undefined, "joint");
  // A thread under a private channel the agent is not in.
  const parent = await createMessage(privateChannel.id, "user", f.owner.id, "thread parent");
  const thread = await getOrCreateThread(parent.id, f.owner.id, "user");
  const actor = { id: f.agent.id, name: f.agent.name, serverId: f.server.id };

  const leaveBodies: unknown[] = [];
  for (const channelId of [dm.id, privateChannel.id, jointChannel.id, thread.id, randomUUID()]) {
    const remove = await removeChannelMemberForAgent({ actor, serverId: f.server.id, channelId, body: { userId: f.peer.id } });
    assert.equal(remove.status, 404, `remove ${channelId}: ${JSON.stringify(remove.body)}`);
    assert.deepEqual(remove.body, { error: "Channel not found" });

    const leave = await fetch(`${app.baseUrl}/internal/agent-api/channels/${channelId}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.apiKey}` },
    });
    assert.equal(leave.status, 404, `leave ${channelId}`);
    const leaveBody = await leave.json() as { code?: string };
    assert.equal(leaveBody.code, "channel_not_found");
    leaveBodies.push(leaveBody);
  }
  // Every hidden channel answers exactly as the random id does.
  for (const body of leaveBodies) assert.deepEqual(body, leaveBodies.at(-1));
});

test("an agent that can see a DM or thread still gets the type-specific refusal", async ({ app }) => {
  const f = await fixture("oracle-visible");
  const dm = await findOrCreateDM(f.server.id, f.owner.id, f.agent.id);
  assert.ok(dm);
  const publicChannel = await createChannel(f.server.id, `oracle-visible-${randomUUID().slice(0, 6)}`);
  await addAgent(publicChannel.id, f.agent.id);
  const parent = await createMessage(publicChannel.id, "user", f.owner.id, "thread parent");
  const thread = await getOrCreateThread(parent.id, f.owner.id, "user");
  const actor = { id: f.agent.id, name: f.agent.name, serverId: f.server.id };

  const addToDm = await addChannelMemberForAgent({ actor, serverId: f.server.id, channelId: dm.id, body: { userId: f.peer.id } });
  assert.equal(addToDm.status, 400, JSON.stringify(addToDm.body));
  assert.match((addToDm.body as { error: string }).error, /Only public, private, or joint channels/);

  const addToThread = await addChannelMemberForAgent({ actor, serverId: f.server.id, channelId: thread.id, body: { userId: f.peer.id } });
  assert.equal(addToThread.status, 400, JSON.stringify(addToThread.body));
  assert.match((addToThread.body as { error: string }).error, /follow\/unfollow/);

  const removeFromDm = await removeChannelMemberForAgent({ actor, serverId: f.server.id, channelId: dm.id, body: { userId: f.owner.id } });
  assert.equal(removeFromDm.status, 400, JSON.stringify(removeFromDm.body));

  const leaveDm = await fetch(`${app.baseUrl}/internal/agent-api/channels/${dm.id}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.apiKey}` },
  });
  assert.equal(leaveDm.status, 403);
  assert.match(((await leaveDm.json()) as { error: string }).error, /Agents can only leave regular or joint channels/);
});

// #wg-rbac:#64: the legacy daemon routes (POST /internal/agent/:id/channels/:channelId/join
// and /leave) answered by channel type, or with a 403 naming visibility, before
// checking that the agent can see the channel: an id it held told it the channel
// existed and what kind it was.
test("legacy agent join and leave answer the missing-channel 404 for a channel the agent cannot see, whatever its type", async ({ app }) => {
  const f = await fixture("legacy-oracle");
  const { machine, apiKey: machineKey } = await registerMachine(f.server.id, f.owner.id, "legacy-oracle-daemon");
  await placeAgentOnMachine(f.agent.id, machine.id);
  const headers = { Authorization: `Bearer ${machineKey}`, "Content-Type": "application/json" };
  const call = async (channelId: string, action: "join" | "leave") => {
    const res = await fetch(`${app.baseUrl}/internal/agent/${f.agent.id}/channels/${channelId}/${action}`, { method: "POST", headers, body: "{}" });
    return { status: res.status, text: await res.text() };
  };

  const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
  assert.ok(dm);
  const privateChannel = await createChannel(f.server.id, `legacy-private-${randomUUID().slice(0, 6)}`, undefined, "private");
  const jointChannel = await createChannel(f.server.id, `legacy-joint-${randomUUID().slice(0, 6)}`, undefined, "joint");
  const parent = await createMessage(privateChannel.id, "user", f.owner.id, "thread parent");
  const thread = await getOrCreateThread(parent.id, f.owner.id, "user");
  const other = await fixture("legacy-oracle-other");
  const foreign = await createChannel(other.server.id, `legacy-foreign-${randomUUID().slice(0, 6)}`);

  for (const action of ["join", "leave"] as const) {
    const missing = await call(randomUUID(), action);
    assert.equal(missing.status, 404, `${action}: an id that does not exist`);
    for (const [label, channelId] of [["dm", dm.id], ["private", privateChannel.id], ["joint", jointChannel.id], ["thread", thread.id], ["another server's", foreign.id]] as const) {
      const hidden = await call(channelId, action);
      assert.equal(hidden.status, 404, `${action} ${label}: ${hidden.text}`);
      assert.equal(hidden.text, missing.text, `${action} ${label}: the same body as an id that does not exist`);
    }
  }

  // What the agent can see still answers by what it is: a public channel joins and leaves,
  // a private channel it is in says how joining works and can be left.
  const publicChannel = await createChannel(f.server.id, `legacy-public-${randomUUID().slice(0, 6)}`);
  assert.equal((await call(publicChannel.id, "join")).status, 200);
  await addAgent(privateChannel.id, f.agent.id);
  const joinOwnPrivate = await call(privateChannel.id, "join");
  assert.equal(joinOwnPrivate.status, 403, joinOwnPrivate.text);
  assert.notEqual(joinOwnPrivate.text, (await call(randomUUID(), "join")).text, "a visible private channel is not the 404");
});

test("legacy agent thread unfollow by id answers the missing-thread 404 for a channel or thread the agent cannot see", async ({ app }) => {
  const f = await fixture("legacy-unfollow-oracle");
  const { machine, apiKey: machineKey } = await registerMachine(f.server.id, f.owner.id, "legacy-unfollow-daemon");
  await placeAgentOnMachine(f.agent.id, machine.id);
  const headers = { Authorization: `Bearer ${machineKey}`, "Content-Type": "application/json" };
  const unfollow = async (thread: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent/${f.agent.id}/threads/unfollow`, { method: "POST", headers, body: JSON.stringify({ thread }) });
    return { status: res.status, text: await res.text() };
  };

  const dm = await findOrCreateUserDM(f.server.id, f.owner.id, f.peer.id);
  assert.ok(dm);
  const privateChannel = await createChannel(f.server.id, `unfollow-private-${randomUUID().slice(0, 6)}`, undefined, "private");
  const jointChannel = await createChannel(f.server.id, `unfollow-joint-${randomUUID().slice(0, 6)}`, undefined, "joint");
  const parent = await createMessage(privateChannel.id, "user", f.owner.id, "thread parent");
  const thread = await getOrCreateThread(parent.id, f.owner.id, "user");
  const other = await fixture("legacy-unfollow-other");
  const foreign = await createChannel(other.server.id, `unfollow-foreign-${randomUUID().slice(0, 6)}`);

  const missing = await unfollow(randomUUID());
  assert.equal(missing.status, 404, missing.text);
  for (const [label, channelId] of [["dm", dm.id], ["private", privateChannel.id], ["joint", jointChannel.id], ["thread", thread.id], ["another server's", foreign.id]] as const) {
    const hidden = await unfollow(channelId);
    assert.equal(hidden.status, 404, `${label}: ${hidden.text}`);
    assert.equal(hidden.text, missing.text, `${label}: the same body as an id that does not exist`);
  }

  // A channel the agent can see is still told it is not a thread.
  const publicChannel = await createChannel(f.server.id, `unfollow-public-${randomUUID().slice(0, 6)}`);
  const visible = await unfollow(publicChannel.id);
  assert.equal(visible.status, 400, visible.text);
  assert.notEqual(visible.text, missing.text);
});
