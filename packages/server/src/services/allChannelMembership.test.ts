import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { channelHumans, channels, messageMentions, messages, serverMembers, userChannelReadCursors, users } from "../db/schema";
import { ServerMemberRoleTransitionError, addMember, createServer, removeMember, transitionMemberRole } from "./serverService";
import { createChannel, updateChannel } from "./channelService";
import { seedBoundGuest } from "../test/guestFixture";
import { runBackfill, verifyBackfill, type Queryable } from "../../scripts/backfill-all-channel-members";
import { revealAllChannelForTest } from "../test/allChannelFixture";

// #all's audience is the server's members (#3054); both inbox read paths build
// subscriptions from channel_humans, so every non-guest member needs a row in an
// enabled #all (#triage:64b44a12).

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user!;
}

async function allChannelOf(serverId: string) {
  const [channel] = await getDb().select().from(channels).where(and(eq(channels.serverId, serverId), eq(channels.name, "all")));
  return channel!;
}

async function allRowUserIds(serverId: string): Promise<string[]> {
  const channel = await allChannelOf(serverId);
  const rows = await getDb().select({ userId: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, channel.id));
  return rows.map((row) => row.userId).sort();
}

async function readPosition(userId: string, channelId: string): Promise<number | null> {
  const [row] = await getDb().select({ seq: userChannelReadCursors.lastReadSeq }).from(userChannelReadCursors)
    .where(and(eq(userChannelReadCursors.userId, userId), eq(userChannelReadCursors.channelId, channelId)));
  return row?.seq ?? null;
}

async function post(channelId: string, senderId: string, content = "hello", createdAt?: Date) {
  const [message] = await getDb().insert(messages).values({
    channelId, senderType: "user", senderId, content, ...(createdAt ? { createdAt } : {}),
  }).returning();
  return message!;
}

test("the owner and every non-guest member who joins get a row in an enabled #all; guests never", async ({ app: _app }) => {
  const owner = await seedUser("all-owner");
  const member = await seedUser("all-member");
  const guest = await seedUser("all-guest");
  const server = await createServer("All Rows", `all-rows-${randomUUID()}`, owner.id);
  await revealAllChannelForTest(server.id);
  assert.deepEqual(await allRowUserIds(server.id), [owner.id]);

  const all = await allChannelOf(server.id);
  const earlier = await post(all.id, owner.id, "before the member joined");
  await addMember(server.id, member.id);
  // A Guest joins bound to its one channel, as an accepted external invite adds it (#wg-rbac:#15).
  const home = await createChannel(server.id, `all-guest-home-${randomUUID().slice(0, 8)}`, undefined, "private");
  await addMember(server.id, guest.id, "guest", { guestChannelId: home.id });
  assert.deepEqual(await allRowUserIds(server.id), [owner.id, member.id].sort());
  assert.equal(await readPosition(member.id, all.id), earlier.seq, "a join starts at the latest message, like any channel");
});

test("guest promotion adds the row, a refused demotion keeps it, leaving removes it", async ({ app: _app }) => {
  const owner = await seedUser("all-promo-owner");
  const guest = await seedUser("all-promo-guest");
  const server = await createServer("All Promo", `all-promo-${randomUUID()}`, owner.id);
  await revealAllChannelForTest(server.id);
  const home = await createChannel(server.id, `all-promo-home-${randomUUID().slice(0, 8)}`, undefined, "private");
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: home.id });
  assert.deepEqual(await allRowUserIds(server.id), [owner.id]);

  await transitionMemberRole({ serverId: server.id, actorUserId: owner.id, targetUserId: guest.id, nextRole: "member"});
  assert.deepEqual(await allRowUserIds(server.id), [owner.id, guest.id].sort());

  // No one is made a Guest (#wg-rbac:#15): the demotion is refused and the row stays.
  await assert.rejects(
    transitionMemberRole({ serverId: server.id, actorUserId: owner.id, targetUserId: guest.id, nextRole: "guest" }),
    (error: unknown) => error instanceof ServerMemberRoleTransitionError && error.code === "transition_forbidden",
  );
  assert.deepEqual(await allRowUserIds(server.id), [owner.id, guest.id].sort());

  await removeMember(server.id, guest.id, { reason: "removed", actorUserId: owner.id });
  assert.deepEqual(await allRowUserIds(server.id), [owner.id]);
});

test("a hidden #all keeps no rows; restoring it gives every member theirs back", async ({ app: _app }) => {
  const owner = await seedUser("all-hide-owner");
  const member = await seedUser("all-hide-member");
  const server = await createServer("All Hide", `all-hide-${randomUUID()}`, owner.id);
  await revealAllChannelForTest(server.id);
  const all = await allChannelOf(server.id);

  await updateChannel(all.id, { type: "private" });
  assert.deepEqual(await allRowUserIds(server.id), [], "hiding deletes the rows");
  await addMember(server.id, member.id);
  assert.deepEqual(await allRowUserIds(server.id), [], "no row while #all is hidden");

  await updateChannel(all.id, { type: "channel" });
  assert.deepEqual(await allRowUserIds(server.id), [owner.id, member.id].sort());
});

test("the backfill adds the missing rows with everything read, never moving anyone back to unread; guests skipped", async ({ app: _app }) => {
  const db = getDb();
  const owner = await seedUser("bf-owner");
  const server = await createServer("Backfill", `bf-${randomUUID()}`, owner.id);
  await revealAllChannelForTest(server.id);
  const all = await allChannelOf(server.id);
  // Members who joined before the hook existed: a server_members row and no #all row.
  const [hadPosition, noPosition, recentMention, oldMention] = await Promise.all(
    ["bf-had", "bf-none", "bf-recent", "bf-old"].map(seedUser),
  );
  const guest = await seedUser("bf-guest");
  await db.insert(serverMembers).values([
    ...[hadPosition, noPosition, recentMention, oldMention].map((user) => ({ serverId: server.id, userId: user!.id, role: "member" as const })),
  ]);
  await seedBoundGuest({ serverId: server.id, userId: guest.id }, db);

  const first = await post(all.id, owner.id, "old history");
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const oldMentionMessage = await post(all.id, owner.id, "@old ping", longAgo);
  const recentMentionMessage = await post(all.id, owner.id, "@recent ping");
  const after1 = await post(all.id, owner.id, "chatter 1");
  const latest = await post(all.id, owner.id, "chatter 2");
  await db.insert(messageMentions).values([
    { messageId: oldMentionMessage.id, messageSeq: oldMentionMessage.seq, serverId: server.id, channelId: all.id, targetType: "user", targetId: oldMention!.id, handleAtSendTime: "old" },
    { messageId: recentMentionMessage.id, messageSeq: recentMentionMessage.seq, serverId: server.id, channelId: all.id, targetType: "user", targetId: recentMention!.id, handleAtSendTime: "recent" },
  ]);
  await db.insert(userChannelReadCursors).values({ userId: hadPosition!.id, channelId: all.id, lastReadSeq: first.seq });

  const client = (db as unknown as { $client: Queryable }).$client;
  const preview = await runBackfill(client, { apply: false, batch: 50, servers: null });
  assert.equal(preview.groups.had_position.people, 1);
  assert.equal(preview.groups.no_position.people, 3);
  assert.equal(preview.groups.had_position.addedUnread, 0n, "an existing position is raised to the latest: no backlog");
  assert.equal(preview.groups.no_position.addedUnread, 0n, "even a recent unread mention is marked read (tygg)");
  assert.equal(preview.rowsAdded, 0, "a preview writes nothing");
  assert.equal((await allRowUserIds(server.id)).length, 1);

  const applied = await runBackfill(client, { apply: true, batch: 50, servers: null });
  assert.equal(applied.rowsAdded, 4);
  assert.deepEqual(await allRowUserIds(server.id), [owner.id, hadPosition!.id, noPosition!.id, recentMention!.id, oldMention!.id].sort());
  assert.equal(await readPosition(hadPosition!.id, all.id), latest.seq);
  assert.equal(await readPosition(noPosition!.id, all.id), latest.seq);
  assert.equal(await readPosition(oldMention!.id, all.id), latest.seq);
  assert.equal(await readPosition(recentMention!.id, all.id), latest.seq, "a recent unread mention does not hold the position back");
  assert.ok(after1.seq > recentMentionMessage.seq);
  const [row] = await db.select({ joinedAt: channelHumans.joinedAt }).from(channelHumans)
    .where(and(eq(channelHumans.channelId, all.id), eq(channelHumans.userId, recentMention!.id)));
  assert.equal(row!.joinedAt.getTime(), all.createdAt.getTime(), "joined_at predates every #all message");

  assert.deepEqual(await verifyBackfill(client), { missing: 0, stray: 0 });
  const again = await runBackfill(client, { apply: true, batch: 50, servers: null });
  assert.equal(again.rowsAdded, 0, "a re-run changes nothing");
});
