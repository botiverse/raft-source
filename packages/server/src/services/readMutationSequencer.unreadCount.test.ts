import { fillJointMembersFromChannelHumans } from "../test/jointMemberFill";
import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index";
import {
  channelHumans,
  channels,
  jointChannels,
  jointChannelServers,
  messages,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import {
  admitReadMutation,
  claimNextReadMutation,
  executeReadMutationClaim,
  READ_ACK_UNREAD_COUNT_CAP,
  type ReadMutationAdmissionInput,
} from "./readMutationSequencer";

// Read-state acks carry the unread left after the write so clients can update
// counts they cannot project from loaded messages (#bug-triage task #9).

async function seedReader() {
  const db = getDb();
  const [reader, other] = await db.insert(users).values([
    { email: `unread-reader-${randomUUID()}@test.invalid`, name: `Reader${randomUUID().slice(0, 8)}`, passwordHash: "x", emailVerified: true },
    { email: `unread-other-${randomUUID()}@test.invalid`, name: `Other${randomUUID().slice(0, 8)}`, passwordHash: "x", emailVerified: true },
  ]).returning();
  const [server] = await db.insert(servers).values({
    name: "Unread Count",
    slug: `unread-count-${randomUUID()}`,
    ownerId: reader.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: reader.id, role: "owner" });
  return { reader, other, server };
}

async function apply(serverId: string, principalId: string, mutation: ReadMutationAdmissionInput["mutation"], mutationId = randomUUID()) {
  await admitReadMutation({ serverId, principalId, mutationId, mutation });
  const claim = await claimNextReadMutation({ serverId, principalId, leaseOwner: "unread-test", leaseMs: 60_000 });
  assert.ok(claim, "expected a claimable mutation");
  return { ack: await executeReadMutationClaim({ claim }), mutationId };
}

test("row read counts others' messages left past the cursor; read to latest leaves 0", async ({ db: _db }) => {
  const db = getDb();
  const { reader, other, server } = await seedReader();
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: "unread-row", type: "channel" }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: reader.id });
  await db.insert(messages).values([
    { channelId: channel.id, senderType: "user", senderId: other.id, content: "1", seq: 1 },
    { channelId: channel.id, senderType: "user", senderId: other.id, content: "2", seq: 2 },
    { channelId: channel.id, senderType: "user", senderId: reader.id, content: "own", seq: 3 },
    { channelId: channel.id, senderType: "user", senderId: other.id, content: "4", seq: 4 },
  ]);

  const partial = await apply(server.id, reader.id, { kind: "row_read", scopeId: channel.id, throughSeq: 1 });
  assert.equal(partial.ack.scopes[0]?.maxReadSeq, 1);
  assert.equal(partial.ack.scopes[0]?.unreadCount, 2, "seq 2 and 4; the reader's own seq 3 is not unread");

  const latest = await apply(server.id, reader.id, { kind: "row_read", scopeId: channel.id, throughSeq: 4 });
  assert.equal(latest.ack.scopes[0]?.unreadCount, 0);

  // An older read changes nothing, but still reports the current remainder.
  const stale = await apply(server.id, reader.id, { kind: "row_read", scopeId: channel.id, throughSeq: 2 });
  assert.equal(stale.ack.scopes[0]?.changed, false);
  assert.equal(stale.ack.scopes[0]?.maxReadSeq, 4);
  assert.equal(stale.ack.scopes[0]?.unreadCount, 0);
});

test("row read on a joint thread counts the canonical thread's messages", async ({ db: _db }) => {
  const db = getDb();
  const { reader, other, server } = await seedReader();
  const [canonicalParent, localParent] = await db.insert(channels).values([
    { serverId: server.id, name: `unread-joint-storage-${randomUUID()}`, type: "joint" },
    { serverId: server.id, name: `unread-joint-local-${randomUUID()}`, type: "joint" },
  ]).returning();
  await db.insert(channelHumans).values({ channelId: localParent.id, userId: reader.id });
  const [jointParent] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalParent.id,
    createdByServerId: server.id,
    createdByUserId: reader.id,
    status: "active",
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: jointParent.id, serverId: server.id, localChannelId: localParent.id, role: "host", status: "active",
  });
  await fillJointMembersFromChannelHumans();
  const [parentMessage] = await db.insert(messages).values({
    channelId: canonicalParent.id, senderType: "user", senderId: other.id, content: "parent", seq: 10,
  }).returning();
  const [canonicalThread, localThread] = await db.insert(channels).values([
    { serverId: server.id, name: `unread-joint-thread-storage-${randomUUID()}`, type: "thread", parentMessageId: parentMessage.id },
    { serverId: server.id, name: `unread-joint-thread-local-${randomUUID()}`, type: "thread" },
  ]).returning();
  const [jointThread] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: server.id,
    createdByUserId: reader.id,
    status: "active",
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: jointThread.id, serverId: server.id, localChannelId: localThread.id, role: "host", status: "active",
  });
  await fillJointMembersFromChannelHumans();
  await db.insert(messages).values([
    { channelId: canonicalThread.id, senderType: "user", senderId: other.id, content: "r1", seq: 11 },
    { channelId: canonicalThread.id, senderType: "user", senderId: other.id, content: "r2", seq: 12 },
    { channelId: canonicalThread.id, senderType: "user", senderId: other.id, content: "r3", seq: 13 },
  ]);

  const { ack } = await apply(server.id, reader.id, { kind: "row_read", scopeId: localThread.id, throughSeq: 11 });
  assert.equal(ack.scopes[0]?.scopeId, localThread.id);
  assert.equal(ack.scopes[0]?.unreadCount, 2);
});

test("channel and global read-all report 0 unread for every scope", async ({ db: _db }) => {
  const db = getDb();
  const { reader, other, server } = await seedReader();
  const [a, b] = await db.insert(channels).values([
    { serverId: server.id, name: "unread-all-a", type: "channel" },
    { serverId: server.id, name: "unread-all-b", type: "channel" },
  ]).returning();
  await db.insert(channelHumans).values([
    { channelId: a.id, userId: reader.id },
    { channelId: b.id, userId: reader.id },
  ]);
  await db.insert(messages).values([
    { channelId: a.id, senderType: "user", senderId: other.id, content: "a1", seq: 1 },
    { channelId: a.id, senderType: "user", senderId: other.id, content: "a2", seq: 2 },
    { channelId: b.id, senderType: "user", senderId: other.id, content: "b1", seq: 1 },
  ]);

  const channelAll = await apply(server.id, reader.id, { kind: "channel_read_all", scopeId: a.id });
  assert.deepEqual(channelAll.ack.scopes.map((scope) => [scope.scopeId, scope.unreadCount]), [[a.id, 0]]);

  await db.insert(messages).values({ channelId: a.id, senderType: "user", senderId: other.id, content: "a3", seq: 3 });
  const globalAll = await apply(server.id, reader.id, { kind: "global_read_all" });
  assert.ok(globalAll.ack.scopes.length >= 2);
  for (const scope of globalAll.ack.scopes) assert.equal(scope.unreadCount, 0, scope.scopeId);
});

test("exact replay returns the stored ack with the same unread count", async ({ db: _db }) => {
  const db = getDb();
  const { reader, other, server } = await seedReader();
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: "unread-replay", type: "channel" }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: reader.id });
  await db.insert(messages).values([
    { channelId: channel.id, senderType: "user", senderId: other.id, content: "1", seq: 1 },
    { channelId: channel.id, senderType: "user", senderId: other.id, content: "2", seq: 2 },
  ]);
  const mutation = { kind: "row_read" as const, scopeId: channel.id, throughSeq: 1 };
  const { ack, mutationId } = await apply(server.id, reader.id, mutation);
  assert.equal(ack.scopes[0]?.unreadCount, 1);

  // A newer message must not change what the replay hands back.
  await db.insert(messages).values({ channelId: channel.id, senderType: "user", senderId: other.id, content: "3", seq: 3 });
  const replay = await admitReadMutation({ serverId: server.id, principalId: reader.id, mutationId, mutation });
  assert.equal(replay.outcome, "ALREADY_TERMINAL");
  const replayScopes = (replay.ack as { scopes?: Array<{ unreadCount?: number }> } | null)?.scopes;
  assert.equal(replayScopes?.[0]?.unreadCount, 1);
  assert.equal(replay.terminalDigest, ack.terminalDigest);
});

test("a row read that reaches the count cap reports the count as unknown", async ({ db: _db }) => {
  const db = getDb();
  const { reader, other, server } = await seedReader();
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: "unread-cap", type: "channel" }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: reader.id });
  const total = READ_ACK_UNREAD_COUNT_CAP + 2;
  await db.insert(messages).values(Array.from({ length: total }, (_, index) => ({
    channelId: channel.id, senderType: "user" as const, senderId: other.id, content: `m${index + 1}`, seq: index + 1,
  })));

  const behind = await apply(server.id, reader.id, { kind: "row_read", scopeId: channel.id, throughSeq: 1 });
  assert.equal(behind.ack.scopes[0]?.maxReadSeq, 1);
  assert.equal("unreadCount" in (behind.ack.scopes[0] ?? {}), false, "at the cap the count is omitted, not truncated");

  const under = await apply(server.id, reader.id, { kind: "row_read", scopeId: channel.id, throughSeq: 3 });
  assert.equal(under.ack.scopes[0]?.unreadCount, READ_ACK_UNREAD_COUNT_CAP - 1);
});
