import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const servicesDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(servicesDir, "../../../..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
// Every test here reads that DDL/runbook, so the reads happen inside the tests
// and this module still collects there.
const inSourceSnapshot = existsSync(resolve(repoRoot, "RELEASE_SOURCE"));
const ddlPath = resolve(repoRoot, "infra/risingwave/sql/039-risingwave-inbox-v03-suppression-ddl.sql");
const readDdl = () => readFileSync(ddlPath, "utf8");
const productionRunbookPath = resolve(
  repoRoot,
  "rfcs/039-risingwave-inbox-v03-production-mute-upgrade-runbook.md",
);
const productionDdlPath = resolve(
  repoRoot,
  "infra/risingwave/sql/039-risingwave-inbox-v03-production-mute-v3_2-ddl.sql",
);
const productionValidationPath = resolve(
  repoRoot,
  "infra/risingwave/sql/039-risingwave-inbox-v03-production-mute-v3_2-validation.sql",
);
const readProductionRunbook = () => readFileSync(productionRunbookPath, "utf8");
const readProductionDdl = () => readFileSync(productionDdlPath, "utf8");
const readProductionValidation = () => readFileSync(productionValidationPath, "utf8");

type VisibilityFixture = {
  label: string;
  serverId: string;
  userId: string;
  kind: "channel" | "thread";
  sourceChannelId: string;
  storageChannelId: string;
  parentMessageId: string | null;
  latestSeq: number;
  lastReadSeq: number;
  activityAt: number;
  mentionOnly: boolean;
  visibilityReason: string;
};

type MuteFixture = {
  serverId: string;
  receiverType: "user";
  receiverId: string;
  sourceChannelId: string;
  muteFromSeq: number;
};

type SuppressionFixture = {
  serverId: string;
  receiverType: "user";
  receiverId: string;
  targetKind: string;
  targetChannelId: string;
  doneThroughSeq: number | null;
  doneAt: number | null;
  writeSite: string;
};

type MessageFixture = {
  channelId: string;
  seq: number;
  createdAt: number;
};

type MentionFixture = {
  targetType: "user" | "agent";
  targetId: string;
  channelId: string;
  messageSeq: number;
  notifiableAtSend: boolean;
  notifiedAt: number | null;
};

type AllowedRow = {
  label: string;
  serverId: string;
  userId: string;
  kind: string;
  sourceChannelId: string;
  storageChannelId: string;
  parentMessageId: string | null;
  mentionOnly: boolean;
  latestSeq: number | null;
};

type DecisionRow = {
  label: string;
  latestSeq: number | null;
  activityAt: number | null;
  servingVisible: boolean;
  visibilityReason: string;
  suppressionWriteSite: string | null;
};

const toAllowedKey = (row: VisibilityFixture) =>
  [
    row.label,
    row.serverId,
    row.userId,
    row.kind,
    row.sourceChannelId,
    row.storageChannelId,
    row.parentMessageId ?? "",
    String(row.mentionOnly),
  ].join("\0");

const normalizeAllowedRows = (rows: AllowedRow[]) =>
  rows
    .map((row) => ({
      label: row.label,
      serverId: row.serverId,
      userId: row.userId,
      kind: row.kind,
      sourceChannelId: row.sourceChannelId,
      storageChannelId: row.storageChannelId,
      parentMessageId: row.parentMessageId,
      mentionOnly: row.mentionOnly,
      latestSeq: row.latestSeq,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

const piercesMute = (mention: MentionFixture) =>
  mention.targetType === "user" && (mention.notifiableAtSend || mention.notifiedAt !== null);

function originalAllowedRows(
  visibilityRows: VisibilityFixture[],
  muteRows: MuteFixture[],
  messages: MessageFixture[],
  mentions: MentionFixture[],
): AllowedRow[] {
  const rows = new Map<string, AllowedRow>();
  for (const vf of visibilityRows) {
    const mute = muteRows.find(
      (mf) =>
        mf.serverId === vf.serverId &&
        mf.receiverType === "user" &&
        mf.receiverId === vf.userId &&
        mf.sourceChannelId === vf.sourceChannelId,
    );
    if (!mute || vf.kind === "thread") continue;
    const allowedSeqs = messages
      .filter((message) => message.channelId === vf.storageChannelId)
      .filter(
        (message) =>
          message.seq < mute.muteFromSeq ||
          mentions.some(
            (mention) =>
              piercesMute(mention) &&
              mention.targetId === vf.userId &&
              mention.channelId === vf.storageChannelId &&
              mention.messageSeq === message.seq,
          ),
      )
      .map((message) => message.seq);
    rows.set(toAllowedKey(vf), {
      label: vf.label,
      serverId: vf.serverId,
      userId: vf.userId,
      kind: vf.kind,
      sourceChannelId: vf.sourceChannelId,
      storageChannelId: vf.storageChannelId,
      parentMessageId: vf.parentMessageId,
      mentionOnly: vf.mentionOnly,
      latestSeq: allowedSeqs.length > 0 ? Math.max(...allowedSeqs) : null,
    });
  }
  return [...rows.values()];
}

function rewrittenAllowedRows(
  visibilityRows: VisibilityFixture[],
  muteRows: MuteFixture[],
  messages: MessageFixture[],
  mentions: MentionFixture[],
): AllowedRow[] {
  const rows = new Map<string, AllowedRow>();
  for (const vf of visibilityRows) {
    const mute = muteRows.find(
      (mf) =>
        mf.serverId === vf.serverId &&
        mf.receiverType === "user" &&
        mf.receiverId === vf.userId &&
        mf.sourceChannelId === vf.sourceChannelId,
    );
    if (!mute || vf.kind === "thread") continue;

    const preBoundarySeqs = messages
      .filter((message) => message.channelId === vf.storageChannelId && message.seq < mute.muteFromSeq)
      .map((message) => message.seq);
    const mentionPierceSeqs = mentions
      .filter(
        (mention) =>
          piercesMute(mention) &&
          mention.targetId === vf.userId &&
          mention.channelId === vf.storageChannelId &&
          messages.some((message) => message.channelId === mention.channelId && message.seq === mention.messageSeq),
      )
      .map((mention) => mention.messageSeq);
    const allowedSeqs = [...preBoundarySeqs, ...mentionPierceSeqs];
    rows.set(toAllowedKey(vf), {
      label: vf.label,
      serverId: vf.serverId,
      userId: vf.userId,
      kind: vf.kind,
      sourceChannelId: vf.sourceChannelId,
      storageChannelId: vf.storageChannelId,
      parentMessageId: vf.parentMessageId,
      mentionOnly: vf.mentionOnly,
      latestSeq: allowedSeqs.length > 0 ? Math.max(...allowedSeqs) : null,
    });
  }
  return [...rows.values()];
}

function cloakDecisions(
  visibilityRows: VisibilityFixture[],
  muteRows: MuteFixture[],
  suppressionRows: SuppressionFixture[],
  messages: MessageFixture[],
  allowedRows: AllowedRow[],
): DecisionRow[] {
  return visibilityRows.map((vf) => {
    const mute = muteRows.find(
      (mf) =>
        mf.serverId === vf.serverId &&
        mf.receiverType === "user" &&
        mf.receiverId === vf.userId &&
        mf.sourceChannelId === vf.sourceChannelId,
    );
    const allowed = allowedRows.find((row) => row.label === vf.label);
    const suppression = suppressionRows.find(
      (sf) =>
        sf.serverId === vf.serverId &&
        sf.receiverType === "user" &&
        sf.receiverId === vf.userId &&
        sf.targetChannelId === vf.sourceChannelId,
    );
    const effectiveLatestSeq = mute && vf.kind !== "thread" ? (allowed?.latestSeq ?? null) : vf.latestSeq;
    const effectiveActivityAt =
      mute && vf.kind !== "thread"
        ? (messages.find((message) => message.channelId === vf.storageChannelId && message.seq === effectiveLatestSeq)
            ?.createdAt ?? null)
        : vf.activityAt;
    const suppressionLifted =
      suppression === undefined ||
      (suppression.doneThroughSeq !== null &&
        effectiveLatestSeq !== null &&
        effectiveLatestSeq > suppression.doneThroughSeq) ||
      (suppression.doneThroughSeq === null &&
        effectiveActivityAt !== null &&
        suppression.doneAt !== null &&
        effectiveActivityAt > suppression.doneAt);
    const servingVisible = effectiveLatestSeq !== null && suppressionLifted;
    const visibilityReason =
      suppression !== undefined && !suppressionLifted
        ? "suppressed_by_done"
        : mute && vf.kind !== "thread" && effectiveLatestSeq === null
          ? "suppressed_by_mute"
          : vf.visibilityReason;
    return {
      label: vf.label,
      latestSeq: effectiveLatestSeq,
      activityAt: effectiveActivityAt,
      servingVisible,
      visibilityReason,
      suppressionWriteSite: suppression?.writeSite ?? null,
    };
  });
}

test.skipIf(inSourceSnapshot)("RW inbox v0.3 suppression SQL uses one cloak-layer visibility gate", () => {
  const ddl = readDdl();
  for (const token of [
    "SET BACKGROUND_DDL = true",
    "SET STREAMING_PARALLELISM = 8",
    "CREATE MATERIALIZED VIEW rw_inbox_suppression_facts_v3",
    "CREATE MATERIALIZED VIEW rw_inbox_mute_facts_v3",
    "CREATE MATERIALIZED VIEW rw_inbox_cloak_decisions_v3",
    "CREATE MATERIALIZED VIEW rw_inbox_items_v2_suppressed",
    "serving_visible",
    "suppression_write_site",
    "public_thread_mention",
    "public_channel_mention",
    "idx_rw_inbox_suppression_facts_v3_lookup",
    "idx_rw_inbox_mute_facts_v3_lookup",
    "idx_rw_inbox_items_v2_suppressed_user_activity",
  ]) {
    assert.ok(ddl.includes(token), `suppression DDL missing ${token}`);
  }

  assert.ok(
    ddl.includes("FROM rw_inbox_visibility_facts_v3 AS vf"),
    "v0.3 cloak must consume visibility facts before applying suppression",
  );
  assert.ok(
    ddl.includes("LEFT JOIN rw_inbox_suppression_facts_v3 AS sf"),
    "v0.3 cloak must join durable suppression facts",
  );
  assert.ok(
    ddl.includes("LEFT JOIN rw_inbox_mute_facts_v3 AS mf"),
    "v0.3 cloak must join durable activity mute facts",
  );
  assert.ok(
    !ddl.includes("sf.source_channel_id"),
    "suppression joins must not key on local/canonical source_channel_id",
  );
  assert.ok(!ddl.includes("true AS serving_visible"), "v0.3 cloak must not remain a passthrough");
});

test.skipIf(inSourceSnapshot)("RW inbox v0.3 mute SQL mirrors mute_from_seq boundary and mention pierce", () => {
  const ddl = readDdl();
  for (const token of [
    "FROM rw_inbox_target_mute_states",
    "WHERE activity_muted",
    "AND mute_from_seq IS NOT NULL",
    "CREATE MATERIALIZED VIEW rw_inbox_mute_allowed_activity_v3",
    "CREATE INDEX idx_rw_inbox_mute_allowed_activity_v3_lookup",
    "mf.source_channel_id = vf.source_channel_id",
    "vf.kind <> 'thread'",
    "activity_message.seq < mf.mute_from_seq",
    "mention_pierce.target_type = 'user'",
    "mention_pierce.target_id = vf.user_id",
    "mention_pierce.channel_id = vf.storage_channel_id",
    "mention_pierce.message_seq = activity_message.seq",
    "mention_pierce.notifiable_at_send OR mention_pierce.notified_at IS NOT NULL",
    "di.effective_latest_seq AS latest_seq",
    "di.effective_activity_at AS activity_at",
    "di.effective_latest_seq IS NOT NULL",
    "suppressed_by_mute",
    "FROM visible_items AS b",
    "latest_message.seq = b.latest_seq",
    "m.seq <= b.latest_seq",
    "mention.message_seq <= b.latest_seq",
  ]) {
    assert.ok(ddl.includes(token), `mute DDL missing ${token}`);
  }

  assert.ok(
    ddl.indexOf("suppressed_by_done") < ddl.indexOf("suppressed_by_mute"),
    "done suppression must keep precedence over mute in visibility_reason",
  );
  assert.ok(
    !ddl.includes("activity_muted) AS serving_visible"),
    "mute suppression must not collapse to a boolean muted flag",
  );
});

test.skipIf(inSourceSnapshot)("RW inbox v0.3 suppression SQL does not fail open for NULL done seq", () => {
  const ddl = readDdl();
  for (const token of [
    "di.done_through_seq IS NOT NULL AND di.effective_latest_seq > di.done_through_seq",
    "di.done_through_seq IS NULL AND di.effective_activity_at > di.done_at",
  ]) {
    assert.ok(ddl.includes(token), `suppression DDL missing NULL-safe predicate ${token}`);
  }

  assert.ok(
    !ddl.includes("latest_seq > COALESCE(sf.done_through_seq, 0)"),
    "NULL done_through_seq must use the time branch instead of COALESCE fail-open",
  );
});

test.skipIf(inSourceSnapshot)("RW inbox v0.3 materialized views do not embed ORDER BY", () => {
  const ddl = readDdl();
  const viewBodies = ddl.match(/CREATE MATERIALIZED VIEW[\s\S]*?;/g) ?? [];
  assert.ok(viewBodies.length >= 3, "expected all v0.3 materialized view definitions");
  for (const body of viewBodies) {
    assert.doesNotMatch(body, /\bORDER\s+BY\b/i);
  }
});

test.skipIf(inSourceSnapshot)("RW inbox v0.3 production packet builds a parallel v3_2 graph", () => {
  const ddl = readDdl();
  const productionRunbook = readProductionRunbook();
  const productionDdl = readProductionDdl();
  const productionValidation = readProductionValidation();
  for (const token of [
    "rw_inbox_target_mute_states_v2",
    "CREATE MATERIALIZED VIEW rw_inbox_suppression_facts_v3_2",
    "CREATE MATERIALIZED VIEW rw_inbox_mute_facts_v3_2",
    "CREATE MATERIALIZED VIEW rw_inbox_mute_allowed_activity_v3_2",
    "CREATE MATERIALIZED VIEW rw_inbox_cloak_decisions_v3_2",
    "CREATE MATERIALIZED VIEW rw_inbox_items_v2_suppressed_v3_2",
    "CREATE MATERIALIZED VIEW rw_inbox_items_v3_2",
    "activity_muted",
    "prefs_version",
    "reply_counts AS",
    "LEFT JOIN reply_counts AS replies",
    "CASE WHEN b.kind = 'thread' THEN CASE WHEN b.mention_only THEN 0 ELSE COALESCE(replies.reply_count, 0)::int END ELSE NULL::int END AS reply_count",
    "CAST(b.last_read_seq AS INT) AS last_read_seq",
  ]) {
    assert.ok(productionDdl.includes(token), `production DDL missing ${token}`);
  }

  assert.ok(
    ddl.includes("reply_counts AS") &&
      ddl.includes("LEFT JOIN reply_counts AS replies") &&
      ddl.includes("CASE WHEN b.kind = 'thread' THEN CASE WHEN b.mention_only THEN 0 ELSE COALESCE(replies.reply_count, 0)::int END ELSE NULL::int END AS reply_count"),
    "base suppression DDL must project authoritative thread reply_count with active v2 mention-only parity",
  );
  assert.ok(
    !productionDdl.includes("NULL::int AS reply_count") &&
      !ddl.includes("NULL::int AS reply_count"),
    "v2 suppressed serving DDL must not hard-code thread reply_count to NULL",
  );

  for (const activeName of ["rw_inbox_items_v3_1", "rw_inbox_items_v2_suppressed_v3_1"]) {
    assert.ok(
      productionValidation.includes(activeName),
      `production validation must compare candidate shape against active ${activeName}`,
    );
  }
  assert.ok(
    productionValidation.includes("red_count") &&
      productionValidation.includes("c.latest_seq >= mf.mute_from_seq"),
    "production validation must include muted post-boundary red check",
  );
  assert.ok(
    productionValidation.includes("kind = 'thread'") &&
      productionValidation.includes("reply_count IS NULL") &&
      productionValidation.includes("candidate.reply_count IS DISTINCT FROM base.reply_count"),
    "production validation must fail closed on NULL or non-parity thread reply_count",
  );
  assert.ok(
    productionRunbook.includes("Build a parallel graph") &&
      productionRunbook.includes("No production DDL/DML was executed"),
    "production runbook must preserve no-execution and parallel-graph framing",
  );
  assert.ok(
    productionRunbook.includes("authoritative thread `reply_count` parity") &&
      productionRunbook.includes("kind = 'thread' AND reply_count IS NULL") &&
      productionRunbook.includes("thread `reply_count` matches active `rw_inbox_items_v2`"),
    "production runbook must document v2 thread reply_count gates",
  );
  assert.ok(
    productionRunbook.includes("Before any v3 serving enrollment") &&
      productionRunbook.includes("unread counts and unread mention counts must be anchored") &&
      productionDdl.includes("Before any v3 serving enrollment, cap unread counts"),
    "production packet must record the v3 unread-count enrollment prerequisite",
  );
  assert.ok(
    !productionDdl.includes("CREATE MATERIALIZED VIEW rw_inbox_items_v3 AS"),
    "production DDL must not overwrite the active unsuffixed v3 serving object",
  );
});

test.skipIf(inSourceSnapshot)("production v3_2 mute allowed-activity rewrite is semantically equivalent to original boundary logic", () => {
  const productionDdl = readProductionDdl();
  const visibilityRows: VisibilityFixture[] = [
    {
      label: "boundary-before",
      serverId: "s1",
      userId: "u1",
      kind: "channel",
      sourceChannelId: "c1",
      storageChannelId: "c1",
      parentMessageId: null,
      latestSeq: 7,
      lastReadSeq: 0,
      activityAt: 700,
      mentionOnly: false,
      visibilityReason: "channel_member",
    },
    {
      label: "pierce-at-boundary",
      serverId: "s1",
      userId: "u1",
      kind: "channel",
      sourceChannelId: "c2",
      storageChannelId: "c2",
      parentMessageId: null,
      latestSeq: 11,
      lastReadSeq: 0,
      activityAt: 1100,
      mentionOnly: false,
      visibilityReason: "channel_member",
    },
    {
      label: "buried-mention",
      serverId: "s1",
      userId: "u1",
      kind: "channel",
      sourceChannelId: "c3",
      storageChannelId: "c3",
      parentMessageId: null,
      latestSeq: 13,
      lastReadSeq: 0,
      activityAt: 1300,
      mentionOnly: false,
      visibilityReason: "channel_member",
    },
    {
      label: "done-compose",
      serverId: "s1",
      userId: "u1",
      kind: "channel",
      sourceChannelId: "c4",
      storageChannelId: "c4",
      parentMessageId: null,
      latestSeq: 5,
      lastReadSeq: 0,
      activityAt: 500,
      mentionOnly: false,
      visibilityReason: "channel_member",
    },
    {
      label: "thread-excluded",
      serverId: "s1",
      userId: "u1",
      kind: "thread",
      sourceChannelId: "t1",
      storageChannelId: "t1",
      parentMessageId: "pm1",
      latestSeq: 20,
      lastReadSeq: 0,
      activityAt: 2000,
      mentionOnly: false,
      visibilityReason: "followed_thread",
    },
  ];
  const muteRows: MuteFixture[] = [
    { serverId: "s1", receiverType: "user", receiverId: "u1", sourceChannelId: "c1", muteFromSeq: 8 },
    { serverId: "s1", receiverType: "user", receiverId: "u1", sourceChannelId: "c2", muteFromSeq: 10 },
    { serverId: "s1", receiverType: "user", receiverId: "u1", sourceChannelId: "c3", muteFromSeq: 10 },
    { serverId: "s1", receiverType: "user", receiverId: "u1", sourceChannelId: "c4", muteFromSeq: 4 },
    { serverId: "s1", receiverType: "user", receiverId: "u1", sourceChannelId: "t1", muteFromSeq: 10 },
  ];
  const messages: MessageFixture[] = [
    { channelId: "c1", seq: 7, createdAt: 700 },
    { channelId: "c1", seq: 8, createdAt: 800 },
    { channelId: "c2", seq: 9, createdAt: 900 },
    { channelId: "c2", seq: 10, createdAt: 1000 },
    { channelId: "c2", seq: 11, createdAt: 1100 },
    { channelId: "c3", seq: 9, createdAt: 900 },
    { channelId: "c3", seq: 11, createdAt: 1100 },
    { channelId: "c3", seq: 13, createdAt: 1300 },
    { channelId: "c4", seq: 3, createdAt: 300 },
    { channelId: "c4", seq: 5, createdAt: 500 },
    { channelId: "t1", seq: 20, createdAt: 2000 },
  ];
  const mentions: MentionFixture[] = [
    {
      targetType: "user",
      targetId: "u1",
      channelId: "c2",
      messageSeq: 10,
      notifiableAtSend: true,
      notifiedAt: null,
    },
    {
      targetType: "user",
      targetId: "u1",
      channelId: "c3",
      messageSeq: 11,
      notifiableAtSend: false,
      notifiedAt: 1101,
    },
    {
      targetType: "agent",
      targetId: "u1",
      channelId: "c3",
      messageSeq: 13,
      notifiableAtSend: true,
      notifiedAt: null,
    },
    {
      targetType: "user",
      targetId: "u1",
      channelId: "c3",
      messageSeq: 14,
      notifiableAtSend: true,
      notifiedAt: null,
    },
  ];
  const suppressionRows: SuppressionFixture[] = [
    {
      serverId: "s1",
      receiverType: "user",
      receiverId: "u1",
      targetKind: "channel",
      targetChannelId: "c4",
      doneThroughSeq: 3,
      doneAt: null,
      writeSite: "fixture",
    },
  ];

  const originalAllowed = originalAllowedRows(visibilityRows, muteRows, messages, mentions);
  const rewrittenAllowed = rewrittenAllowedRows(visibilityRows, muteRows, messages, mentions);
  assert.deepEqual(normalizeAllowedRows(rewrittenAllowed), normalizeAllowedRows(originalAllowed));
  assert.deepEqual(
    cloakDecisions(visibilityRows, muteRows, suppressionRows, messages, rewrittenAllowed),
    cloakDecisions(visibilityRows, muteRows, suppressionRows, messages, originalAllowed),
  );
  assert.deepEqual(
    cloakDecisions(visibilityRows, muteRows, suppressionRows, messages, rewrittenAllowed),
    [
      {
        label: "boundary-before",
        latestSeq: 7,
        activityAt: 700,
        servingVisible: true,
        visibilityReason: "channel_member",
        suppressionWriteSite: null,
      },
      {
        label: "pierce-at-boundary",
        latestSeq: 10,
        activityAt: 1000,
        servingVisible: true,
        visibilityReason: "channel_member",
        suppressionWriteSite: null,
      },
      {
        label: "buried-mention",
        latestSeq: 11,
        activityAt: 1100,
        servingVisible: true,
        visibilityReason: "channel_member",
        suppressionWriteSite: null,
      },
      {
        label: "done-compose",
        latestSeq: 3,
        activityAt: 300,
        servingVisible: false,
        visibilityReason: "suppressed_by_done",
        suppressionWriteSite: "fixture",
      },
      {
        label: "thread-excluded",
        latestSeq: 20,
        activityAt: 2000,
        servingVisible: true,
        visibilityReason: "followed_thread",
        suppressionWriteSite: null,
      },
    ],
  );
  assert.ok(
      productionDdl.includes("ASOF LEFT JOIN rw_messages AS activity_message") &&
      productionDdl.includes("allowed_activity AS") &&
      productionDdl.includes("UNION ALL") &&
      productionDdl.includes("mention_pierce.target_type = 'user'") &&
      productionDdl.includes("mention_message.seq = mention_pierce.message_seq") &&
      !productionDdl.includes("OR EXISTS"),
    "production rewrite must use ASOF boundary branch plus equality-join mention pierce branch",
  );
});
