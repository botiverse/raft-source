// POST /internal/agent-api/inbox/rows: the `inbox check` rows of the
// conversations the agent's Computer names, asked with the agent's credential
// before a wake-up notice. The RisingWave agent inbox view is stubbed through
// its test seam as internalAgentApi.inboxItems.api.test.ts does, here holding
// rows of several agents: a read without `agent_id = $1` sees all of them.
// Everything else (targets, previews, read positions) is real Postgres.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";
import {
  AGENT_API_INBOX_ROWS_MAX_TARGETS,
  INBOX_ITEMS_CAPABILITY,
  MANUAL_CONTEXT_CAPABILITY,
  RAFT_CLIENT_CAPABILITIES_HEADER,
} from "@botiverse/raft-shared";

import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agentChannelReadCursors, agents, channelAgents, channels, featureFlags, users } from "../db/schema";
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
import { AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, createFeatureFlag } from "../services/featureFlagService";
import { agentProgressAtMs } from "../services/agentProgressMarks";
import { INBOX_ITEMS_LAUNCH_AT_ENV } from "../services/agentInboxItems";
import { __resetInboxItemsLaunchWarningsForTests } from "../services/inboxItemsLaunch";
import * as tracing from "../tracing/semanticTrace";

const test = createApiTest();

beforeEach(() => {
  __resetInboxItemsLaunchWarningsForTests();
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, "2026-01-01T00:00:00.000Z");
});

afterEach(() => {
  __testRisingWaveInbox.reset();
  vi.unstubAllEnvs();
});

async function seed(label: string, opts: { flag?: boolean } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `inbox-rows-${label}-${suffix}@slock.test`,
    name: `inbox-rows-${label}-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Inbox Rows", `inbox-rows-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `RowsBot${suffix.slice(0, 4)}`, { runtime: "claude", model: "sonnet" });
  const other = await createAgent(server.id, `OtherBot${suffix.slice(0, 4)}`, { runtime: "claude", model: "sonnet" });
  const general = await createChannel(server.id, `general-${suffix}`);
  await addHuman(general.id, owner!.id);
  await addAgent(general.id, agent.id);
  const second = await createChannel(server.id, `second-${suffix}`);
  await addHuman(second.id, owner!.id);
  await addAgent(second.id, agent.id);
  // Private, with the other agent only: this agent can't see it.
  const hidden = await createChannel(server.id, `hidden-${suffix}`, undefined, "private");
  await addHuman(hidden.id, owner!.id);
  await addAgent(hidden.id, other.id);
  if (opts.flag !== false) await createFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["send", "read"], name: "inbox-rows", issuedVia: "computer", createdByUserId: null })).apiKey;
  return { owner: owner!, server, agent, other, general, second, hidden, apiKey: await key(agent.id), otherKey: await key(other.id) };
}

type OwnedRow = AgentInboxChainRow & { agentId: string };

function viewRow(agentId: string, input: Pick<AgentInboxChainRow, "targetId" | "serverId" | "channelName" | "latestSeq"> & Partial<AgentInboxChainRow>): OwnedRow {
  const row = {
    storageChannelId: input.targetId,
    kind: "channel" as const,
    channelType: "channel" as const,
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
    joinedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...input,
  };
  return { ...row, agentId, offeredUnread: input.offeredUnread ?? row.unreadCount, activitySeq: input.activitySeq ?? Math.max(row.latestSeq ?? 0, row.maxMentionSeq ?? 0) };
}

/**
 * The agent inbox view over every agent's `rows`; `queries` collects what was
 * asked. `afterDmRead`: targets whose row arrived after the agent's DM rows
 * were read, so only a read that names them sees them.
 */
function stubView(rows: OwnedRow[], queries: string[] = [], afterDmRead: readonly string[] = []): string[] {
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, text: string, values: unknown[] = []) => {
      queries.push(text);
      const param = (pattern: RegExp) => {
        const match = text.match(pattern);
        return match ? values[Number(match[1]) - 1] : undefined;
      };
      // The view holds every agent's rows: only `agent_id = $1` narrows them.
      let selected = /agent_id = \$1\b/.test(text) ? rows.filter((row) => row.agentId === values[0]) : rows;
      if (/before_count/.test(text)) {
        return { result: { rows: [{ before_count: String(selected.filter((row) => row.activitySeq < Number(values[1])).length) }] } };
      }
      if (/count\(\*\)/.test(text)) {
        return { result: { rows: [{ conversations: String(selected.length), dms: String(selected.filter((row) => row.kind === "dm").length), mentions: String(selected.filter((row) => row.mentionUnread > 0).length), messages: String(selected.reduce((sum, row) => sum + row.offeredUnread, 0)) }] } };
      }
      const kind = param(/kind = \$(\d+)/);
      if (kind !== undefined) selected = selected.filter((row) => row.kind === kind);
      const beforeSeq = param(/activity_seq < \$(\d+)/);
      if (beforeSeq !== undefined) selected = selected.filter((row) => row.activitySeq < Number(beforeSeq));
      const targetIds = param(/target_id = ANY\(\$(\d+)\)/);
      if (targetIds !== undefined) selected = selected.filter((row) => (targetIds as string[]).includes(row.targetId));
      else selected = selected.filter((row) => !afterDmRead.includes(row.targetId));
      const limit = text.match(/LIMIT (\d+)/)?.[1];
      if (limit !== undefined) selected = [...selected].sort((a, b) => b.activitySeq - a.activitySeq).slice(0, Number(limit));
      return {
        result: {
          rows: selected.map((row) => ({
            target_id: row.targetId, storage_channel_id: row.storageChannelId, kind: row.kind, server_id: row.serverId,
            channel_name: row.channelName, channel_type: row.channelType, parent_message_id: row.parentMessageId,
            parent_channel_id: row.parentChannelId, parent_channel_name: row.parentChannelName, parent_channel_type: row.parentChannelType,
            last_read_seq: String(row.lastReadSeq), unread_count: String(row.unreadCount),
            first_unread_seq: row.firstUnreadSeq === null ? null : String(row.firstUnreadSeq),
            latest_seq: row.latestSeq === null ? null : String(row.latestSeq), mention_unread: String(row.mentionUnread),
            max_mention_seq: row.maxMentionSeq === null ? null : String(row.maxMentionSeq), subscribed: row.subscribed,
            offered_unread: String(row.offeredUnread), activity_seq: String(row.activitySeq), joined_at: row.joinedAt,
          })),
        },
      };
    }) as never,
  });
  return queries;
}

async function call(baseUrl: string, apiKey: string, method: "GET" | "POST", path: string, body?: unknown, client = "daemon-1.0.0") {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Raft-Client": client, [RAFT_CLIENT_CAPABILITIES_HEADER]: `${MANUAL_CONTEXT_CAPABILITY},${INBOX_ITEMS_CAPABILITY}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, body: json };
}

type Target = { channelId: string; newestSeq: number };
const rowsOf = (baseUrl: string, apiKey: string, targets: Target[], client?: string) => call(baseUrl, apiKey, "POST", "/inbox/rows", { targets }, client);
const check = (baseUrl: string, apiKey: string) => call(baseUrl, apiKey, "GET", "/inbox/conversations?items=true", undefined, "cli");

/** `otherUnread` as answered. */
const other = (conversations: number, messages: number, mentions = 0, dms = 0) => ({ conversations, messages, mentions, dms });

async function cursorsOf(agentId: string) {
  return getDb().select().from(agentChannelReadCursors).where(eq(agentChannelReadCursors.agentId, agentId)).orderBy(asc(agentChannelReadCursors.channelId));
}

test("the rows are the ones inbox check lists for the same conversations, newest activity first, and the rest is counted", async ({ app }) => {
  const f = await seed("same");
  const dm = await findOrCreateDM(f.server.id, f.owner.id, f.agent.id);
  assert.ok(dm);
  const generalMsg = await createMessage(f.general.id, "user", f.owner.id, "hello general");
  const parent = await createMessage(f.general.id, "user", f.owner.id, "thread parent");
  const thread = await getOrCreateThread(parent.id, f.owner.id, "user");
  const reply = await createMessage(thread.id, "user", f.owner.id, "a reply for the agent");
  const dmMsg = await createMessage(dm.id, "user", f.owner.id, "hello dm");
  const secondMsg = await createMessage(f.second.id, "user", f.owner.id, "hello second");
  // Partly read: the durable position is past the view's, as after a read the view has not seen yet.
  const generalLater = await createMessage(f.general.id, "user", f.owner.id, "later in general");
  await markAgentLegacyRead(f.agent.id, f.general.id, generalMsg.seq);
  stubView([
    viewRow(f.agent.id, { targetId: f.general.id, serverId: f.server.id, channelName: f.general.name, latestSeq: generalLater.seq, unreadCount: 3, firstUnreadSeq: generalMsg.seq }),
    viewRow(f.agent.id, {
      targetId: thread.id, kind: "thread", serverId: f.server.id, channelName: "thread", channelType: "thread",
      parentMessageId: parent.id, parentChannelId: f.general.id, parentChannelName: f.general.name, parentChannelType: "channel",
      latestSeq: reply.seq, mentionUnread: 1, maxMentionSeq: reply.seq,
    }),
    viewRow(f.agent.id, { targetId: dm.id, kind: "dm", serverId: f.server.id, channelName: dm.name, channelType: "dm", latestSeq: dmMsg.seq, unreadCount: 2 }),
    viewRow(f.agent.id, { targetId: f.second.id, serverId: f.server.id, channelName: f.second.name, latestSeq: secondMsg.seq }),
  ]);

  const listed = await check(app.baseUrl, f.apiKey);
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.body.rows.map((row: any) => row.target), [`#${f.general.name}`, `#${f.second.name}`, `dm:@${f.owner.name}`, `#${f.general.name}:${parent.id.slice(0, 8)}`]);

  // Named oldest first: the answer is in the view's order all the same.
  const all = await rowsOf(app.baseUrl, f.apiKey, [
    { channelId: thread.id, newestSeq: reply.seq },
    { channelId: dm.id, newestSeq: dmMsg.seq },
    { channelId: f.second.id, newestSeq: secondMsg.seq },
    { channelId: f.general.id, newestSeq: generalLater.seq },
  ]);
  assert.equal(all.status, 200, all.text);
  // The list's rows, each with the channel id it answers (the list's own rows have none).
  assert.equal(listed.body.rows.some((row: any) => "channelId" in row), false);
  const withId = listed.body.rows.map((row: any, index: number) => ({ ...row, channelId: [f.general.id, f.second.id, dm.id, thread.id][index] }));
  assert.deepEqual(all.body, { rows: withId, behind: 0, otherUnread: other(0, 0) });
  assert.equal(all.body.rows[0].lastReadSeq, generalMsg.seq, "the durable read position, as the list patches it");

  const some = await rowsOf(app.baseUrl, f.apiKey, [{ channelId: dm.id, newestSeq: dmMsg.seq }, { channelId: thread.id, newestSeq: reply.seq }]);
  assert.equal(some.status, 200, some.text);
  assert.deepEqual(some.body, { rows: [withId[2], withId[3]], behind: 0, otherUnread: other(2, 4) });
});

test("a conversation the view has no row of the agent for has no row and no number, whatever the reason, in the same bytes; another agent's row never leaks", async ({ app }) => {
  const f = await seed("uniform");
  const generalMsg = await createMessage(f.general.id, "user", f.owner.id, "hello general");
  const hiddenMsg = await createMessage(f.hidden.id, "user", f.owner.id, "not for this agent");
  await createMessage(f.second.id, "user", f.owner.id, "already read");
  const queries = stubView([
    viewRow(f.agent.id, { targetId: f.general.id, serverId: f.server.id, channelName: f.general.name, latestSeq: generalMsg.seq }),
    // The other agent's unread in a channel this agent is not in.
    viewRow(f.other.id, { targetId: f.hidden.id, serverId: f.server.id, channelName: f.hidden.name, channelType: "private", latestSeq: hiddenMsg.seq }),
  ]);

  const invisible = await rowsOf(app.baseUrl, f.apiKey, [{ channelId: f.hidden.id, newestSeq: hiddenMsg.seq }]);
  const unknown = await rowsOf(app.baseUrl, f.apiKey, [{ channelId: randomUUID(), newestSeq: hiddenMsg.seq }]);
  // The agent is in it and the view has no row. That is either "nothing
  // unread" or "a new message the view has not seen yet in a conversation
  // that was fully read": the Server can't tell which without counting in
  // Postgres, so the answer says neither. No row means no number: the caller
  // lists the conversation without one and never reads this as "nothing
  // unread". `behind` stays 0, it counts only rows the view already had.
  const noRowYet = await rowsOf(app.baseUrl, f.apiKey, [{ channelId: f.second.id, newestSeq: hiddenMsg.seq + 1 }]);
  assert.equal(invisible.status, 200, invisible.text);
  assert.deepEqual(invisible.body, { rows: [], behind: 0, otherUnread: other(1, 1) });
  assert.equal(unknown.text, invisible.text);
  assert.deepEqual(noRowYet.body, { rows: [], behind: 0, otherUnread: other(1, 1) });
  assert.equal(noRowYet.text, invisible.text);
  assert.equal(invisible.text.includes(f.hidden.name), false);
  // Every view read is the agent's own rows.
  assert.ok(queries.length >= 9, String(queries.length));
  for (const text of queries) assert.match(text, /FROM rw_agent_inbox_v7\s+WHERE agent_id = \$1/);

  // The row is there for the agent it belongs to.
  const theirs = await rowsOf(app.baseUrl, f.otherKey, [{ channelId: f.hidden.id, newestSeq: hiddenMsg.seq }, { channelId: f.general.id, newestSeq: generalMsg.seq }]);
  assert.equal(theirs.status, 200, theirs.text);
  assert.deepEqual(theirs.body.rows.map((row: any) => [row.target, row.unread]), [[`#${f.hidden.name}`, 1]]);
  assert.deepEqual([theirs.body.behind, theirs.body.otherUnread], [0, other(0, 0)]);

  // Read through by the durable position, the view not caught up to the read: no row (as the list drops it), not behind.
  await markAgentLegacyRead(f.agent.id, f.general.id, generalMsg.seq);
  const readThrough = await rowsOf(app.baseUrl, f.apiKey, [{ channelId: f.general.id, newestSeq: generalMsg.seq }]);
  assert.deepEqual(readThrough.body, { rows: [], behind: 0, otherUnread: other(0, 0) });
});

test("a conversation whose view row has not seen the Computer's newest message has no row and is counted behind", async ({ app }) => {
  const f = await seed("behind");
  const first = await createMessage(f.general.id, "user", f.owner.id, "the view has this one");
  const newer = await createMessage(f.general.id, "user", f.owner.id, "the Computer already holds this one");
  const secondMsg = await createMessage(f.second.id, "user", f.owner.id, "hello second");
  stubView([
    viewRow(f.agent.id, { targetId: f.general.id, serverId: f.server.id, channelName: f.general.name, latestSeq: first.seq }),
    viewRow(f.agent.id, { targetId: f.second.id, serverId: f.server.id, channelName: f.second.name, latestSeq: secondMsg.seq }),
  ]);

  const behind = await rowsOf(app.baseUrl, f.apiKey, [{ channelId: f.general.id, newestSeq: newer.seq }, { channelId: f.second.id, newestSeq: secondMsg.seq }]);
  assert.equal(behind.status, 200, behind.text);
  assert.deepEqual(behind.body.rows.map((row: any) => row.target), [`#${f.second.name}`]);
  assert.deepEqual([behind.body.behind, behind.body.otherUnread], [1, other(0, 0)]);

  // Behind stays behind when the agent has read up to what the view shows: the newer message is still not counted.
  await markAgentLegacyRead(f.agent.id, f.general.id, first.seq);
  const stillBehind = await rowsOf(app.baseUrl, f.apiKey, [{ channelId: f.general.id, newestSeq: newer.seq }]);
  assert.deepEqual(stillBehind.body, { rows: [], behind: 1, otherUnread: other(1, 1) });

  // Named twice: the newest of the two decides, and it is one conversation.
  const twice = await rowsOf(app.baseUrl, f.apiKey, [{ channelId: f.second.id, newestSeq: secondMsg.seq }, { channelId: f.second.id, newestSeq: secondMsg.seq + 1 }]);
  assert.deepEqual(twice.body, { rows: [], behind: 1, otherUnread: other(1, 1) });
});

test("withBehind: a row that has not seen the Computer's newest message is answered with its activitySeq, a conversation without a row is behind too, and one read through has no row", async ({ app }) => {
  const f = await seed("withbehind");
  const first = await createMessage(f.general.id, "user", f.owner.id, "the view has this one");
  const newer = await createMessage(f.general.id, "user", f.owner.id, "the Computer already holds this one");
  const secondMsg = await createMessage(f.second.id, "user", f.owner.id, "the view has not seen this conversation's message at all");
  stubView([
    viewRow(f.agent.id, { targetId: f.general.id, serverId: f.server.id, channelName: f.general.name, latestSeq: first.seq }),
  ]);
  const targets = [{ channelId: f.general.id, newestSeq: newer.seq }, { channelId: f.second.id, newestSeq: secondMsg.seq }];
  const ask = (body: unknown) => call(app.baseUrl, f.apiKey, "POST", "/inbox/rows", body);

  const answer = await ask({ targets, withBehind: true });
  assert.equal(answer.status, 200, answer.text);
  assert.equal(answer.body.withBehind, true);
  // The row as far as the view has got: the asker adds what it holds after `activitySeq`.
  assert.deepEqual(answer.body.rows.map((row: any) => [row.target, row.channelId, row.unread, row.activitySeq]), [[`#${f.general.name}`, f.general.id, 1, first.seq]]);
  // Both are behind: one row older than the asker's newest message, one with no row.
  assert.deepEqual([answer.body.behind, answer.body.otherUnread], [2, other(0, 0)]);

  // Without the field (an older Computer): as before, no row for a conversation that is behind, and no `withBehind`.
  const plain = await ask({ targets });
  assert.deepEqual(plain.body, { rows: [], behind: 1, otherUnread: other(0, 0) });
  assert.deepEqual((await ask({ targets, withBehind: false })).body, plain.body);

  // Read through what the view shows: the row is dropped as the list drops it, so the asker counts only what it holds.
  await markAgentLegacyRead(f.agent.id, f.general.id, first.seq);
  const readThrough = await ask({ targets, withBehind: true });
  assert.deepEqual([readThrough.body.rows, readThrough.body.behind], [[], 2]);

  // Caught up: not behind.
  stubView([
    viewRow(f.agent.id, { targetId: f.second.id, serverId: f.server.id, channelName: f.second.name, latestSeq: secondMsg.seq }),
  ]);
  const caughtUp = await ask({ targets: [targets[1]], withBehind: true });
  assert.deepEqual([caughtUp.body.rows.length, caughtUp.body.rows[0].activitySeq, caughtUp.body.behind], [1, secondMsg.seq, 0]);
});

test("caught up is by the conversation's newest message, the agent's own included, and by a mention past a mute", async ({ app }) => {
  const f = await seed("caught-up");
  const theirs = await createMessage(f.general.id, "user", f.owner.id, "unread for the agent");
  const own = await createMessage(f.general.id, "agent", f.agent.id, "the agent's own, newest in the conversation");
  const admitted = await createMessage(f.second.id, "user", f.owner.id, "before the mute");
  const mention = await createMessage(f.second.id, "user", f.owner.id, "a mention after the mute");
  stubView([
    // latest_seq is the conversation's newest message (rw_target_latest_v4), not the newest unread one.
    viewRow(f.agent.id, { targetId: f.general.id, serverId: f.server.id, channelName: f.general.name, latestSeq: own.seq, unreadCount: 1, firstUnreadSeq: theirs.seq }),
    // Muted: latest_seq stops at the mute, the mention pierces it (+1 offered).
    viewRow(f.agent.id, { targetId: f.second.id, serverId: f.server.id, channelName: f.second.name, latestSeq: admitted.seq, unreadCount: 1, mentionUnread: 1, maxMentionSeq: mention.seq, offeredUnread: 2 }),
  ]);

  const answer = await rowsOf(app.baseUrl, f.apiKey, [{ channelId: f.general.id, newestSeq: own.seq }, { channelId: f.second.id, newestSeq: mention.seq }]);
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual(answer.body.rows.map((row: any) => [row.target, row.unread]), [[`#${f.second.name}`, 2], [`#${f.general.name}`, 1]]);
  assert.equal(answer.body.behind, 0);
});

test("otherUnread adds up what inbox check lists for the conversations not named: conversations, messages, mentions, DMs; never a DM no target can open", async ({ app }) => {
  const f = await seed("other");
  const dm = await findOrCreateDM(f.server.id, f.owner.id, f.agent.id);
  assert.ok(dm);
  const generalMsg = await createMessage(f.general.id, "user", f.owner.id, "hello general");
  const secondMsg = await createMessage(f.second.id, "user", f.owner.id, "a mention in a muted channel");
  const dmMsg = await createMessage(dm.id, "user", f.owner.id, "hello dm, with a mention");
  // A DM with no addressable peer (the single-member migration receipt DM shape): the list neither lists nor counts it.
  const [receiptDm] = await getDb().insert(channels).values({ serverId: f.server.id, name: `migration-receipt-${randomUUID().slice(0, 8)}`, type: "dm" }).returning();
  await getDb().insert(channelAgents).values({ channelId: receiptDm!.id, agentId: f.agent.id });
  const receiptMsg = await createMessage(receiptDm!.id, "user", "system", "migration receipt", "system");
  stubView([
    viewRow(f.agent.id, { targetId: f.general.id, serverId: f.server.id, channelName: f.general.name, latestSeq: generalMsg.seq, unreadCount: 3 }),
    // Muted, mention only: no admitted unread, the offered unread is the mentions.
    viewRow(f.agent.id, { targetId: f.second.id, serverId: f.server.id, channelName: f.second.name, latestSeq: null, subscribed: false, unreadCount: 0, mentionUnread: 2, maxMentionSeq: secondMsg.seq, offeredUnread: 2 }),
    viewRow(f.agent.id, { targetId: dm.id, kind: "dm", serverId: f.server.id, channelName: dm.name, channelType: "dm", latestSeq: dmMsg.seq, unreadCount: 4, mentionUnread: 1, maxMentionSeq: dmMsg.seq }),
    viewRow(f.agent.id, { targetId: receiptDm!.id, kind: "dm", serverId: f.server.id, channelName: receiptDm!.name, channelType: "dm", latestSeq: receiptMsg.seq, unreadCount: 5, mentionUnread: 1, maxMentionSeq: receiptMsg.seq }),
  ]);
  const listed = await check(app.baseUrl, f.apiKey);
  assert.deepEqual(listed.body.totals, { conversations: 3, dms: 1, mentions: 2 });
  const unreadOf = (target: string) => listed.body.rows.find((row: any) => row.target === target).unread as number;
  assert.deepEqual([unreadOf(`#${f.general.name}`), unreadOf(`#${f.second.name}`), unreadOf(`dm:@${f.owner.name}`)], [3, 2, 4]);
  const ask = async (...targets: Target[]) => (await rowsOf(app.baseUrl, f.apiKey, targets)).body;
  const general = { channelId: f.general.id, newestSeq: generalMsg.seq };
  const second = { channelId: f.second.id, newestSeq: secondMsg.seq };
  const direct = { channelId: dm.id, newestSeq: dmMsg.seq };

  // Nothing of the agent's named (the hidden DM has no row, is not behind even with a newer seq): everything
  // `inbox check` lists is "other", and the hidden DM is in none of the four, nor taken off twice.
  assert.deepEqual(await ask({ channelId: receiptDm!.id, newestSeq: receiptMsg.seq + 5 }), { rows: [], behind: 0, otherUnread: other(3, 3 + 2 + 4, 2, 1) });
  // A plain channel named: the mention-only row and the DM are left.
  const one = await ask(general);
  assert.deepEqual([one.rows.length, one.behind, one.otherUnread], [1, 0, other(2, 2 + 4, 2, 1)]);
  // A DM with a mention named: it leaves messages, mentions and dms.
  assert.deepEqual((await ask(direct)).otherUnread, other(2, 3 + 2, 1, 0));
  // Named twice, once behind: taken off once all the same (a behind row has no number here, so it is not "other" either).
  const twice = await ask(general, { ...general, newestSeq: generalMsg.seq + 100 }, second);
  assert.deepEqual([twice.rows.length, twice.behind, twice.otherUnread], [1, 1, other(1, 4, 1, 1)]);
  assert.deepEqual((await ask(general, second, direct)).otherUnread, other(0, 0));
});

test("a DM whose row arrived between the two view reads is still listed; a channel id in upper case finds its row", async ({ app }) => {
  const f = await seed("union");
  const dm = await findOrCreateDM(f.server.id, f.owner.id, f.agent.id);
  assert.ok(dm);
  const dmMsg = await createMessage(dm.id, "user", f.owner.id, "hello dm");
  const generalMsg = await createMessage(f.general.id, "user", f.owner.id, "hello general");
  // The DM row is in the read that names it, not in the read of the agent's DM rows.
  stubView([
    viewRow(f.agent.id, { targetId: dm.id, kind: "dm", serverId: f.server.id, channelName: dm.name, channelType: "dm", latestSeq: dmMsg.seq }),
    viewRow(f.agent.id, { targetId: f.general.id, serverId: f.server.id, channelName: f.general.name, latestSeq: generalMsg.seq }),
  ], [], [dm.id]);

  const late = await rowsOf(app.baseUrl, f.apiKey, [{ channelId: dm.id, newestSeq: dmMsg.seq }]);
  assert.equal(late.status, 200, late.text);
  assert.deepEqual(late.body.rows.map((row: any) => [row.target, row.unread]), [[`dm:@${f.owner.name}`, 1]]);

  assert.notEqual(f.general.id.toUpperCase(), f.general.id);
  const upper = await rowsOf(app.baseUrl, f.apiKey, [{ channelId: f.general.id.toUpperCase(), newestSeq: generalMsg.seq }]);
  const lower = await rowsOf(app.baseUrl, f.apiKey, [{ channelId: f.general.id, newestSeq: generalMsg.seq }]);
  assert.deepEqual(upper.body.rows.map((row: any) => [row.target, row.channelId]), [[`#${f.general.name}`, f.general.id]], "the id as the Server stores it, not as it was asked");
  assert.equal(upper.text, lower.text);
});

test("a personal assistant's credential is refused 403 before any read", async ({ app }) => {
  const f = await seed("assistant");
  const [existing] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  if (existing) await getDb().update(featureFlags).set({ defaultEnabled: true }).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  else await createFeatureFlag({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", enabled: true, defaultEnabled: true });
  const assistant = await createAgent(f.server.id, `rows-ottie-${randomUUID().slice(0, 8)}`, { runtime: "codex", creatorType: "user", creatorId: f.owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: f.owner.id, displayName: "Ottie" }).where(eq(agents.id, assistant.id));
  const { apiKey } = await mintAgentCredential({ agentId: assistant.id, scopes: ["read", "send"], name: "inbox-rows-assistant", issuedVia: "computer", createdByUserId: null });
  const dm = await findOrCreateDM(f.server.id, f.owner.id, assistant.id);
  assert.ok(dm);
  const dmMsg = await createMessage(dm.id, "user", f.owner.id, "for the assistant");
  const queries = stubView([viewRow(assistant.id, { targetId: dm.id, kind: "dm", serverId: f.server.id, channelName: dm.name, channelType: "dm", latestSeq: dmMsg.seq })]);

  const refused = await rowsOf(app.baseUrl, apiKey, [{ channelId: dm.id, newestSeq: dmMsg.seq }]);
  assert.deepEqual([refused.status, refused.body.code], [403, "assistant_route_not_allowed"], refused.text);
  assert.deepEqual(queries, []);
});

test("a malformed body and more conversations than the cap are refused 400 before any read", async ({ app }) => {
  const f = await seed("bad");
  const queries = stubView([]);
  const target = { channelId: f.general.id, newestSeq: 1 };
  const post = (body: unknown) => call(app.baseUrl, f.apiKey, "POST", "/inbox/rows", body);
  const refused = [
    await post({}),
    await post({ targets: [] }),
    await post({ targets: Array.from({ length: AGENT_API_INBOX_ROWS_MAX_TARGETS + 1 }, () => target) }),
    await post({ targets: [{ ...target, channelId: `#${f.general.name}` }] }),
    await post({ targets: [{ ...target, newestSeq: 0 }] }),
    await post({ targets: [{ ...target, newestSeq: "1" }] }),
    await post({ targets: [{ channelId: f.general.id }] }),
  ];
  for (const answer of refused) {
    assert.equal(answer.status, 400, answer.text);
    assert.equal(answer.body.code, "agent_api_contract_invalid");
  }
  assert.deepEqual(queries, []);

  const atCap = await post({ targets: Array.from({ length: AGENT_API_INBOX_ROWS_MAX_TARGETS }, () => target) });
  assert.equal(atCap.status, 200, atCap.text);
});

test("inbox items off: 404 INBOX_ITEMS_DISABLED as inbox read answers; the view unavailable: 503 INBOX_UNAVAILABLE as the list answers", async ({ app }) => {
  const off = await seed("off", { flag: false });
  const msg = await createMessage(off.general.id, "user", off.owner.id, "hello");
  const queries = stubView([viewRow(off.agent.id, { targetId: off.general.id, serverId: off.server.id, channelName: off.general.name, latestSeq: msg.seq })]);
  const targets = [{ channelId: off.general.id, newestSeq: msg.seq }];
  const disabled = await rowsOf(app.baseUrl, off.apiKey, targets);
  const readDisabled = await call(app.baseUrl, off.apiKey, "POST", "/inbox/read", { target: `#${off.general.name}` });
  assert.equal(disabled.status, 404, disabled.text);
  assert.equal(disabled.body.code, "INBOX_ITEMS_DISABLED");
  assert.equal(disabled.text, readDisabled.text);
  assert.deepEqual(queries, []);

  await createFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  __testRisingWaveInbox.set({ getPool: () => null as never });
  const unavailable = await rowsOf(app.baseUrl, off.apiKey, targets);
  const listUnavailable = await check(app.baseUrl, off.apiKey);
  assert.equal(unavailable.status, 503, unavailable.text);
  assert.equal(unavailable.body.code, "INBOX_UNAVAILABLE");
  assert.equal(unavailable.text, listUnavailable.text);

  __testRisingWaveInbox.set({ getPool: () => ({} as never), query: (async () => { throw new Error("view read failed"); }) as never });
  const failed = await rowsOf(app.baseUrl, off.apiKey, targets);
  assert.deepEqual([failed.status, failed.body.code], [503, "INBOX_UNAVAILABLE"]);
});

test("asking moves no read position, is not the agent's progress, and is traced with counts only", async ({ app, onTestFinished }) => {
  const trace = vi.spyOn(tracing, "recordTraceEvent");
  onTestFinished(() => trace.mockRestore());
  const f = await seed("readonly");
  const generalMsg = await createMessage(f.general.id, "user", f.owner.id, "hello general");
  const generalLater = await createMessage(f.general.id, "user", f.owner.id, "later in general");
  const secondMsg = await createMessage(f.second.id, "user", f.owner.id, "hello second");
  await markAgentLegacyRead(f.agent.id, f.general.id, generalMsg.seq);
  stubView([
    viewRow(f.agent.id, { targetId: f.general.id, serverId: f.server.id, channelName: f.general.name, latestSeq: generalLater.seq, unreadCount: 2, firstUnreadSeq: generalMsg.seq }),
    viewRow(f.agent.id, { targetId: f.second.id, serverId: f.server.id, channelName: f.second.name, latestSeq: secondMsg.seq }),
  ]);
  const cursorsBefore = await cursorsOf(f.agent.id);
  assert.equal(cursorsBefore.length, 1);
  const progressBefore = await agentProgressAtMs(f.agent.id);

  const targets = [
    { channelId: f.general.id, newestSeq: generalLater.seq },
    { channelId: f.second.id, newestSeq: secondMsg.seq + 1 },
    { channelId: f.hidden.id, newestSeq: 1 },
  ];
  const fromComputer = await rowsOf(app.baseUrl, f.apiKey, targets);
  assert.deepEqual([fromComputer.status, fromComputer.body.rows.length, fromComputer.body.behind], [200, 1, 1], fromComputer.text);
  const fromAgent = await rowsOf(app.baseUrl, f.apiKey, targets, "cli");
  assert.equal(fromAgent.text, fromComputer.text, "asking again answers the same: nothing was consumed");

  assert.deepEqual(await cursorsOf(f.agent.id), cursorsBefore);
  assert.equal(await agentProgressAtMs(f.agent.id), progressBefore);

  const traced = trace.mock.calls.filter(([name]) => name === "server.agent_api.inbox_rows").map(([, attrs]) => attrs);
  assert.deepEqual(traced, [
    { agent_id: f.agent.id, server_id: f.server.id, client_kind: "daemon", requested_count: 3, rows_count: 1, behind_count: 1, with_behind_mode: "off" },
    { agent_id: f.agent.id, server_id: f.server.id, client_kind: "cli", requested_count: 3, rows_count: 1, behind_count: 1, with_behind_mode: "off" },
  ]);
});
