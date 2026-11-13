import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { agentChannelReadCursors, agents, channels, messageMentions, messages, servers, users } from "../db/schema";
import { owedReadBacklogTargets, readPositionLatestTargets, settleUnowedReadBacklog } from "./unowedReadBacklog";
import { TurnEndUnreadSnapshots, snapshotForUnreadSummary } from "./turnEndUnreadSnapshot";
import { capAgentUnreadSummary, getAgentUnreadCounts, getAgentUnreadSummaryTargets, type AgentInboxChainRow } from "./channelService";

test("a completed first turn's snapshot: settles what the agent owes nothing in, never past the snapshot", async ({ db }) => {
  const [user] = await db.insert(users).values({ email: "unowed@example.com", name: "unowed", passwordHash: "x", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Unowed", slug: "unowed-backlog", ownerId: user.id }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id, name: "reader", status: "active", runtime: "claude", model: "sonnet",
    creatorType: "user", creatorId: user.id,
  }).returning();
  const [busy, noCursor, mentioned, tasked, dm] = await db.insert(channels).values([
    { serverId: server.id, name: "busy", type: "channel" },
    { serverId: server.id, name: "no-cursor", type: "channel" },
    { serverId: server.id, name: "mentioned", type: "channel" },
    { serverId: server.id, name: "tasked", type: "channel" },
    { serverId: server.id, name: "dm", type: "dm" },
  ]).returning();
  const post = async (channelId: string, extra: Partial<typeof messages.$inferInsert> = {}) =>
    (await db.insert(messages).values({ channelId, senderType: "user", senderId: user.id, content: "m", ...extra }).returning())[0]!;
  const readThrough = (channelId: string, seq: number) =>
    db.insert(agentChannelReadCursors).values({ agentId: agent.id, channelId, lastReadSeq: seq });
  const cursorOf = async (channelId: string) =>
    (await db.select({ seq: agentChannelReadCursors.lastReadSeq }).from(agentChannelReadCursors)
      .where(and(eq(agentChannelReadCursors.agentId, agent.id), eq(agentChannelReadCursors.channelId, channelId))))[0]?.seq ?? null;

  const busyRead = await post(busy.id);
  await post(busy.id);
  const busySnapshot = await post(busy.id);
  const busyDuringTurn = await post(busy.id);
  await readThrough(busy.id, busyRead.seq);

  await post(noCursor.id);
  const noCursorSnapshot = await post(noCursor.id);

  const mentionedRead = await post(mentioned.id);
  const mention = await post(mentioned.id);
  await db.insert(messageMentions).values({
    messageId: mention.id, serverId: server.id, channelId: mentioned.id, messageSeq: mention.seq,
    targetType: "agent", targetId: agent.id, handleAtSendTime: "reader",
  });
  await readThrough(mentioned.id, mentionedRead.seq);

  const taskedRead = await post(tasked.id);
  const task = await post(tasked.id, { taskAssigneeType: "agent", taskAssigneeId: agent.id });
  await readThrough(tasked.id, taskedRead.seq);

  const dmRead = await post(dm.id);
  const dmSnapshot = await post(dm.id);
  await readThrough(dm.id, dmRead.seq);

  const settled = await settleUnowedReadBacklog(db, agent.id, [
    { channelId: busy.id, throughSeq: busySnapshot.seq },
    { channelId: noCursor.id, throughSeq: noCursorSnapshot.seq },
    { channelId: mentioned.id, throughSeq: mention.seq },
    { channelId: tasked.id, throughSeq: task.seq },
    { channelId: dm.id, throughSeq: dmSnapshot.seq },
  ]);
  assert.equal(await cursorOf(busy.id), busySnapshot.seq, "settled through the snapshot, not the message that came during the turn");
  assert.ok(busyDuringTurn.seq > busySnapshot.seq);
  assert.equal(await cursorOf(noCursor.id), noCursorSnapshot.seq, "a conversation with no read position yet gets one");
  assert.equal(await cursorOf(mentioned.id), mentionedRead.seq, "an unread @mention keeps it unread");
  assert.equal(await cursorOf(tasked.id), taskedRead.seq, "an unread task assigned to the agent keeps it unread");
  assert.equal(await cursorOf(dm.id), dmRead.seq, "a DM stays unread");
  assert.deepEqual(settled, { conversations: 2, messages: 4, keptConversations: 3 });

  // Raise-only: a stale (lower) target never moves a position back.
  assert.deepEqual(await settleUnowedReadBacklog(db, agent.id, [{ channelId: busy.id, throughSeq: busyRead.seq }]), { conversations: 0, messages: 0, keptConversations: 0 });
  assert.equal(await cursorOf(busy.id), busySnapshot.seq);

  // The migration form: every position the agent has, through its latest message.
  const latest = new Map((await readPositionLatestTargets(db, agent.id)).map((target) => [target.channelId, target.throughSeq]));
  assert.equal(latest.get(busy.id), busyDuringTurn.seq);
});

test("what the agent owes past its read position: a DM, an unread @mention, an unread task; never what it already read, never plain channel traffic", async ({ db }) => {
  const [user] = await db.insert(users).values({ email: "owed@example.com", name: "owed", passwordHash: "x", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Owed", slug: "owed-backlog", ownerId: user.id }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id, name: "owner", status: "active", runtime: "claude", model: "sonnet",
    creatorType: "user", creatorId: user.id,
  }).returning();
  const [plain, mentioned, tasked, dm, dmRead, mentionRead] = await db.insert(channels).values([
    { serverId: server.id, name: "plain", type: "channel" },
    { serverId: server.id, name: "mentioned", type: "channel" },
    { serverId: server.id, name: "tasked", type: "channel" },
    { serverId: server.id, name: "dm", type: "dm" },
    { serverId: server.id, name: "dm-read", type: "dm" },
    { serverId: server.id, name: "mention-read", type: "channel" },
  ]).returning();
  const post = async (channelId: string, extra: Partial<typeof messages.$inferInsert> = {}) =>
    (await db.insert(messages).values({ channelId, senderType: "user", senderId: user.id, content: "m", ...extra }).returning())[0]!;
  const mentionOf = (message: typeof messages.$inferSelect, channelId: string) => db.insert(messageMentions).values({
    messageId: message.id, serverId: server.id, channelId, messageSeq: message.seq,
    targetType: "agent", targetId: agent.id, handleAtSendTime: "owner",
  });
  const readThrough = (channelId: string, seq: number) =>
    db.insert(agentChannelReadCursors).values({ agentId: agent.id, channelId, lastReadSeq: seq });

  const plainLatest = await post(plain.id);
  await post(mentioned.id);
  const mention = await post(mentioned.id);
  await mentionOf(mention, mentioned.id);
  const task = await post(tasked.id, { taskAssigneeType: "agent", taskAssigneeId: agent.id });
  const dmLatest = await post(dm.id);
  // Read (shown to the model, `raft message check`, or replied after): the read position is past it.
  const dmReadLatest = await post(dmRead.id);
  await readThrough(dmRead.id, dmReadLatest.seq);
  const readMention = await post(mentionRead.id);
  await mentionOf(readMention, mentionRead.id);
  await readThrough(mentionRead.id, readMention.seq);

  const owed = await owedReadBacklogTargets(db, agent.id, [
    { channelId: plain.id, throughSeq: plainLatest.seq },
    { channelId: mentioned.id, throughSeq: mention.seq },
    { channelId: tasked.id, throughSeq: task.seq },
    { channelId: dm.id, throughSeq: dmLatest.seq },
    { channelId: dmRead.id, throughSeq: dmReadLatest.seq },
    { channelId: mentionRead.id, throughSeq: readMention.seq },
  ]);
  assert.deepEqual(new Set(owed), new Set([mentioned.id, tasked.id, dm.id]));
  // A mention beyond the through seq (the part the agent is offered) is not counted.
  assert.deepEqual(await owedReadBacklogTargets(db, agent.id, [{ channelId: mentioned.id, throughSeq: mention.seq - 1 }]), []);
  assert.deepEqual(await owedReadBacklogTargets(db, agent.id, []), [], "nothing to read, no query");
  // The ready wake's time floor: only what was created since counts.
  const all = [
    { channelId: mentioned.id, throughSeq: mention.seq },
    { channelId: tasked.id, throughSeq: task.seq },
    { channelId: dm.id, throughSeq: dmLatest.seq },
  ];
  assert.deepEqual(new Set(await owedReadBacklogTargets(db, agent.id, all, { createdSince: new Date(Date.now() - 60 * 60_000) })), new Set([mentioned.id, tasked.id, dm.id]));
  assert.deepEqual(await owedReadBacklogTargets(db, agent.id, all, { createdSince: new Date(Date.now() + 60 * 60_000) }), [], "nothing that old is owed");
  // Reads only: no read position moved.
  assert.equal((await db.select().from(agentChannelReadCursors).where(eq(agentChannelReadCursors.agentId, agent.id))).length, 2);
});

test("only the launch's first turn end consumes the snapshot, only completed settles, and the daemon cannot widen it", () => {
  let now = 1_000;
  const snapshots = new TurnEndUnreadSnapshots(() => now, 10_000);
  const targets = new Map([
    ["#busy", [{ channelId: "c-busy", latestSeq: 30 }]],
    ["#quiet", [{ channelId: "c-quiet", latestSeq: 12 }]],
  ]);

  snapshots.record("a1", "launch-1", targets);
  assert.deepEqual(snapshots.take("a1", { launchId: "launch-0", outcome: "completed", shownUnreadTargets: ["#busy"] }), { kind: "stale_launch" });
  const settled = snapshots.take("a1", { launchId: "launch-1", outcome: "completed", shownUnreadTargets: ["#busy", "#elsewhere", "#busy"] });
  assert.deepEqual(settled, { kind: "settle", targets: [{ channelId: "c-busy", throughSeq: 30 }], shownCount: 3, ignoredCount: 1 });
  assert.deepEqual(snapshots.take("a1", { launchId: "launch-1", outcome: "completed", shownUnreadTargets: ["#busy"] }), { kind: "no_snapshot" }, "consumed once");

  snapshots.record("a1", "launch-2", targets);
  assert.deepEqual(snapshots.take("a1", { launchId: "launch-2", outcome: "interrupted", shownUnreadTargets: ["#busy"] }), { kind: "not_completed" });
  assert.deepEqual(snapshots.take("a1", { launchId: "launch-2", outcome: "completed", shownUnreadTargets: ["#busy"] }), { kind: "no_snapshot" }, "an interrupted first turn discards it");

  snapshots.record("a1", "launch-3", targets);
  snapshots.record("a1", "launch-4", new Map());
  assert.deepEqual(snapshots.take("a1", { launchId: "launch-3", outcome: "completed", shownUnreadTargets: ["#busy"] }), { kind: "no_snapshot" }, "a new start without a summary clears the old one");

  snapshots.record("a1", "launch-5", targets);
  now += 20_000;
  assert.deepEqual(snapshots.take("a1", { launchId: "launch-5", outcome: "completed", shownUnreadTargets: ["#busy"] }), { kind: "expired" });
});

test("the start snapshot names exactly the targets the capped summary shows, with their latest seq", async () => {
  const row = (index: number, extra: Partial<AgentInboxChainRow> = {}): AgentInboxChainRow => ({
    targetId: `c-${index}`, storageChannelId: `c-${index}`, kind: "channel", serverId: "s", channelName: `ch${index}`, channelType: "channel",
    parentMessageId: null, parentChannelId: null, parentChannelName: null, parentChannelType: null,
    lastReadSeq: 0, unreadCount: index + 1, firstUnreadSeq: 1, latestSeq: 100 + index, mentionUnread: 0, maxMentionSeq: null,
    subscribed: true, offeredUnread: index + 1, activitySeq: 100 + index, joinedAt: new Date(0), ...extra,
  });
  const chain = [...Array.from({ length: 25 }, (_, index) => row(index)), row(99, { offeredUnread: 0 })];
  const counts = await getAgentUnreadCounts("agent-x", chain);
  const targets = await getAgentUnreadSummaryTargets("agent-x", chain);
  assert.deepEqual([...targets.keys()].sort(), Object.keys(counts).sort(), "same targets as the counts the start shows");
  const summary = capAgentUnreadSummary(counts);
  const snapshot = snapshotForUnreadSummary(targets, summary);
  assert.equal(snapshot.size, Object.keys(summary).length - 1, "every named target, not the folded 'more' line");
  assert.deepEqual(snapshot.get("#ch24"), [{ channelId: "c-24", latestSeq: 124 }]);
  assert.equal(snapshot.has("#ch0"), false, "a target folded away by the cap is not in the snapshot");
});
