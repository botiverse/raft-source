import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";

import { getDb } from "../db/index";
import { serverMembers, servers, users } from "../db/schema";
import { createServer } from "./serverService";
import { createAgent } from "./agentService";
import { addAgent, addHuman, createChannel } from "./channelService";
import { createMessage } from "./messageService";
import { seedJointChannel } from "../test/integration/jointFixture";
import { resolveMessageResourceAccess } from "./messageResourceAccess";

// The contract of one message as a resource (services/messageResourceAccess.ts):
// access before the history window, so someone who can't read a message is
// never told it is old; and the window is the reading server's, so in a Joint
// Channel each side's plan decides.

afterEach(async () => {
  await closeTestDatabase();
});

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `resource-${label}-${suffix}@slock.test`,
    name: `resource-${label}-${suffix}`,
    displayName: label,
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function backdate(messageId: string) {
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${messageId}::uuid`);
}

async function seedFreeServer() {
  const owner = await seedUser("owner");
  const outsider = await seedUser("outsider");
  const server = await createServer("Resource Access", `resource-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: outsider.id, role: "member" }).onConflictDoNothing();
  const agent = await createAgent(server.id, `ResourceBot${randomUUID().slice(0, 6)}`, { runtime: "claude", model: "sonnet" });
  const secret = await createChannel(server.id, `resource-secret-${randomUUID().slice(0, 6)}`, undefined, "private");
  await addHuman(secret.id, owner.id);
  const old = await createMessage(secret.id, "user", owner.id, "an old private decision", "chat");
  const recent = await createMessage(secret.id, "user", owner.id, "a recent private decision", "chat");
  await backdate(old.id);
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  return { owner, outsider, server, agent, secret, old, recent };
}

test("someone who can't read a message is never told it is behind the window", async ({ db: _db }) => {
  const fx = await seedFreeServer();
  const asUser = (userId: string, messageId: string) =>
    resolveMessageResourceAccess({ messageId, serverId: fx.server.id, actor: { type: "user", id: userId } });

  const outsider = await asUser(fx.outsider.id, fx.old.id);
  assert.equal(outsider.kind, "no_access");
  assert.deepEqual(outsider.kind === "no_access" && { status: outsider.status, error: outsider.error }, { status: 404, error: "Message not found" });

  assert.equal((await asUser(fx.owner.id, fx.old.id)).kind, "history_limited");
  const readable = await asUser(fx.owner.id, fx.recent.id);
  assert.equal(readable.kind, "readable");
  assert.equal(readable.kind === "readable" && readable.message.id, fx.recent.id);
  assert.equal(readable.kind === "readable" && readable.localChannelId, fx.secret.id);

  // An agent outside the channel: not found, not "old". Once it may read: the window.
  const asAgent = (messageId: string, alsoRequire?: () => Promise<boolean>) =>
    resolveMessageResourceAccess({ messageId, serverId: fx.server.id, actor: { type: "agent", id: fx.agent.id, alsoRequire } });
  assert.equal((await asAgent(fx.old.id)).kind, "no_access");
  await addAgent(fx.secret.id, fx.agent.id);
  assert.equal((await asAgent(fx.old.id)).kind, "history_limited");
  assert.equal((await asAgent(fx.recent.id)).kind, "readable");
  const confined = await asAgent(fx.old.id, async () => false);
  assert.equal(confined.kind === "no_access" && confined.reason, "not_found", "a route's extra condition is part of access");

  const invalid = await asAgent("not-an-id");
  assert.deepEqual(invalid.kind === "no_access" && { reason: invalid.reason, status: invalid.status }, { reason: "id_invalid", status: 400 });

  // Pro keeps everything.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  assert.equal((await asUser(fx.owner.id, fx.old.id)).kind, "readable");
});

test("in a Joint Channel the reading server's plan decides", async ({ db: _db }) => {
  const owner = await seedUser("joint-owner");
  const freeServer = await createServer("Resource Joint Free", `resource-joint-free-${randomUUID().slice(0, 8)}`, owner.id);
  const proServer = await createServer("Resource Joint Pro", `resource-joint-pro-${randomUUID().slice(0, 8)}`, owner.id);
  const joint = await seedJointChannel({ name: `resource-joint-${randomUUID().slice(0, 6)}`, serverIds: [freeServer.id, proServer.id], createdByUserId: owner.id });
  for (const projection of joint.projections) await addHuman(projection.id, owner.id);
  const old = await createMessage(joint.canonical.id, "user", owner.id, "an old joint message", "chat");
  await backdate(old.id);
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, freeServer.id));
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, proServer.id));

  const read = (serverId: string) =>
    resolveMessageResourceAccess({ messageId: old.id, serverId, actor: { type: "user", id: owner.id } });
  assert.equal((await read(freeServer.id)).kind, "history_limited");
  const fromPro = await read(proServer.id);
  assert.equal(fromPro.kind, "readable", "the Pro server keeps the whole history");
  const proProjection = joint.projections.find((projection) => projection.serverId === proServer.id)!;
  assert.equal(fromPro.kind === "readable" && fromPro.localChannelId, proProjection.id, "held through that server's projection");
});
