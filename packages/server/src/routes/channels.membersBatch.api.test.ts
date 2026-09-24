import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import {
  InMemoryFailpointRegistry,
  __resetFailpointsForTests,
  __setFailpointsForTests,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
  channelAgents,
  channelHumans,
  messages,
  servers,
  users,
} from "../db/schema.js";
import { signAccessToken } from "../middleware/auth.js";
import { createAgent } from "../services/agentService.js";
import {
  addHuman,
  createChannel,
  isChannelAgent,
  isChannelHuman,
} from "../services/channelService.js";
import { addMember, createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

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

function headers(userId: string, serverId: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${signAccessToken(userId)}`,
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
    headers: headers(owner.id, server.id),
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
    headers: headers(owner.id, server.id),
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
    headers: headers(owner.id, server.id),
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
      headers: headers(owner.id, server.id),
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
