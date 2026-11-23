import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { getDb } from "../db/index";
import { channels, jointChannels, jointChannelServers, messages, servers } from "../db/schema";
import { createJointChannel, lockAndResolveMessageStorage } from "./channelService";
import { createMessage } from "./messageService";
import { createTasks, TaskMutationConflictError } from "./taskService";

// lockAndResolveMessageStorage: where a writer's new message is stored,
// resolved inside its transaction. The lock interplay with a route change
// needs two real connections: messageRouteLock.realPg.test.ts.

test("an ordinary channel stores its messages in itself", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  assert.equal(await getDb().transaction((tx) => lockAndResolveMessageStorage(tx, channel.id)), channel.id);
});

async function seedJoint(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const target = await seed.server({ owner });
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const created = await createJointChannel({ hostServerId: server.id, createdByUserId: owner.id, name: `route-${randomUUID().slice(0, 8)}`,
    targetServerSlug: target.slug, invitedPeople: [`@${owner.name}`] });
  return { owner, server, hostLocal: created.channel, canonicalChannelId: created.jointChannel.canonicalChannelId };
}

test("a joint channel's host projection stores in the canonical channel", async ({ seed }) => {
  const f = await seedJoint(seed);
  assert.notEqual(f.hostLocal.id, f.canonicalChannelId, "fixture: the host projection is not the canonical row");
  assert.equal(await getDb().transaction((tx) => lockAndResolveMessageStorage(tx, f.hostLocal.id)), f.canonicalChannelId);
  // The canonical row itself is storage.
  assert.equal(await getDb().transaction((tx) => lockAndResolveMessageStorage(tx, f.canonicalChannelId)), f.canonicalChannelId);
});

test("a joint thread's local projection stores in its canonical thread", async ({ seed }) => {
  const f = await seedJoint(seed);
  const db = getDb();
  const [canonical] = await db.select().from(channels).where(eq(channels.id, f.canonicalChannelId));
  const root = await createMessage(f.canonicalChannelId, "user", f.owner.id, "joint root");
  const [canonicalThread, localThread] = await db.insert(channels).values([
    { serverId: canonical!.serverId, name: `thread-${root.id.slice(0, 8)}`, type: "thread", parentMessageId: root.id },
    // A local thread projection has no parent fields, by design.
    { serverId: f.server.id, name: `thread-${root.id.slice(0, 8)}`, type: "thread", parentMessageId: null },
  ]).returning();
  await db.update(messages).set({ threadId: canonicalThread!.id }).where(eq(messages.id, root.id));
  const [jointThread] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread!.id, createdByServerId: f.server.id, createdByUserId: f.owner.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: jointThread!.id, serverId: f.server.id, localChannelId: localThread!.id,
    role: "host", status: "active", joinedByUserId: f.owner.id,
  });
  assert.equal(await db.transaction((tx) => lockAndResolveMessageStorage(tx, localThread!.id)), canonicalThread!.id);
});

// Task creation re-resolves the storage of the channel the request came
// through under its row lock; a storage id the caller resolved that no longer
// matches is refused as a changed channel, not written to.
test("task creation refuses a storage channel that is not the local channel's storage under the lock", async ({ seed }) => {
  const f = await seedJoint(seed);
  const other = await seed.channel({ server: f.server, members: [f.owner] });
  await assert.rejects(
    createTasks(other.id, "user", f.owner.id, [{ title: "stale route" }], { localChannelId: f.hostLocal.id }),
    (error: unknown) => error instanceof TaskMutationConflictError,
  );
  // The matching pair (an ordinary channel is its own storage) creates.
  const created = await createTasks(other.id, "user", f.owner.id, [{ title: "fresh route" }], { localChannelId: other.id });
  assert.equal(created.tasks.length, 1);
});
