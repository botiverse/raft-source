import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildRepairGroups,
  DELETE_DUPLICATE_DM_IDENTITIES_SQL,
  MERGE_INBOX_SUPPRESSION_STATES_SQL,
  parseDetailedTsv,
  pickCanonicalChannel,
  rewritePinnedRefs,
  rewriteStringIdArray,
  type DetailedRow,
} from "../../scripts/repair-dm-duplicate-channels.js";

const baseRow: DetailedRow = {
  serverId: "00000000-0000-4000-8000-000000000001",
  dmKind: "self_user_dm",
  peerKey: "00000000-0000-4000-8000-000000000101",
  dmIdentityKind: null,
  dmIdentityKey: null,
  channelId: "00000000-0000-4000-8000-000000000201",
  createdAt: "2026-07-01T00:00:00.000Z",
  deletedAt: null,
  messageCount: 0,
  agentSenderMessageCount: 0,
  lastMessageAt: null,
  attachmentCount: 0,
  taskCount: 0,
  threadParentCount: 0,
  mentionCount: 0,
  userReadCursorCount: 0,
  userInboxStateCount: 0,
  muteCount: 0,
  suppressionCount: 0,
  notificationFactCount: 0,
  servingRowCount: 0,
  serverMemberJsonRefCount: 0,
};

function row(overrides: Partial<DetailedRow>): DetailedRow {
  return { ...baseRow, ...overrides };
}

test("parseDetailedTsv accepts Ray's detailed.tsv shape", () => {
  const parsed = parseDetailedTsv([
    "server_id\tdm_kind\tpeer_key\thuman_count\tagent_count\thuman_ids\tagent_ids\tactive_channel_count\tchannel_id\tcreated_at\tdeleted_at\tmessage_count\tlast_message_at\tattachment_count\ttask_count\tthread_parent_count\tmention_count\tuser_read_cursor_count\tuser_inbox_state_count\tmute_count\tsuppression_count\tnotification_fact_count\tserving_row_count\tserver_member_json_ref_count",
    "00000000-0000-4000-8000-000000000001\tself_user_dm\t00000000-0000-4000-8000-000000000101\t1\t0\t{00000000-0000-4000-8000-000000000101}\t{}\t2\t00000000-0000-4000-8000-000000000201\t2026-07-01 00:00:00+00\t\\N\t12\t2026-07-02 00:00:00+00\t2\t0\t1\t3\t4\t5\t0\t6\t7\t8\t9",
  ].join("\n"));

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.deletedAt, null);
  assert.equal(parsed[0]!.messageCount, 12);
  assert.equal(parsed[0]!.dmIdentityKind, null);
  assert.equal(parsed[0]!.agentSenderMessageCount, 0);
  assert.equal(parsed[0]!.threadParentCount, 1);
  assert.equal(parsed[0]!.serverMemberJsonRefCount, 9);
});

test("canonical selection follows latest message, count, created_at, then id", () => {
  const latest = row({
    channelId: "00000000-0000-4000-8000-000000000204",
    messageCount: 1,
    lastMessageAt: "2026-07-04T00:00:00.000Z",
    createdAt: "2026-07-04T00:00:00.000Z",
  });
  const mostMessages = row({
    channelId: "00000000-0000-4000-8000-000000000203",
    messageCount: 99,
    lastMessageAt: "2026-07-03T00:00:00.000Z",
    createdAt: "2026-07-03T00:00:00.000Z",
  });
  assert.equal(pickCanonicalChannel([mostMessages, latest]).channelId, latest.channelId);

  const tiedLatestLowerCount = row({
    channelId: "00000000-0000-4000-8000-000000000205",
    messageCount: 1,
    lastMessageAt: "2026-07-04T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(pickCanonicalChannel([tiedLatestLowerCount, latest]).channelId, tiedLatestLowerCount.channelId);

  const earlierCreated = row({
    channelId: "00000000-0000-4000-8000-000000000206",
    messageCount: 1,
    lastMessageAt: "2026-07-04T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(pickCanonicalChannel([latest, earlierCreated]).channelId, earlierCreated.channelId);

  const lowerId = row({
    channelId: "00000000-0000-4000-8000-000000000200",
    messageCount: 1,
    lastMessageAt: "2026-07-04T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(pickCanonicalChannel([earlierCreated, lowerId]).channelId, lowerId.channelId);
});

test("buildRepairGroups classifies zero-message, regular, and heavy groups", () => {
  const zero = [
    row({ peerKey: "zero", channelId: "00000000-0000-4000-8000-000000000211", createdAt: "2026-07-02T00:00:00.000Z" }),
    row({ peerKey: "zero", channelId: "00000000-0000-4000-8000-000000000212", createdAt: "2026-07-01T00:00:00.000Z" }),
  ];
  const regular = [
    row({ peerKey: "regular", channelId: "00000000-0000-4000-8000-000000000221", messageCount: 10, lastMessageAt: "2026-07-02T00:00:00.000Z" }),
    row({ peerKey: "regular", channelId: "00000000-0000-4000-8000-000000000222", messageCount: 12, lastMessageAt: "2026-07-03T00:00:00.000Z" }),
  ];
  const heavyMessages = [
    row({ peerKey: "heavy-messages", channelId: "00000000-0000-4000-8000-000000000231", messageCount: 50, lastMessageAt: "2026-07-02T00:00:00.000Z" }),
    row({ peerKey: "heavy-messages", channelId: "00000000-0000-4000-8000-000000000232", messageCount: 1, lastMessageAt: "2026-07-03T00:00:00.000Z" }),
  ];
  const heavyRefs = [
    row({ peerKey: "heavy-refs", channelId: "00000000-0000-4000-8000-000000000241", messageCount: 1, serverMemberJsonRefCount: 3, lastMessageAt: "2026-07-02T00:00:00.000Z" }),
    row({ peerKey: "heavy-refs", channelId: "00000000-0000-4000-8000-000000000242", messageCount: 1, lastMessageAt: "2026-07-03T00:00:00.000Z" }),
  ];

  const groups = buildRepairGroups([...zero, ...regular, ...heavyMessages, ...heavyRefs]);
  const byPeer = new Map(groups.map((group) => [group.peerKey, group]));

  assert.equal(byPeer.get("zero")!.groupClass, "zero_message");
  assert.equal(byPeer.get("zero")!.canonicalChannelId, "00000000-0000-4000-8000-000000000212");
  assert.equal(byPeer.get("regular")!.groupClass, "regular");
  assert.equal(byPeer.get("heavy-messages")!.groupClass, "heavy_refs_or_messages");
  assert.equal(byPeer.get("heavy-refs")!.groupClass, "heavy_refs_or_messages");
});

test("buildRepairGroups includes deleted duplicate rows but canonicalizes only active channels", () => {
  const activeOlder = row({
    peerKey: "with-deleted",
    channelId: "00000000-0000-4000-8000-000000000251",
    messageCount: 1,
    lastMessageAt: "2026-07-01T00:00:00.000Z",
  });
  const activeNewer = row({
    peerKey: "with-deleted",
    channelId: "00000000-0000-4000-8000-000000000252",
    messageCount: 2,
    lastMessageAt: "2026-07-02T00:00:00.000Z",
  });
  const deletedMostMessages = row({
    peerKey: "with-deleted",
    channelId: "00000000-0000-4000-8000-000000000253",
    deletedAt: "2026-07-03T00:00:00.000Z",
    messageCount: 99,
    lastMessageAt: "2026-07-03T00:00:00.000Z",
  });

  const [group] = buildRepairGroups([activeOlder, activeNewer, deletedMostMessages]);

  assert.equal(group!.canonicalChannelId, activeNewer.channelId);
  assert.deepEqual(group!.activeChannelIds, [activeOlder.channelId, activeNewer.channelId]);
  assert.deepEqual(group!.duplicateChannelIds.sort(), [activeOlder.channelId, deletedMostMessages.channelId].sort());
  assert.equal(group!.totalMessages, 102);
  assert.equal(group!.groupClass, "heavy_refs_or_messages");
});

test("self-DM repair requires explicit provenance even with zero agent messages", () => {
  const ambiguous = [
    row({ peerKey: "ambiguous", channelId: "00000000-0000-4000-8000-000000000261" }),
    row({ peerKey: "ambiguous", channelId: "00000000-0000-4000-8000-000000000262" }),
  ];
  const [group] = buildRepairGroups(ambiguous);
  assert.equal(group?.disposition, "quarantine");
  assert.equal(group?.quarantineReason, "missing_explicit_provenance");
});

test("agent sender evidence quarantines self-shaped groups", () => {
  const suspicious = [
    row({
      peerKey: "suspicious",
      channelId: "00000000-0000-4000-8000-000000000271",
      agentSenderMessageCount: 1,
    }),
    row({ peerKey: "suspicious", channelId: "00000000-0000-4000-8000-000000000272" }),
  ];
  const [group] = buildRepairGroups(suspicious);
  assert.equal(group?.disposition, "quarantine");
  assert.equal(group?.quarantineReason, "agent_sender_evidence");
});

test("only matching explicit human_self identities make singleton groups repairable", () => {
  const peerKey = "00000000-0000-4000-8000-000000000101";
  const explicit = [
    row({
      peerKey,
      dmIdentityKind: "human_self",
      dmIdentityKey: peerKey,
      channelId: "00000000-0000-4000-8000-000000000281",
    }),
    row({
      peerKey,
      dmIdentityKind: "human_self",
      dmIdentityKey: peerKey,
      channelId: "00000000-0000-4000-8000-000000000282",
    }),
  ];
  const [repairable] = buildRepairGroups(explicit);
  assert.equal(repairable?.disposition, "repair");
  assert.equal(repairable?.quarantineReason, null);

  const [conflicted] = buildRepairGroups([
    explicit[0]!,
    { ...explicit[1]!, dmIdentityKind: "human_agent" },
  ]);
  assert.equal(conflicted?.disposition, "quarantine");
  assert.equal(conflicted?.quarantineReason, "identity_conflict");
});

test("two-human groups remain repairable without legacy provenance", () => {
  const rows = [
    row({
      dmKind: "user_user_dm",
      peerKey: "user-a,user-b",
      channelId: "00000000-0000-4000-8000-000000000291",
    }),
    row({
      dmKind: "user_user_dm",
      peerKey: "user-a,user-b",
      channelId: "00000000-0000-4000-8000-000000000292",
    }),
  ];
  const [group] = buildRepairGroups(rows);
  assert.equal(group?.disposition, "repair");
  assert.equal(group?.quarantineReason, null);
});

test("server_member JSON rewrites map duplicate channel ids and dedupe in order", () => {
  const duplicateIds = new Set([
    "00000000-0000-4000-8000-000000000301",
    "00000000-0000-4000-8000-000000000302",
  ]);
  const canonicalId = "00000000-0000-4000-8000-000000000300";

  assert.deepEqual(
    rewriteStringIdArray([
      "00000000-0000-4000-8000-000000000301",
      "00000000-0000-4000-8000-000000000300",
      "00000000-0000-4000-8000-000000000302",
      "00000000-0000-4000-8000-000000000399",
    ], canonicalId, duplicateIds),
    [
      "00000000-0000-4000-8000-000000000300",
      "00000000-0000-4000-8000-000000000399",
    ],
  );

  assert.deepEqual(
    rewritePinnedRefs([
      { kind: "channel", id: "00000000-0000-4000-8000-000000000301" },
      { kind: "channel", id: "00000000-0000-4000-8000-000000000300", label: "canonical" },
      { kind: "agent", id: "00000000-0000-4000-8000-000000000301" },
      { kind: "channel", id: "00000000-0000-4000-8000-000000000399" },
    ], canonicalId, duplicateIds),
    [
      { kind: "channel", id: "00000000-0000-4000-8000-000000000300" },
      { kind: "agent", id: "00000000-0000-4000-8000-000000000301" },
      { kind: "channel", id: "00000000-0000-4000-8000-000000000399" },
    ],
  );
});

test("suppression-state merge uses target_kind schema column", () => {
  assert.match(MERGE_INBOX_SUPPRESSION_STATES_SQL, /\btarget_kind\b/);
  assert.doesNotMatch(MERGE_INBOX_SUPPRESSION_STATES_SQL, /\bkind\s*,\s*target_kind\b/);
});

test("apply deletes duplicate DM identities so tombstones cannot be revived", () => {
  assert.match(DELETE_DUPLICATE_DM_IDENTITIES_SQL, /DELETE FROM dm_channel_identities/);
  assert.match(DELETE_DUPLICATE_DM_IDENTITIES_SQL, /channel_id = ANY\(\$1::uuid\[\]\)/);
});
