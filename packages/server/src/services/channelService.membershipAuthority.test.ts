import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channels, jointChannels, jointChannelServers, messages, users } from "../db/schema";
import { createServer } from "./serverService";
import { getChannelMembershipAuthorityChannelId } from "./channelService";

// #bug-triage task #29: a joint thread's local projection has no
// parent_message_id by design, so the membership authority used by action
// cards and mention actions resolved to null and every action card in a joint
// thread was refused (403). It must be this server's projection of the parent.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("membership authority of a thread is its local parent channel, joint thread projections included", async ({ app }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `membership-authority-${randomUUID()}@slock.test`,
    name: "membership-authority-owner",
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const server = await createServer("Authority", `authority-${randomUUID()}`, owner.id);
  const storageServer = await createServer("Authority Storage", `authority-storage-${randomUUID()}`, owner.id);

  // Ordinary thread on a local channel.
  const [ordinary] = await db.insert(channels).values({ serverId: server.id, name: "ordinary", type: "channel" }).returning();
  const [ordinaryParent] = await db.insert(messages).values({
    channelId: ordinary.id, senderType: "user", senderId: owner.id, content: "ordinary parent",
  }).returning();
  const [ordinaryThread] = await db.insert(channels).values({
    serverId: server.id, name: "ordinary-thread", type: "thread", parentMessageId: ordinaryParent.id,
  }).returning();

  // Joint channel: canonical storage channel plus this server's local projection.
  const [jointLocal, jointCanonical] = await db.insert(channels).values([
    { serverId: server.id, name: "joint-local", type: "joint" },
    { serverId: storageServer.id, name: "joint-canonical", type: "channel" },
  ]).returning();
  const [parentJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: jointCanonical.id, createdByServerId: server.id, createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: parentJoint.id, serverId: server.id, localChannelId: jointLocal.id, role: "host", joinedByUserId: owner.id,
  });

  // Joint thread: canonical thread carries the parent message; the local projection carries none.
  const [jointParentMessage] = await db.insert(messages).values({
    channelId: jointCanonical.id, senderType: "user", senderId: owner.id, content: "joint parent",
  }).returning();
  const [localThread, canonicalThread, unmappedThread] = await db.insert(channels).values([
    { serverId: server.id, name: "joint-thread-local", type: "thread" },
    { serverId: storageServer.id, name: "joint-thread-canonical", type: "thread", parentMessageId: jointParentMessage.id },
    { serverId: server.id, name: "unmapped-thread", type: "thread" },
  ]).returning();
  // As in live data, the parent message names its canonical thread.
  await db.update(messages).set({ threadId: canonicalThread.id }).where(eq(messages.id, jointParentMessage.id));
  const [threadJoint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id, createdByServerId: server.id, createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: threadJoint.id, serverId: server.id, localChannelId: localThread.id, role: "host", joinedByUserId: owner.id,
  });

  assert.equal(await getChannelMembershipAuthorityChannelId(ordinary.id), ordinary.id, "a channel is its own authority");
  assert.equal(await getChannelMembershipAuthorityChannelId(ordinaryThread.id), ordinary.id, "an ordinary thread uses its parent channel");
  assert.equal(
    await getChannelMembershipAuthorityChannelId(localThread.id),
    jointLocal.id,
    "a joint thread projection uses this server's projection of the parent joint channel",
  );
  assert.ok(await getChannelMembershipAuthorityChannelId(unmappedThread.id) === null, "a thread with no parent and no projection fails closed");
});
