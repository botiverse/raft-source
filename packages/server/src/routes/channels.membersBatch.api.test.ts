import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import {
  InMemoryFailpointRegistry,
  __resetFailpointsForTests,
  __setFailpointsForTests,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import {
  channelAgents,
  channelHumans,
  messages,
  servers,
  users,
} from "../db/schema";
import { accessTokenForTest } from "../test/integration/credentials";
import { createAgent } from "../services/agentService";
import {
  addHuman,
  createChannel,
  findOrCreateDM,
  findOrCreateUserDM,
  isChannelAgent,
  isChannelHuman,
} from "../services/channelService";
import { addMember, createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: "not-used-by-this-token-authenticated-test",
    emailVerified: true,
  }).returning();
  assert.ok(user);
  return user;
}

async function headers(userId: string, serverId: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${await accessTokenForTest(userId)}`,
    "X-Server-Id": serverId,
  };
}

test("POST /api/channels/:id/members/batch atomically adds mixed members and is idempotent", async ({ app }) => {
  const owner = await seedUser("member-batch-owner");
  const humanA = await seedUser("member-batch-human-a");
  const humanB = await seedUser("member-batch-human-b");
  const server = await createServer("Member Batch", "member-batch", owner.id);
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  await addMember(server.id, humanA.id);
  await addMember(server.id, humanB.id);
  const agentA = await createAgent(server.id, "member-batch-agent-a", { runtime: "codex" });
  const agentB = await createAgent(server.id, "member-batch-agent-b", { runtime: "codex" });
  const channel = await createChannel(server.id, "batch-target");
  await addHuman(channel.id, owner.id);

  const response = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/batch`, {
    method: "POST",
    headers: await headers(owner.id, server.id),
    body: JSON.stringify({
      userIds: [humanA.id, humanB.id, humanA.id],
      agentIds: [agentA.id, agentB.id, agentA.id],
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    added: {
      userIds: [humanA.id, humanB.id],
      agentIds: [agentA.id, agentB.id],
    },
    alreadyMembers: { userIds: [], agentIds: [] },
  });
  assert.equal(await isChannelHuman(channel.id, humanA.id), true);
  assert.equal(await isChannelHuman(channel.id, humanB.id), true);
  assert.equal(await isChannelAgent(channel.id, agentA.id), true);
  assert.equal(await isChannelAgent(channel.id, agentB.id), true);

  const membershipNotices = await getDb().select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.messageType, "system")));
  assert.deepEqual(
    membershipNotices.map((row) => row.content).sort(),
    [
      `@${agentA.name} was added to this channel.`,
      `@${agentB.name} was added to this channel.`,
      `@${humanA.name} was added to this channel.`,
      `@${humanB.name} was added to this channel.`,
    ].sort(),
    "every committed member keeps the durable membership notice side effect",
  );

  const retry = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/batch`, {
    method: "POST",
    headers: await headers(owner.id, server.id),
    body: JSON.stringify({
      userIds: [humanA.id, humanB.id],
      agentIds: [agentA.id, agentB.id],
    }),
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    ok: true,
    added: { userIds: [], agentIds: [] },
    alreadyMembers: {
      userIds: [humanA.id, humanB.id],
      agentIds: [agentA.id, agentB.id],
    },
  });
  const noticesAfterRetry = await getDb().select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.messageType, "system")));
  assert.equal(noticesAfterRetry.length, 4, "an idempotent retry must not duplicate membership notices");
});

test("POST /api/channels/:id/members/batch validates the whole batch before writing", async ({ app }) => {
  const owner = await seedUser("member-batch-atomic-owner");
  const validHuman = await seedUser("member-batch-atomic-valid");
  const server = await createServer("Member Batch Atomic", "member-batch-atomic", owner.id);
  await addMember(server.id, validHuman.id);
  const channel = await createChannel(server.id, "batch-atomic-target");
  await addHuman(channel.id, owner.id);
  const missingUserId = randomUUID();

  const response = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/batch`, {
    method: "POST",
    headers: await headers(owner.id, server.id),
    body: JSON.stringify({ userIds: [validHuman.id, missingUserId], agentIds: [] }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "One or more users are not members of this server",
    code: "users_not_in_server",
    invalidUserIds: [missingUserId],
  });
  assert.equal(await isChannelHuman(channel.id, validHuman.id), false, "a rejected batch must not partially add valid members");
  const notices = await getDb().select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channel.id), eq(messages.messageType, "system")));
  assert.equal(notices.length, 0, "a rejected batch must not persist partial side effects");
  const humanRows = await getDb().select().from(channelHumans).where(eq(channelHumans.channelId, channel.id));
  const agentRows = await getDb().select().from(channelAgents).where(eq(channelAgents.channelId, channel.id));
  assert.deepEqual(humanRows.map((row) => row.userId), [owner.id]);
  assert.deepEqual(agentRows, []);
});

test("POST /api/channels/:id/members/batch rolls back earlier members when a later write fails", async ({ app }) => {

  try {
    const owner = await seedUser("member-batch-rollback-owner");
    const humanA = await seedUser("member-batch-rollback-a");
    const humanB = await seedUser("member-batch-rollback-b");
    const server = await createServer("Member Batch Rollback", "member-batch-rollback", owner.id);
    await addMember(server.id, humanA.id);
    await addMember(server.id, humanB.id);
    const channel = await createChannel(server.id, "batch-rollback-target");
    await addHuman(channel.id, owner.id);

    let persistedMembers = 0;
    const failpoints = new InMemoryFailpointRegistry({
      sleep: async () => {
        persistedMembers += 1;
        if (persistedMembers === 2) throw new Error("fail second batch member after persistence");
      },
    });
    failpoints.configure("server.channel.membership.afterPersist", {
      mode: "always",
      effect: "delay",
      payload: 0,
    });
    __setFailpointsForTests(failpoints);

    const response = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/batch`, {
      method: "POST",
      headers: await headers(owner.id, server.id),
      body: JSON.stringify({ userIds: [humanA.id, humanB.id], agentIds: [] }),
    });
    assert.equal(response.status, 500);
    assert.equal(persistedMembers, 2, "the failure must occur after the first member was written inside the transaction");
    assert.equal(await isChannelHuman(channel.id, humanA.id), false);
    assert.equal(await isChannelHuman(channel.id, humanB.id), false);
    const notices = await getDb().select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, channel.id), eq(messages.messageType, "system")));
    assert.equal(notices.length, 0, "membership rows, notices, and inbox facts share the rollback boundary");
  } finally {
    __resetFailpointsForTests();
    await app.close();
  }
});

test("a DM has two fixed parties: its participants cannot add anyone, others still get 404", async ({ app }) => {
  const owner = await seedUser("dm-fixed-owner");
  const alice = await seedUser("dm-fixed-alice");
  const bob = await seedUser("dm-fixed-bob");
  const carol = await seedUser("dm-fixed-carol");
  const server = await createServer("DM Fixed Parties", "dm-fixed-parties", owner.id);
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  for (const user of [alice, bob, carol]) await addMember(server.id, user.id);
  const agent = await createAgent(server.id, "dm-fixed-agent", { runtime: "codex" });
  const otherAgent = await createAgent(server.id, "dm-fixed-other-agent", { runtime: "codex" });
  const humanDm = await findOrCreateUserDM(server.id, alice.id, bob.id);
  const agentDm = await findOrCreateDM(server.id, alice.id, agent.id);
  assert.ok(humanDm && agentDm, "DM creation still adds its two parties");
  assert.equal(await isChannelHuman(humanDm.id, bob.id), true);
  assert.equal(await isChannelAgent(agentDm.id, agent.id), true);

  const refusal = { error: "You do not have permission to add channel members" };
  const attempts: Array<{ channelId: string; path: string; body: object }> = [];
  for (const dm of [humanDm, agentDm]) {
    attempts.push(
      { channelId: dm.id, path: "members", body: { userId: carol.id } },
      { channelId: dm.id, path: "members", body: { agentId: otherAgent.id } },
      { channelId: dm.id, path: "members/batch", body: { userIds: [carol.id], agentIds: [] } },
      { channelId: dm.id, path: "members/batch", body: { userIds: [], agentIds: [otherAgent.id] } },
    );
  }
  for (const attempt of attempts) {
    const label = `${attempt.path} ${JSON.stringify(attempt.body)}`;
    const res = await fetch(`${app.baseUrl}/api/channels/${attempt.channelId}/${attempt.path}`, {
      method: "POST",
      headers: await headers(alice.id, server.id),
      body: JSON.stringify(attempt.body),
    });
    assert.equal(res.status, 403, label);
    assert.deepEqual(await res.json(), refusal, label);
    // Not a participant either: the same 404 as an id that does not exist.
    for (const outsider of [carol, owner]) {
      const outsiderRes = await fetch(`${app.baseUrl}/api/channels/${attempt.channelId}/${attempt.path}`, {
        method: "POST",
        headers: await headers(outsider.id, server.id),
        body: JSON.stringify(attempt.body),
      });
      assert.equal(outsiderRes.status, 404, `${outsider.name} ${label}`);
      assert.deepEqual(await outsiderRes.json(), { error: "Channel not found" }, `${outsider.name} ${label}`);
    }
  }

  for (const dm of [humanDm, agentDm]) {
    assert.equal(await isChannelHuman(dm.id, carol.id), false);
    assert.equal(await isChannelAgent(dm.id, otherAgent.id), false);
    const read = await fetch(`${app.baseUrl}/api/channels/${dm.id}`, { headers: await headers(carol.id, server.id) });
    assert.equal(read.status, 404, "the refused target cannot read the DM");
    const notices = await getDb().select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, dm.id), eq(messages.messageType, "system")));
    assert.equal(notices.length, 0, "a refused add leaves no membership notice");
  }

  // An ordinary channel still takes the same adds from the same person.
  const channel = await createChannel(server.id, "dm-fixed-control");
  await addHuman(channel.id, alice.id);
  const single = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members`, {
    method: "POST",
    headers: await headers(alice.id, server.id),
    body: JSON.stringify({ userId: carol.id }),
  });
  assert.equal(single.status, 200);
  const batch = await fetch(`${app.baseUrl}/api/channels/${channel.id}/members/batch`, {
    method: "POST",
    headers: await headers(alice.id, server.id),
    body: JSON.stringify({ userIds: [bob.id], agentIds: [otherAgent.id] }),
  });
  assert.equal(batch.status, 200);
  assert.equal(await isChannelHuman(channel.id, carol.id), true);
  assert.equal(await isChannelHuman(channel.id, bob.id), true);
  assert.equal(await isChannelAgent(channel.id, otherAgent.id), true);
});
