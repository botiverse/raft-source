import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { __testRisingWaveInbox, getInboxItems } from "./channelService";
import { installRisingWaveReadReferences, uninstallRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { __testUnifiedChainTransition } from "../db/risingwave";
import type { DbQueryTracer } from "../tracing/dbQueryTrace";

// firstMentionMessageId on the RisingWave Activity read: a member row's anchor
// is rw_inbox_serving_v9's first_mention_message_id; a mention-only row's is
// resolved for the page in one RW read (ignores the read cursor, respects the
// mention suppression position), and is also its firstUnreadMessageId, as in
// the Postgres has_mention lateral. Older serving generations carry neither.

beforeEach(() => {
  uninstallRisingWaveReadReferences();
  __testUnifiedChainTransition.reset();
});

afterEach(() => {
  __testRisingWaveInbox.reset();
  __testUnifiedChainTransition.reset();
  installRisingWaveReadReferences();
});

type Call = { text: string; values: unknown[] };

const MEMBER = "11111111-1111-4111-8111-111111111111";
const OUTSIDER_CHANNEL = "22222222-2222-4222-8222-222222222222";
const OUTSIDER_THREAD = "33333333-3333-4333-8333-333333333333";
const PARENT = "44444444-4444-4444-8444-444444444444";

function pageRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "channel",
    channelId: MEMBER,
    channelName: "general",
    channelType: "channel",
    lastMessageId: "m-10",
    latestActivitySeq: "10",
    firstUnreadMessageId: "m-9",
    lastMessageAt: "2026-10-01 00:00:00.000000+00",
    lastMessagePreview: "hi",
    lastMessageSenderType: "user",
    lastMessageSenderId: "not-a-uuid",
    lastMessageSenderName: null,
    unreadCount: 2,
    threadChannelId: null,
    parentMessageId: null,
    parentChannelId: null,
    parentChannelName: null,
    parentChannelType: null,
    parentMessagePreview: null,
    parentMessageSenderType: null,
    parentMessageSenderId: null,
    latestActivityPreview: "hi",
    latestActivitySenderType: "user",
    latestActivitySenderId: "not-a-uuid",
    latestActivityMessageId: "m-10",
    lastActivityAt: "2026-10-01 00:00:00.000000+00",
    lastReplyAt: null,
    replyCount: null,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByType: null,
    taskClaimedById: null,
    taskClaimedByName: null,
    hasMention: true,
    firstMentionMessageId: "m-9",
    mentionDoneThroughSeq: null,
    servedMentionOnly: false,
    materializedLastReadSeq: "8",
    maxReadSeq: null,
    readStateVersion: null,
    readCursorPresent: false,
    activityAt: "2026-10-01T00:00:00.000Z",
    totalCount: 3,
    totalUnreadCount: 2,
    activeUnreadCount: 2,
    groupChannelIds: [],
    groupChannelNames: [],
    groupChannelTypes: [],
    groupCounts: [],
    groupLastActivityAts: [],
    threadParentChannelIds: null,
    ...overrides,
  };
}

const servingRows = () => [
  pageRow({}),
  pageRow({
    channelId: OUTSIDER_CHANNEL,
    channelName: "outside",
    unreadCount: 0,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    mentionDoneThroughSeq: "20",
    servedMentionOnly: true,
  }),
  pageRow({
    kind: "thread",
    channelId: null,
    channelName: null,
    channelType: null,
    threadChannelId: OUTSIDER_THREAD,
    parentMessageId: PARENT,
    parentChannelId: MEMBER,
    parentChannelName: "general",
    parentChannelType: "channel",
    lastReplyAt: "2026-10-01 00:00:00.000000+00",
    replyCount: 1,
    unreadCount: 0,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    mentionDoneThroughSeq: null,
    servedMentionOnly: true,
  }),
];

test("Activity on RW: member anchors come from serving v9, mention-only anchors from one batched read", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const calls: Call[] = [];
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      if (/rw_message_mentions_v2/.test(text)) {
        return {
          result: {
            // Aggregated in SQL: one row per conversation, its anchor after its own done position.
            rows: [
              { target_id: OUTSIDER_CHANNEL, message_id: "o-25" },
              { target_id: OUTSIDER_THREAD, message_id: "t-3" },
            ],
          },
        };
      }
      return { result: { rows: servingRows() } };
    }) as never,
  });

  const result = await getInboxItems(server.id, owner.id, { filter: "all", humanActivityMuteEnabled: true });

  assert.equal(calls.length, 2, "one serving read, one anchor read");
  assert.match(calls[0]!.text, /i\.first_mention_message_id AS "firstMentionMessageId"/);
  assert.match(calls[0]!.text, /i\.mention_done_through_seq AS "mentionDoneThroughSeq"/);
  // The outer select must hand the anchor read its mention-only flag (the real
  // query, not just these rows: #10896 shipped without it).
  assert.match(calls[0]!.text, /p\."mentionOnly" AS "servedMentionOnly"/);
  // Serving v9 leaves last_activity_at / last_message_at NULL on a mention-only
  // row; its time is activity_at (the mention's). A NULL time failed the
  // Activity page once object rows were merged in (#triage:#159).
  assert.match(calls[0]!.text, /COALESCE\(i\.last_activity_at, i\.activity_at\) AS "lastActivityAtRaw"/);
  assert.match(calls[0]!.text, /COALESCE\(i\.last_message_at, i\.activity_at\) AS "lastMessageAtRaw"/);
  assert.deepEqual(calls[1]!.values[0], owner.id);
  const targetIds = calls[1]!.values[1] as string[];
  const doneThroughSeqs = calls[1]!.values[2] as string[];
  assert.deepEqual([...targetIds].sort(), [OUTSIDER_CHANNEL, OUTSIDER_THREAD].sort());
  assert.deepEqual(
    Object.fromEntries(targetIds.map((id, index) => [id, doneThroughSeqs[index]])),
    { [OUTSIDER_CHANNEL]: "20", [OUTSIDER_THREAD]: "0" },
    "each conversation's own done position, paired by index",
  );
  assert.equal(calls[1]!.values[3], "0", "the coarse cut is the lowest done position of the page");
  assert.match(calls[1]!.text, /WITH ORDINALITY/);
  assert.match(calls[1]!.text, /GROUP BY t\.target_id/);

  const byId = new Map(result.items.map((item) => [item.kind === "thread" || item.kind === "task" ? item.threadChannelId : item.channelId, item]));
  assert.equal(byId.get(MEMBER)?.firstMentionMessageId, "m-9");
  assert.equal(byId.get(MEMBER)?.firstUnreadMessageId, "m-9", "a member row keeps its first unread");
  assert.equal(byId.get(OUTSIDER_CHANNEL)?.firstMentionMessageId, "o-25");
  assert.equal(byId.get(OUTSIDER_CHANNEL)?.firstUnreadMessageId, "o-25");
  assert.equal(byId.get(OUTSIDER_THREAD)?.firstMentionMessageId, "t-3");
  assert.equal(byId.get(OUTSIDER_THREAD)?.firstUnreadMessageId, "t-3");
});

test("Activity on RW: a mention-only row with no notifying mention after done has no anchor", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, text: string) => (/rw_message_mentions_v2/.test(text)
      ? { result: { rows: [] } }
      : { result: { rows: servingRows() } })) as never,
  });

  const result = await getInboxItems(server.id, owner.id, { filter: "all", humanActivityMuteEnabled: true });
  const outsider = result.items.find((item) => item.kind === "channel" && item.channelId === OUTSIDER_CHANNEL);
  assert.equal(outsider?.firstMentionMessageId, null);
  assert.equal(outsider?.firstUnreadMessageId, null);
});

test("Activity on RW: no anchor read when the page has no mention-only row", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const calls: Call[] = [];
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      return { result: { rows: [pageRow({ totalCount: 1 })] } };
    }) as never,
  });

  const result = await getInboxItems(server.id, owner.id, { filter: "all" });
  assert.equal(calls.length, 1);
  assert.equal(result.items[0]?.firstMentionMessageId, "m-9");
});

test("Activity on RW: on the transition fallback (serving v8) the anchors read NULL and nothing is resolved", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const calls: Call[] = [];
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      if (/\brw_inbox_serving_v9\b/.test(text)) {
        throw Object.assign(new Error("table or source not found: rw_inbox_serving_v9"), { code: "42704" });
      }
      return {
        result: {
          rows: servingRows().map((row) => ({ ...row, firstMentionMessageId: null, mentionDoneThroughSeq: null })),
        },
      };
    }) as never,
  });

  const result = await getInboxItems(server.id, owner.id, { filter: "all", humanActivityMuteEnabled: true });

  assert.equal(calls.length, 2, "v9 missing, then v8; no anchor read");
  assert.match(calls[1]!.text, /\brw_inbox_serving_v8\b/);
  assert.doesNotMatch(calls[1]!.text, /first_mention_message_id|mention_done_through_seq/);
  assert.match(calls[1]!.text, /NULL::varchar AS "firstMentionMessageId"/);
  for (const item of result.items) assert.equal(item.firstMentionMessageId, null);
});

test("Activity on RW: the anchor read's span names RisingWave and its connection wait", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, text: string) => ({
      result: { rows: /rw_message_mentions_v2/.test(text) ? [] : servingRows() },
      acquireWaitMs: 12.4,
      poolState: { rw_pool_total: 2, rw_pool_idle: 1, rw_pool_waiting: 0 },
    })) as never,
  });
  const spans = new Map<string, Record<string, unknown> | undefined>();
  const traceQuery: DbQueryTracer = async (queryName, work, onComplete) => {
    const result = await work();
    spans.set(queryName, onComplete?.(result));
    return result;
  };

  await getInboxItems(server.id, owner.id, { filter: "all", humanActivityMuteEnabled: true, traceQuery });

  const anchors = spans.get("channels.inbox_mention_only_anchors");
  assert.equal(anchors?.db_system, "risingwave", "not the tracer's postgresql default");
  assert.equal(anchors?.["rw.acquire_wait_ms"], 12);
  assert.equal(anchors?.["rw.pool.total_count"], 2);
  assert.equal(anchors?.["rw.pool.idle_count"], 1);
  assert.equal(anchors?.["rw.pool.waiting_count"], 0);
});

test("Activity on RW: a failed anchor read is traced as RisingWave too", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, text: string) => {
      if (/rw_message_mentions_v2/.test(text)) throw new Error("connection timeout");
      return { result: { rows: servingRows() } };
    }) as never,
  });
  const failures = new Map<string, Record<string, unknown> | undefined>();
  const traceQuery: DbQueryTracer = async (queryName, work, _onComplete, onError) => {
    try {
      return await work();
    } catch (error) {
      failures.set(queryName, onError?.(error));
      throw error;
    }
  };

  await assert.rejects(getInboxItems(server.id, owner.id, { filter: "all", humanActivityMuteEnabled: true, traceQuery }));
  assert.equal(failures.get("channels.inbox_mention_only_anchors")?.db_system, "risingwave");
});
