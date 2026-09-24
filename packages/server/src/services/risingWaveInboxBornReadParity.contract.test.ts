import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const servicesDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(servicesDir, "../../../..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
// The RisingWave DDL is read inside those tests so this module still collects there.
const inSourceSnapshot = existsSync(resolve(repoRoot, "RELEASE_SOURCE"));
const readRisingWaveSql = (name: string) =>
  readFileSync(resolve(repoRoot, "infra/risingwave/sql", name), "utf8");
const readDdl = () => readRisingWaveSql("039-risingwave-inbox-born-read-v3_3-ddl.sql");
const readProductionMuteDdl = () =>
  readRisingWaveSql("039-risingwave-inbox-v03-production-mute-v3_2-ddl.sql");
const readProductionVisibilityDdl = () =>
  readRisingWaveSql("024-risingwave-inbox-v3-production-definition-2026-07-07.sql");
const channelService = readFileSync(resolve(servicesDir, "channelService.ts"), "utf8");
const activitySyncService = readFileSync(resolve(servicesDir, "activitySyncService.ts"), "utf8");

function materializedViewBody(sql: string, viewName: string): string {
  const match = sql.match(new RegExp(`CREATE MATERIALIZED VIEW ${viewName} AS\\s+([\\s\\S]*?);`));
  assert.ok(match, `missing materialized view ${viewName}`);
  return match[1];
}

test.skipIf(inSourceSnapshot)("RW v3_3 unread projection consumes receiver-scoped notification eligibility", () => {
  const ddl = readDdl();
  assert.match(
    ddl,
    /CREATE TABLE rw_inbox_notification_facts_v1[\s\S]+FROM slock_neon_cdc TABLE 'public\.inbox_notification_facts'/,
  );
  assert.match(ddl, /fact\.receiver_type = 'user'/);
  assert.match(ddl, /fact\.receiver_id = b\.user_id/);
  assert.match(ddl, /fact\.source_channel_id = b\.source_channel_id/);
  assert.match(ddl, /fact\.message_id = m\.id/);
  assert.match(
    ddl,
    /COALESCE\(\s*fact\.unread_eligible,\s*NOT \(m\.sender_type = 'user' AND m\.sender_id = b\.user_id\)\s*\)/,
    "present facts must be authoritative while missing historical facts preserve legacy self-sender behavior",
  );
});

test.skipIf(inSourceSnapshot)("RW v3_3 keeps Activity visibility/latest fields and changes only unread projection", () => {
  const ddl = readDdl();
  assert.match(ddl, /FROM rw_inbox_items_v2_suppressed_v3_2 AS base/);
  assert.match(ddl, /base\.latest_activity_message_id/);
  assert.match(ddl, /base\.last_activity_at/);
  assert.match(ddl, /CASE\s+WHEN base\.mention_only THEN 0\s+ELSE COALESCE\(corrected\.unread_count, 0\)/);
  assert.match(ddl, /ELSE first_unread\.id\s+END AS first_unread_message_id/);
  assert.doesNotMatch(ddl, /\bDROP\b|\bALTER\b/, "the production candidate must remain additive and rollbackable");
});

test("server serves the versioned born-read projection and retains fail-soft PG fallback", () => {
  assert.match(
    channelService,
    /RW_INBOX_ITEMS_V2_SERVING_VIEW = "rw_inbox_items_v2_suppressed_v3_4"/,
  );
  assert.match(channelService, /tryReadRisingWaveInboxWithFailSoft/);
  assert.match(channelService, /getInboxItemsFromServingRows/);
});

test.skipIf(inSourceSnapshot)("RW active Activity visibility and PG unread-summary agree that deleted or archived sources are ineligible", () => {
  const ddl = readDdl();
  const productionMuteDdl = readProductionMuteDdl();
  const productionVisibilityDdl = readProductionVisibilityDdl();
  assert.match(
    ddl,
    /FROM rw_inbox_items_v2_suppressed_v3_2 AS base/,
    "the active born-read view must retain the v3_2 visibility decision as its base",
  );
  assert.match(
    materializedViewBody(productionMuteDdl, "rw_inbox_cloak_decisions_v3_2"),
    /FROM rw_inbox_visibility_facts_v3 AS vf/,
    "the v3_2 cloak decision must derive from the lifecycle-gated visibility graph",
  );

  const visibilityFacts = materializedViewBody(productionVisibilityDdl, "rw_inbox_visibility_facts_v3");
  for (const targetView of [
    "rw_inbox_visibility_channel_targets_v3",
    "rw_inbox_visibility_public_channel_mention_targets_v3",
    "rw_inbox_visibility_followed_thread_targets_v3",
    "rw_inbox_visibility_public_thread_mention_targets_v3",
  ]) {
    assert.match(visibilityFacts, new RegExp(`\\b${targetView}\\b`));
  }

  const channelTargets = materializedViewBody(
    productionVisibilityDdl,
    "rw_inbox_visibility_channel_targets_v3",
  );
  assert.match(channelTargets, /c\.deleted_at IS NULL/);
  assert.match(channelTargets, /c\.archived_at IS NULL/);

  const publicChannelMentions = materializedViewBody(
    productionVisibilityDdl,
    "rw_inbox_visibility_public_channel_mention_targets_v3",
  );
  assert.match(publicChannelMentions, /mention_channel\.deleted_at IS NULL/);
  assert.match(publicChannelMentions, /mention_channel\.archived_at IS NULL/);

  const followedThreadParents = materializedViewBody(
    productionVisibilityDdl,
    "rw_inbox_visibility_followed_thread_parent_resolution_v3",
  );
  assert.match(followedThreadParents, /t\.deleted_at IS NULL/);
  assert.match(followedThreadParents, /parent_ch\.deleted_at IS NULL/);
  assert.match(followedThreadParents, /parent_ch\.archived_at IS NULL/);

  const publicThreadParents = materializedViewBody(
    productionVisibilityDdl,
    "rw_inbox_visibility_public_thread_mention_parent_resolution_v3",
  );
  assert.match(publicThreadParents, /thread_channel\.deleted_at IS NULL/);
  assert.match(publicThreadParents, /parent_channel\.deleted_at IS NULL/);
  assert.match(publicThreadParents, /parent_channel\.archived_at IS NULL/);

  assert.match(
    channelService,
    /FROM inbox_serving_rows serving_row\s+INNER JOIN channels source_channel[\s\S]*?source_channel\.deleted_at IS NULL[\s\S]*?source_channel\.archived_at IS NULL/,
    "the PG mention-summary merge must enforce the same source lifecycle eligibility",
  );
});

test("Gate B1: RW serving pairs latestActivitySeq with latestActivityMessageId as one same-source tuple (join-hit parity)", () => {
  // The serving query must select the frontier id and seq from the SAME source:
  // latestActivityMessageId is i.latest_activity_message_id, and latestActivitySeq
  // is latest_activity.seq looked up by that exact id. A join-hit therefore returns
  // the canonical (id, seq) tuple; a join-miss yields a NULL seq that
  // requireLatestActivitySeq hard-rejects before serialization (no partial window).
  assert.match(
    channelService,
    /i\.latest_activity_message_id AS "latestActivityMessageId"/,
    "serving query must project the frontier message id",
  );
  assert.match(
    channelService,
    /latest_activity\.seq::text AS "latestActivitySeq"/,
    "serving query must project the frontier seq as exact text",
  );
  // The seq is joined by the frontier message id, so id and seq are paired, not split.
  assert.match(
    channelService,
    /LEFT JOIN rw_messages latest_activity\s+ON latest_activity\.id = i\.latest_activity_message_id/,
    "the seq must be joined by the frontier message id so (id, seq) stay one tuple",
  );
  // The page_enriched serving projection must carry latestActivitySeq through to the
  // raw rows that feed mapInboxPolicyRowsToItems; without this the RW path drops the
  // frontier even though the inner filtered CTE selects it (P1 successor).
  assert.match(
    channelService,
    /p\."latestActivitySeq"::text AS "latestActivitySeq"/,
    "the RW page_enriched serving projection must carry latestActivitySeq to the shared mapper",
  );
  // The join-miss fail-closed guard lives in the single normalizeRow mapper
  // (activitySyncService): a NULL/0/non-canonical seq hard-rejects the row.
  assert.match(
    activitySyncService,
    /no provable latestActivitySeq/,
    "a join-miss without a canonical fallback must hard-reject, never fabricate 0 or drop the row",
  );
});

test("Gate B1: zero-reply thread falls back to the parent via a PAIRED COALESCE (id and seq together)", () => {
  // The canonical-PG thread serving query must fall back to the parent message with a
  // PAIRED COALESCE: COALESCE(latest_message.id, parentMessageId) for the id and
  // COALESCE(latest_message.seq, parentMessageSeq) for the seq — never split, so a
  // zero-reply thread reports the parent's (id, seq) tuple, not a fabricated frontier.
  assert.match(
    channelService,
    /COALESCE\(latest_message\.id, p\."parentMessageId"\)::text AS "latestActivityMessageId"/,
    "zero-reply thread id must fall back to the parent message id",
  );
  assert.match(
    channelService,
    /COALESCE\(latest_message\.seq, p\."parentMessageSeq"\)::text AS "latestActivitySeq"/,
    "zero-reply thread seq must fall back to the parent message seq, paired with the id",
  );
});
