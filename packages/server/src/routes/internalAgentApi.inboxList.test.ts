import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { EXTERNAL_AGENT_RUNTIME_ID, EXTERNAL_AGENT_RUNTIME_MODEL } from "@botiverse/raft-shared";

import { apiTest as test } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agentChannelReadCursors, channelAgents, channels, messageMentions, jointChannels, jointChannelServers, messages, servers, threadFollows, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import {
  __testRisingWaveInbox,
  addAgent,
  addHuman,
  createChannel,
  findOrCreateDM,
  getOrCreateThread,
  markAgentLegacyRead,
  type AgentInboxChainRow,
} from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { __resetExternalTurnEndSnapshotsForTests } from "../services/externalTurnEndSnapshot";

// `raft inbox check` reads the agent's offered conversations from the agent
// inbox view of the unified chain (RisingWave rw_agent_inbox_v7, which holds only
// offered rows). The view read is stubbed through the RW test seam, answering
// the page / totals / DM queries over the given rows as the view would;
// everything else (targets, latest sender) is real Postgres.

afterEach(() => {
  __testRisingWaveInbox.reset();
});

function stubChain(rows: AgentInboxChainRow[]): void {
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, text: string, values: unknown[] = []) => {
      assert.match(text, /FROM rw_agent_inbox_v7\s+WHERE agent_id = \$1/);
      const param = (pattern: RegExp) => {
        const match = text.match(pattern);
        return match ? values[Number(match[1]) - 1] : undefined;
      };
      if (/count\(\*\)/.test(text)) {
        assert.equal(values.length, 1);
        return {
          result: {
            rows: [{
              conversations: String(rows.length),
              dms: String(rows.filter((row) => row.kind === "dm").length),
              mentions: String(rows.filter((row) => row.mentionUnread > 0).length),
            }],
          },
        };
      }
      let selected = rows;
      const kind = param(/kind = \$(\d+)/);
      if (kind !== undefined) selected = selected.filter((row) => row.kind === kind);
      const beforeSeq = param(/activity_seq < \$(\d+)/);
      if (beforeSeq !== undefined) selected = selected.filter((row) => row.activitySeq < Number(beforeSeq));
      if (/mention_unread > 0/.test(text)) selected = selected.filter((row) => row.mentionUnread > 0);
      // RisingWave rejects a bind parameter after LIMIT ("expects an integer
      // ... after LIMIT, but found non-const expression"): the fake does too.
      assert.doesNotMatch(text, /LIMIT \$\d+/, "RisingWave only accepts a constant LIMIT");
      const limit = text.match(/LIMIT (\d+)/)?.[1];
      if (limit !== undefined) {
        assert.match(text, /ORDER BY activity_seq DESC/);
        selected = [...selected].sort((a, b) => b.activitySeq - a.activitySeq).slice(0, Number(limit));
      }
      return {
        result: {
          rows: selected.map((row) => ({
            target_id: row.targetId,
            storage_channel_id: row.storageChannelId,
            kind: row.kind,
            server_id: row.serverId,
            channel_name: row.channelName,
            channel_type: row.channelType,
            parent_message_id: row.parentMessageId,
            parent_channel_id: row.parentChannelId,
            parent_channel_name: row.parentChannelName,
            parent_channel_type: row.parentChannelType,
            last_read_seq: String(row.lastReadSeq),
            unread_count: String(row.unreadCount),
            first_unread_seq: row.firstUnreadSeq === null ? null : String(row.firstUnreadSeq),
            latest_seq: row.latestSeq === null ? null : String(row.latestSeq),
            mention_unread: String(row.mentionUnread),
            max_mention_seq: row.maxMentionSeq === null ? null : String(row.maxMentionSeq),
            subscribed: row.subscribed,
            offered_unread: String(row.offeredUnread),
            activity_seq: String(row.activitySeq),
            joined_at: row.joinedAt,
          })),
        },
      };
    }) as never,
  });
}

async function seedHuman(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [human] = await getDb().insert(users).values({
    email: `inbox-${label}-${suffix}@slock.test`,
    name: `${label}-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return human;
}

async function followAsAgent(agentId: string, threadChannelId: string, parentMessageId: string) {
  const [follow] = await getDb().insert(threadFollows).values({
    followerType: "agent",
    followerId: agentId,
    threadChannelId,
    parentMessageId,
    reason: "mentioned",
  }).returning();
  return follow;
}

async function credentialFor(agentId: string) {
  const credential = await mintAgentCredential({ agentId, scopes: ["read"], name: "inbox-list", issuedVia: "computer", createdByUserId: null });
  return credential.apiKey;
}

async function getInbox(baseUrl: string, apiKey: string, query = "") {
  const res = await fetch(`${baseUrl}/internal/agent-api/inbox/conversations${query}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return { status: res.status, body: await res.json() as any };
}

const joinedAt = new Date("2026-09-01T00:00:00.000Z");

type ChainRowInput = Partial<Omit<AgentInboxChainRow, "offeredUnread" | "activitySeq">>
  & Pick<AgentInboxChainRow, "targetId" | "kind" | "serverId" | "channelName" | "channelType" | "latestSeq">;

function chainRow(input: ChainRowInput): AgentInboxChainRow {
  const row = {
    storageChannelId: input.targetId,
    parentMessageId: null,
    parentChannelId: null,
    parentChannelName: null,
    parentChannelType: null,
    lastReadSeq: 0,
    unreadCount: 1,
    firstUnreadSeq: input.latestSeq,
    mentionUnread: 0,
    maxMentionSeq: null,
    subscribed: true,
    joinedAt,
    ...input,
  };
  return {
    ...row,
    offeredUnread: row.subscribed ? row.unreadCount : row.mentionUnread,
    activitySeq: Math.max(row.latestSeq ?? 0, row.maxMentionSeq ?? 0),
  };
}

test("inbox lists the offered conversations newest first, pages by activity seq, and filters mentions", async ({ app }) => {
  const owner = await seedHuman("owner");
  const server = await createServer("Inbox List", `inbox-${randomUUID().slice(0, 8)}`, owner.id);
  const agent = await createAgent(server.id, "InboxBot", { runtime: "claude", model: "sonnet" });
  const general = await createChannel(server.id, "general");
  await addHuman(general.id, owner.id);
  await addAgent(general.id, agent.id);
  const dm = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm);

  const generalMsg = await createMessage(general.id, "user", owner.id, "hello general");
  const dmMsg = await createMessage(dm.id, "user", owner.id, "hello dm");
  const threadParent = await createMessage(general.id, "user", owner.id, "thread parent");
  const thread = await getOrCreateThread(threadParent.id, owner.id, "user");
  const threadReply = await createMessage(thread.id, "user", owner.id, "thread reply mentioning the agent");
  const threadFollow = await followAsAgent(agent.id, thread.id, threadParent.id);
  const dmParent = await createMessage(dm.id, "user", owner.id, "dm thread parent");
  const dmThread = await getOrCreateThread(dmParent.id, owner.id, "user");
  const dmThreadReply = await createMessage(dmThread.id, "user", owner.id, "dm thread reply");
  const dmThreadFollow = await followAsAgent(agent.id, dmThread.id, dmParent.id);
  // A DM with no addressable peer (the single-member migration receipt DM shape):
  // no target can open it, so it is not listed and not counted.
  const [receiptDm] = await getDb().insert(channels).values({ serverId: server.id, name: `migration-receipt-${randomUUID().slice(0, 8)}`, type: "dm" }).returning();
  await getDb().insert(channelAgents).values({ channelId: receiptDm.id, agentId: agent.id });
  const receiptMsg = await createMessage(receiptDm.id, "user", "system", "migration receipt", "system");

  stubChain([
    chainRow({ targetId: general.id, kind: "channel", serverId: server.id, channelName: "general", channelType: "channel", latestSeq: generalMsg.seq, unreadCount: 4, lastReadSeq: 0 }),
    chainRow({ targetId: dm.id, kind: "dm", serverId: server.id, channelName: dm.name, channelType: "dm", latestSeq: dmParent.seq, unreadCount: 2, lastReadSeq: dmMsg.seq - 1 }),
    chainRow({
      targetId: thread.id, kind: "thread", serverId: server.id, channelName: "thread", channelType: "thread",
      parentMessageId: threadParent.id, parentChannelId: general.id, parentChannelName: "general", parentChannelType: "channel",
      latestSeq: threadReply.seq, mentionUnread: 1, maxMentionSeq: threadReply.seq, joinedAt: threadFollow.createdAt,
    }),
    chainRow({
      targetId: dmThread.id, kind: "thread", serverId: server.id, channelName: "thread", channelType: "thread",
      parentMessageId: dmParent.id, parentChannelId: dm.id, parentChannelName: dm.name, parentChannelType: "dm",
      latestSeq: dmThreadReply.seq, joinedAt: dmThreadFollow.createdAt,
    }),
    chainRow({ targetId: receiptDm.id, kind: "dm", serverId: server.id, channelName: receiptDm.name, channelType: "dm", latestSeq: receiptMsg.seq }),
  ]);
  const apiKey = await credentialFor(agent.id);

  const first = await getInbox(app.baseUrl, apiKey, "?limit=2");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.totals, { conversations: 4, dms: 1, mentions: 1 });
  assert.equal(first.body.view, "unread");
  assert.deepEqual(first.body.items.map((item: any) => item.target), [
    `dm:@${owner.name}:${dmParent.id.slice(0, 8)}`,
    `dm:@${owner.name}`,
  ]);
  assert.equal(first.body.hasMore, true);
  assert.equal(first.body.nextBeforeSeq, dmParent.seq);
  assert.deepEqual(first.body.items[1], {
    target: `dm:@${owner.name}`,
    kind: "dm",
    unread: 2,
    mentions: 0,
    lastReadSeq: dmMsg.seq - 1,
    activitySeq: dmParent.seq,
    latestSenderName: owner.name,
    latestAt: dmParent.createdAt.toISOString(),
  });

  const second = await getInbox(app.baseUrl, apiKey, `?limit=2&before_seq=${first.body.nextBeforeSeq}`);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.items.map((item: any) => [item.target, item.kind, item.unread, item.mentions]), [
    [`#general:${threadParent.id.slice(0, 8)}`, "thread", 1, 1],
    ["#general", "channel", 4, 0],
  ]);
  assert.equal(second.body.hasMore, false);
  assert.equal(second.body.nextBeforeSeq, null);

  const mentions = await getInbox(app.baseUrl, apiKey, "?view=mentions");
  assert.equal(mentions.status, 200);
  assert.equal(mentions.body.view, "mentions");
  assert.deepEqual(mentions.body.items.map((item: any) => item.target), [`#general:${threadParent.id.slice(0, 8)}`]);
  assert.deepEqual(mentions.body.totals, { conversations: 4, dms: 1, mentions: 1 });

  assert.equal((await getInbox(app.baseUrl, apiKey, "?view=everything")).status, 400);
  assert.equal((await getInbox(app.baseUrl, apiKey, "?before_seq=abc")).status, 400);
  assert.equal((await getInbox(app.baseUrl, apiKey, "?limit=0")).status, 400);
});

test("a joint thread is listed as <local parent>:<canonical parent short id>", async ({ app }) => {
  const db = getDb();
  const ownerA = await seedHuman("joint-a");
  const ownerB = await seedHuman("joint-b");
  const [serverA] = await db.insert(servers).values({ name: "Joint A", slug: `joint-a-${randomUUID().slice(0, 8)}`, ownerId: ownerA.id }).returning();
  const serverB = await createServer("Joint B", `joint-b-${randomUUID().slice(0, 8)}`, ownerB.id);
  const agent = await createAgent(serverB.id, "JointInboxBot", { runtime: "claude", model: "sonnet" });

  const [canonical, localA, localB] = await db.insert(channels).values([
    { serverId: serverA.id, name: "joint-canonical", type: "joint" },
    { serverId: serverA.id, name: "joint-a-local", type: "joint" },
    { serverId: serverB.id, name: "joint-b-local", type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: serverA.id, createdByUserId: ownerA.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint.id, serverId: serverA.id, localChannelId: localA.id, role: "host", status: "active", joinedByUserId: ownerA.id },
    { jointChannelId: joint.id, serverId: serverB.id, localChannelId: localB.id, role: "participant", status: "active", joinedByUserId: ownerB.id },
  ]);
  await db.insert(channelAgents).values({ channelId: localB.id, agentId: agent.id });

  const parent = await createMessage(canonical.id, "user", ownerA.id, "joint parent");
  const [canonicalThread] = await db.insert(channels).values({ serverId: serverA.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread", parentMessageId: parent.id }).returning();
  await db.update(messages).set({ threadId: canonicalThread.id }).where(eq(messages.id, parent.id));
  const [threadA, threadB] = await db.insert(channels).values([
    { serverId: serverA.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread" },
    { serverId: serverB.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread" },
  ]).returning();
  const [threadJoint] = await db.insert(jointChannels).values({ canonicalChannelId: canonicalThread.id, createdByServerId: serverA.id, createdByUserId: ownerA.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: threadJoint.id, serverId: serverA.id, localChannelId: threadA.id, role: "host", status: "active", joinedByUserId: ownerA.id },
    { jointChannelId: threadJoint.id, serverId: serverB.id, localChannelId: threadB.id, role: "participant", status: "active", joinedByUserId: ownerB.id },
  ]);
  const follow = await followAsAgent(agent.id, threadB.id, parent.id);
  const reply = await createMessage(canonicalThread.id, "user", ownerA.id, "joint thread reply");

  stubChain([
    // As the agent inbox view reports a joint thread: parent_message_id is the
    // canonical parent; its parent is the local parent projection.
    chainRow({
      targetId: threadB.id, storageChannelId: canonicalThread.id, kind: "thread", serverId: serverB.id,
      channelName: threadB.name, channelType: "thread", parentMessageId: parent.id,
      parentChannelId: localB.id, parentChannelName: localB.name,
      parentChannelType: "joint", latestSeq: reply.seq, joinedAt: follow.createdAt,
    }),
  ]);
  const res = await getInbox(app.baseUrl, await credentialFor(agent.id));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.items.map((item: any) => [item.target, item.latestSenderName]), [
    [`#joint-b-local:${parent.id.slice(0, 8)}`, ownerA.name],
  ]);
});

test("inbox answers 503 INBOX_UNAVAILABLE when the chain is unconfigured or its read fails", async ({ app }) => {
  const owner = await seedHuman("down");
  const server = await createServer("Inbox Down", `inbox-down-${randomUUID().slice(0, 8)}`, owner.id);
  const agent = await createAgent(server.id, "InboxDownBot", { runtime: "claude", model: "sonnet" });
  const apiKey = await credentialFor(agent.id);

  __testRisingWaveInbox.set({ getPool: () => null });
  const unconfigured = await getInbox(app.baseUrl, apiKey);
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.code, "INBOX_UNAVAILABLE");

  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:4566"), { code: "ECONNREFUSED" });
    }) as never,
  });
  const failed = await getInbox(app.baseUrl, apiKey);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "INBOX_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(failed.body), /ECONNREFUSED/);
});

test("an external agent's inbox listing returns a turn snapshot; its completed end-of-turn report settles what it owes nothing in", async ({ app }) => {
  __resetExternalTurnEndSnapshotsForTests();
  const owner = await seedHuman("ext-owner");
  const server = await createServer("Inbox Snapshot", `inbox-snap-${randomUUID().slice(0, 8)}`, owner.id);
  const agent = await createAgent(server.id, "CloudBot", { runtime: EXTERNAL_AGENT_RUNTIME_ID, model: EXTERNAL_AGENT_RUNTIME_MODEL });
  const busy = await createChannel(server.id, "busy");
  const pinged = await createChannel(server.id, "pinged");
  for (const channel of [busy, pinged]) {
    await addHuman(channel.id, owner.id);
    await addAgent(channel.id, agent.id);
  }
  await createMessage(busy.id, "user", owner.id, "old 1");
  const busyLatest = await createMessage(busy.id, "user", owner.id, "old 2");
  const ping = await createMessage(pinged.id, "user", owner.id, "@CloudBot please look");
  await getDb().insert(messageMentions).values({
    messageId: ping.id, serverId: server.id, channelId: pinged.id, messageSeq: ping.seq,
    targetType: "agent", targetId: agent.id, handleAtSendTime: "CloudBot",
  });
  stubChain([
    chainRow({ targetId: busy.id, kind: "channel", serverId: server.id, channelName: "busy", channelType: "channel", latestSeq: busyLatest.seq, unreadCount: 2 }),
    chainRow({ targetId: pinged.id, kind: "channel", serverId: server.id, channelName: "pinged", channelType: "channel", latestSeq: ping.seq, unreadCount: 1, mentionUnread: 1, maxMentionSeq: ping.seq }),
  ]);
  const apiKey = await credentialFor(agent.id);
  const first = await getInbox(app.baseUrl, apiKey);
  assert.equal(first.status, 200);
  assert.equal(typeof first.body.snapshotId, "string");
  assert.equal((await getInbox(app.baseUrl, apiKey)).body.snapshotId, first.body.snapshotId, "listings in one turn share the snapshot");
  // A message after the listing is not covered by it.
  const afterListing = await createMessage(busy.id, "user", owner.id, "new during the turn");

  const report = async (turnEnded: unknown) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/activity`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ schema: "raft-agent-activity-ingest.v1", events: [], turnEnded }),
    });
    return { status: res.status, body: await res.json() as any };
  };
  const cursorOf = async (channelId: string) =>
    (await getDb().select({ seq: agentChannelReadCursors.lastReadSeq }).from(agentChannelReadCursors)
      .where(and(eq(agentChannelReadCursors.agentId, agent.id), eq(agentChannelReadCursors.channelId, channelId))))[0]?.seq ?? null;

  const stale = await report({ snapshotId: "another-turn", outcome: "completed", shownUnreadTargets: ["#busy"] });
  assert.deepEqual(stale.body.turnEnded, { outcome: "skipped", reason: "stale_snapshot" });
  assert.equal(await cursorOf(busy.id), null, "another snapshot's report changes nothing");

  const settled = await report({ snapshotId: first.body.snapshotId, outcome: "completed", shownUnreadTargets: ["#busy", "#pinged", "#never-listed"] });
  assert.equal(settled.status, 200);
  assert.deepEqual(settled.body.turnEnded, { outcome: "settled", conversationCount: 1 });
  assert.equal(await cursorOf(busy.id), busyLatest.seq, "read through what the listing showed, not the later message");
  assert.ok(afterListing.seq > busyLatest.seq);
  assert.equal(await cursorOf(pinged.id), null, "an unread @mention stays unread");

  const again = await report({ snapshotId: first.body.snapshotId, outcome: "completed", shownUnreadTargets: ["#busy"] });
  assert.deepEqual(again.body.turnEnded, { outcome: "skipped", reason: "no_snapshot" }, "the first report consumed it");

  const next = await getInbox(app.baseUrl, apiKey);
  assert.notEqual(next.body.snapshotId, first.body.snapshotId, "the next turn gets a new snapshot");
  const interrupted = await report({ snapshotId: next.body.snapshotId, outcome: "interrupted", shownUnreadTargets: ["#busy"] });
  assert.deepEqual(interrupted.body.turnEnded, { outcome: "skipped", reason: "not_completed" });
  const malformed = await report({ snapshotId: next.body.snapshotId, outcome: "done" });
  assert.equal(malformed.status, 200, "a malformed turnEnded never fails the activity batch");
  assert.deepEqual(malformed.body.ignoredFields, ["turnEnded"]);
});

test("a managed agent's inbox listing carries no turn snapshot", async ({ app }) => {
  const owner = await seedHuman("managed-owner");
  const server = await createServer("Inbox Managed", `inbox-man-${randomUUID().slice(0, 8)}`, owner.id);
  const agent = await createAgent(server.id, "ComputerBot", { runtime: "claude", model: "sonnet" });
  const general = await createChannel(server.id, "general");
  const msg = await createMessage(general.id, "user", owner.id, "hi");
  stubChain([chainRow({ targetId: general.id, kind: "channel", serverId: server.id, channelName: "general", channelType: "channel", latestSeq: msg.seq })]);
  const listed = await getInbox(app.baseUrl, await credentialFor(agent.id));
  assert.equal(listed.status, 200);
  assert.equal("snapshotId" in listed.body, false);
});

test("a conversation the agent just read through is not listed while the chain trails; a partly read one opens at the durable position", async ({ app }) => {
  const owner = await seedHuman("durable-owner");
  const server = await createServer("Inbox Durable", `inbox-durable-${randomUUID().slice(0, 8)}`, owner.id);
  const agent = await createAgent(server.id, "DurableBot", { runtime: "claude", model: "sonnet" });
  const readThrough = await createChannel(server.id, "read-through");
  const partly = await createChannel(server.id, "partly");
  for (const channel of [readThrough, partly]) {
    await addHuman(channel.id, owner.id);
    await addAgent(channel.id, agent.id);
  }
  const done = await createMessage(readThrough.id, "user", owner.id, "already read with --after");
  const partlyFirst = await createMessage(partly.id, "user", owner.id, "read");
  const partlyLatest = await createMessage(partly.id, "user", owner.id, "not yet");
  // The chain still shows both as unread from an older position; the reads already landed in Postgres.
  stubChain([
    chainRow({ targetId: readThrough.id, kind: "channel", serverId: server.id, channelName: "read-through", channelType: "channel", latestSeq: done.seq, unreadCount: 1, lastReadSeq: done.seq - 1 }),
    chainRow({ targetId: partly.id, kind: "channel", serverId: server.id, channelName: "partly", channelType: "channel", latestSeq: partlyLatest.seq, unreadCount: 2, lastReadSeq: partlyFirst.seq - 1 }),
  ]);
  await markAgentLegacyRead(agent.id, readThrough.id, done.seq);
  await markAgentLegacyRead(agent.id, partly.id, partlyFirst.seq);

  const listed = await getInbox(app.baseUrl, await credentialFor(agent.id));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.map((item: { target: string }) => item.target), ["#partly"], "the read-through conversation is not a phantom");
  assert.equal(listed.body.items[0].lastReadSeq, partlyFirst.seq, "open: starts where the agent actually read to");
  assert.equal(listed.body.totals.conversations, 1);
});

test("a read-through row dropped at a page boundary does not end the paging", async ({ app }) => {
  const owner = await seedHuman("paging-owner");
  const server = await createServer("Inbox Paging", `inbox-paging-${randomUUID().slice(0, 8)}`, owner.id);
  const agent = await createAgent(server.id, "PagingBot", { runtime: "claude", model: "sonnet" });
  const rows: AgentInboxChainRow[] = [];
  for (const name of ["c1", "c2", "c3"]) {
    const channel = await createChannel(server.id, name);
    await addAgent(channel.id, agent.id);
    const message = await createMessage(channel.id, "user", owner.id, `in ${name}`);
    rows.push(chainRow({ targetId: channel.id, kind: "channel", serverId: server.id, channelName: name, channelType: "channel", latestSeq: message.seq, lastReadSeq: message.seq - 1 }));
    if (name === "c3") await markAgentLegacyRead(agent.id, channel.id, message.seq);
  }
  stubChain(rows);
  const apiKey = await credentialFor(agent.id);
  // Newest first: c3 (read through), c2, c1. A page of 1 reads two rows (c3, c2), drops c3 and
  // keeps c2; there is still c1 after it.
  const first = await getInbox(app.baseUrl, apiKey, "?limit=1");
  assert.deepEqual(first.body.items.map((item: { target: string }) => item.target), ["#c2"]);
  assert.equal(first.body.hasMore, true, "c1 is still after it");
  const second = await getInbox(app.baseUrl, apiKey, `?limit=1&before_seq=${first.body.nextBeforeSeq}`);
  assert.deepEqual(second.body.items.map((item: { target: string }) => item.target), ["#c1"]);

});
