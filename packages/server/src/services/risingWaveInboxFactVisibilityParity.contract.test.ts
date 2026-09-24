import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const servicesDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(servicesDir, "../../../..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
// The RisingWave DDL is read inside that test so this module still collects there.
const inSourceSnapshot = existsSync(resolve(repoRoot, "RELEASE_SOURCE"));
const readDdl = () =>
  readFileSync(
    resolve(repoRoot, "infra/risingwave/sql/056-risingwave-inbox-fact-visibility-v3_4-ddl.sql"),
    "utf8",
  );
const channelService = readFileSync(resolve(servicesDir, "channelService.ts"), "utf8");
const inboxPolicyModel = readFileSync(resolve(servicesDir, "inboxPolicyModel.ts"), "utf8");
const devSeed = readFileSync(resolve(repoRoot, "packages/server/scripts/seed.ts"), "utf8");
const raftdev = readFileSync(resolve(repoRoot, "scripts/dev/raftdev.ts"), "utf8");

type Kind = "channel" | "dm" | "thread";

type CandidateRow = {
  serverId: string;
  userId: string;
  kind: Kind;
  channelId: string | null;
  threadChannelId: string | null;
  activityAt: number;
  unreadCount: number;
  hasMention: boolean;
  cursor: { lastReadSeq: number; version: number };
  reason: "member_channel" | "dm" | "joint" | "followed_thread" | "public_channel_mention" | "public_thread_mention";
};

type FactTarget = {
  serverId: string;
  userId: string;
  kind: Kind;
  sourceChannelId: string;
};

const sourceChannelId = (row: CandidateRow) => row.threadChannelId ?? row.channelId;

const key = (serverId: string, userId: string, kind: Kind, sourceId: string) =>
  `${serverId}\0${userId}\0${kind}\0${sourceId}`;

function factVisibleRows(rows: readonly CandidateRow[], facts: readonly FactTarget[]) {
  const targetKeys = new Set(facts.map((fact) =>
    key(fact.serverId, fact.userId, fact.kind, fact.sourceChannelId)
  ));
  return rows
    .filter((row) => {
      const sourceId = sourceChannelId(row);
      return sourceId !== null && targetKeys.has(key(row.serverId, row.userId, row.kind, sourceId));
    })
    .sort((a, b) => b.activityAt - a.activityAt || a.kind.localeCompare(b.kind) || sourceChannelId(a)!.localeCompare(sourceChannelId(b)!));
}

test.skipIf(inSourceSnapshot)("RW v3_4 visibility intersects the existing access graph with canonical fact targets", () => {
  const ddl = readDdl();
  assert.match(ddl, /FROM rw_inbox_notification_facts_v1 AS fact/);
  assert.match(ddl, /WHERE fact\.receiver_type = 'user'/);
  assert.match(
    ddl,
    /GROUP BY\s+fact\.server_id,\s+fact\.receiver_id,\s+fact\.kind,\s+fact\.source_channel_id/,
    "multiple notification facts for one receiver target must not duplicate an Activity row",
  );
  assert.match(ddl, /FROM rw_inbox_items_v2_suppressed_v3_3 AS base/);
  assert.match(
    ddl,
    /INNER JOIN rw_inbox_fact_visibility_targets_v1 AS fact_target/,
    "fact targets are a required positive-visibility gate; a LEFT JOIN would restore membership-only rows",
  );
  assert.match(ddl, /fact_target\.server_id = base\.server_id/);
  assert.match(ddl, /fact_target\.user_id = base\.user_id/);
  assert.match(ddl, /fact_target\.kind = base\.kind/);
  assert.match(
    ddl,
    /fact_target\.source_channel_id = COALESCE\(\s*base\.thread_channel_id,\s*base\.channel_id\s*\)/,
    "thread facts map to thread_channel_id while channel/DM/joint facts map to channel_id",
  );
  assert.doesNotMatch(ddl, /rw_channel_humans/, "membership must not be a sufficient v3_4 visibility fact");
  assert.doesNotMatch(ddl, /\b(?:DROP|ALTER)\b/, "the successor artifact must remain additive and rollbackable");
});

test("server selects the fact-driven versioned view and retains fail-soft PG fallback", () => {
  assert.match(
    channelService,
    /RW_INBOX_ITEMS_V2_SERVING_VIEW = "rw_inbox_items_v2_suppressed_v3_4"/,
  );
  assert.match(channelService, /tryReadRisingWaveInboxWithFailSoft/);
  assert.match(channelService, /getInboxItemsFromServingRows/);
});

test("canonical projector census maps chat/joint/DM to channel and follow/mention to thread", () => {
  assert.match(
    inboxPolicyModel,
    /kind: channel\.type === "dm" \? "dm" : "channel",\s+sourceChannelId: channel\.id,\s+storageChannelId: channel\.id/,
    "channel/private/joint/DM rows use their local channel id as the source target",
  );
  assert.match(
    inboxPolicyModel,
    /function projectFollowedThreadRows[\s\S]*?kind: "thread",\s+sourceChannelId: channel\.id,\s+storageChannelId: channel\.id/,
    "followed threads use the local thread channel id",
  );
  assert.match(
    inboxPolicyModel,
    /function projectMentionOnlyRows[\s\S]*?kind: "channel",\s+sourceChannelId: channel\.id[\s\S]*?kind: "thread",\s+sourceChannelId: channel\.id/,
    "mention-only channels and threads use the same local source keys",
  );
});

test("raftdev direct seed inserts establish canonical fact targets without making membership sufficient", () => {
  assert.match(devSeed, /const ensureSeedVisibilityFact = async/);
  assert.match(devSeed, /\.insert\(inboxNotificationFacts\)/);
  assert.match(devSeed, /sourceChannelId: target\.sourceChannelId/);
  assert.match(devSeed, /\.orderBy\(desc\(messages\.seq\)\)/);
  assert.match(devSeed, /if \(target\.type === "thread"\) continue/);
  assert.match(devSeed, /isNull\(threadFollows\.doneAt\)/);
  assert.match(devSeed, /isNull\(threadFollows\.unfollowedAt\)/);
  assert.match(devSeed, /\.onConflictDoNothing\(\)/);
});

test("raftdev strict parity enables only the verifier candidate read", () => {
  assert.match(
    raftdev,
    /runSeededRisingWaveParity[\s\S]*?RISINGWAVE_INBOX_RFC056_SERVING_MODE: "on"/,
  );
  assert.match(raftdev, /It does not enable RW serving for the environment/);
});

test("PG1/RW3 referent: fact authority removes exactly two silent membership false positives", () => {
  const account = { serverId: "6a3d9f27-referent", userId: "3b47c067-referent" };
  const candidates: CandidateRow[] = [
    { ...account, kind: "channel", channelId: "e82270bb-fact-backed", threadChannelId: null, activityAt: 30, unreadCount: 4, hasMention: false, cursor: { lastReadSeq: 8, version: 2 }, reason: "member_channel" },
    { ...account, kind: "channel", channelId: "263c5161-silent", threadChannelId: null, activityAt: 20, unreadCount: 13, hasMention: false, cursor: { lastReadSeq: 0, version: 0 }, reason: "member_channel" },
    { ...account, kind: "channel", channelId: "1887adbe-silent", threadChannelId: null, activityAt: 10, unreadCount: 20, hasMention: false, cursor: { lastReadSeq: 0, version: 0 }, reason: "member_channel" },
  ];
  const facts: FactTarget[] = [
    { ...account, kind: "channel", sourceChannelId: "e82270bb-fact-backed" },
    // Duplicate historical/current facts collapse to the same target key.
    { ...account, kind: "channel", sourceChannelId: "e82270bb-fact-backed" },
  ];

  assert.equal(candidates.length, 3, "old membership-scan shape must remain RED at RW3");
  const visible = factVisibleRows(candidates, facts);
  assert.deepEqual(visible, [candidates[0]]);
  assert.equal(visible.length, 1);
  assert.equal(visible.reduce((sum, row) => sum + row.unreadCount, 0), 4);
});

test("cross-account full rows/order/cursor/count stay byte-equivalent for fact-backed targets", () => {
  const referent = { serverId: "referent-server", userId: "referent-user" };
  const control = { serverId: "control-server", userId: "referent-user" };
  const candidates: CandidateRow[] = [
    { ...referent, kind: "channel", channelId: "referent-visible", threadChannelId: null, activityAt: 80, unreadCount: 2, hasMention: true, cursor: { lastReadSeq: 18, version: 4 }, reason: "member_channel" },
    { ...referent, kind: "channel", channelId: "referent-silent", threadChannelId: null, activityAt: 90, unreadCount: 9, hasMention: false, cursor: { lastReadSeq: 0, version: 0 }, reason: "member_channel" },
    { ...control, kind: "channel", channelId: "8a7f192c-control", threadChannelId: null, activityAt: 100, unreadCount: 7, hasMention: false, cursor: { lastReadSeq: 91, version: 12 }, reason: "member_channel" },
    { ...control, kind: "thread", channelId: null, threadChannelId: "control-thread", activityAt: 70, unreadCount: 1, hasMention: true, cursor: { lastReadSeq: 3, version: 6 }, reason: "followed_thread" },
  ];
  const facts: FactTarget[] = [
    { ...referent, kind: "channel", sourceChannelId: "referent-visible" },
    { ...control, kind: "channel", sourceChannelId: "8a7f192c-control" },
    { ...control, kind: "thread", sourceChannelId: "control-thread" },
  ];

  const visible = factVisibleRows(candidates, facts);
  assert.deepEqual(visible, [candidates[2], candidates[0], candidates[3]]);
  assert.deepEqual(
    visible.map(({ channelId, threadChannelId, activityAt, unreadCount, hasMention, cursor }) => ({
      channelId,
      threadChannelId,
      activityAt,
      unreadCount,
      hasMention,
      cursor,
    })),
    [candidates[2], candidates[0], candidates[3]].map(({ channelId, threadChannelId, activityAt, unreadCount, hasMention, cursor }) => ({
      channelId,
      threadChannelId,
      activityAt,
      unreadCount,
      hasMention,
      cursor,
    })),
    "the visibility cut may remove rows but must not rewrite kept payload/order/cursor fields",
  );
  assert.deepEqual(
    {
      totalCount: visible.length,
      totalUnreadCount: visible.reduce((sum, row) => sum + row.unreadCount, 0),
      mentionedCount: visible.filter((row) => row.hasMention).length,
    },
    { totalCount: 3, totalUnreadCount: 10, mentionedCount: 2 },
  );
});

test("fact-backed mention/follow/joint/DM targets survive the visibility correction", () => {
  const account = { serverId: "semantic-server", userId: "semantic-user" };
  const candidates: CandidateRow[] = [
    { ...account, kind: "dm", channelId: "dm", threadChannelId: null, activityAt: 60, unreadCount: 1, hasMention: false, cursor: { lastReadSeq: 1, version: 1 }, reason: "dm" },
    { ...account, kind: "channel", channelId: "joint-local", threadChannelId: null, activityAt: 50, unreadCount: 2, hasMention: false, cursor: { lastReadSeq: 2, version: 2 }, reason: "joint" },
    { ...account, kind: "channel", channelId: "public-mention", threadChannelId: null, activityAt: 40, unreadCount: 0, hasMention: true, cursor: { lastReadSeq: 0, version: 0 }, reason: "public_channel_mention" },
    { ...account, kind: "thread", channelId: null, threadChannelId: "followed-thread", activityAt: 30, unreadCount: 3, hasMention: false, cursor: { lastReadSeq: 3, version: 3 }, reason: "followed_thread" },
    { ...account, kind: "thread", channelId: null, threadChannelId: "mentioned-thread", activityAt: 20, unreadCount: 0, hasMention: true, cursor: { lastReadSeq: 0, version: 0 }, reason: "public_thread_mention" },
  ];
  const facts = candidates.map((row): FactTarget => ({
    ...account,
    kind: row.kind,
    sourceChannelId: sourceChannelId(row)!,
  }));

  assert.deepEqual(factVisibleRows(candidates, facts), candidates);
  assert.deepEqual(factVisibleRows(candidates, facts).map((row) => row.reason), [
    "dm",
    "joint",
    "public_channel_mention",
    "followed_thread",
    "public_thread_mention",
  ]);
});
