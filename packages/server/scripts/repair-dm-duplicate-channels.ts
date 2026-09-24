#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

type DmKind = "self_user_dm" | "user_user_dm";
type Mode = "dry-run" | "apply";
type GroupClass = "zero_message" | "heavy_refs_or_messages" | "regular";
type RepairDisposition = "repair" | "quarantine";
type QuarantineReason = "agent_sender_evidence" | "identity_conflict" | "missing_explicit_provenance";

export type DetailedRow = {
  serverId: string;
  dmKind: DmKind;
  peerKey: string;
  dmIdentityKind: string | null;
  dmIdentityKey: string | null;
  channelId: string;
  createdAt: string;
  deletedAt: string | null;
  messageCount: number;
  agentSenderMessageCount: number;
  lastMessageAt: string | null;
  attachmentCount: number;
  taskCount: number;
  threadParentCount: number;
  mentionCount: number;
  userReadCursorCount: number;
  userInboxStateCount: number;
  muteCount: number;
  suppressionCount: number;
  notificationFactCount: number;
  servingRowCount: number;
  serverMemberJsonRefCount: number;
};

export type RepairGroup = {
  key: string;
  serverId: string;
  dmKind: DmKind;
  peerKey: string;
  channels: DetailedRow[];
  activeChannelIds: string[];
  canonicalChannelId: string;
  duplicateChannelIds: string[];
  disposition: RepairDisposition;
  quarantineReason: QuarantineReason | null;
  groupClass: GroupClass;
  totalMessages: number;
  totalServerMemberJsonRefs: number;
};

type Options = {
  mode: Mode;
  inputPath: string | null;
  serverId: string | null;
  limit: number | null;
  confirm: string | null;
  json: boolean;
};

type JsonRef = { kind?: string; id?: string; [key: string]: unknown };

const APPLY_CONFIRMATION = "task154-dm-dedupe";

export const MERGE_INBOX_SUPPRESSION_STATES_SQL = `
    WITH normalized AS (
      SELECT
        receiver_type,
        receiver_id,
        server_id,
        target_kind,
        CASE WHEN target_channel_id = ANY($2::uuid[]) THEN $1::uuid ELSE target_channel_id END AS target_channel_id,
        CASE WHEN source_channel_id = ANY($2::uuid[]) THEN $1::uuid ELSE source_channel_id END AS source_channel_id,
        done_through_seq,
        done_at,
        updated_at
      FROM inbox_suppression_states
      WHERE target_channel_id = ANY($3::uuid[]) OR source_channel_id = ANY($3::uuid[])
    ), merged AS (
      SELECT
        receiver_type,
        receiver_id,
        MAX(server_id::text)::uuid AS server_id,
        target_kind,
        target_channel_id,
        CASE
          WHEN BOOL_OR(source_channel_id = $1::uuid) THEN $1::uuid
          ELSE MIN(source_channel_id::text)::uuid
        END AS source_channel_id,
        MAX(done_through_seq) AS done_through_seq,
        MAX(done_at) AS done_at,
        'dm_dedupe_repair' AS write_site,
        MAX(updated_at) AS updated_at
      FROM normalized
      GROUP BY receiver_type, receiver_id, target_kind, target_channel_id
    ), deleted AS (
      DELETE FROM inbox_suppression_states WHERE target_channel_id = ANY($3::uuid[]) OR source_channel_id = ANY($3::uuid[])
    )
    INSERT INTO inbox_suppression_states (
      receiver_type, receiver_id, server_id, target_kind, target_channel_id, source_channel_id, done_through_seq, done_at, write_site, updated_at
    )
    SELECT receiver_type, receiver_id, server_id, target_kind, target_channel_id, source_channel_id, done_through_seq, done_at, write_site, updated_at FROM merged
    ON CONFLICT (receiver_type, receiver_id, target_kind, target_channel_id) DO UPDATE
      SET source_channel_id = EXCLUDED.source_channel_id,
          done_through_seq = CASE
            WHEN inbox_suppression_states.done_through_seq IS NULL THEN EXCLUDED.done_through_seq
            WHEN EXCLUDED.done_through_seq IS NULL THEN inbox_suppression_states.done_through_seq
            ELSE GREATEST(inbox_suppression_states.done_through_seq, EXCLUDED.done_through_seq)
          END,
          done_at = GREATEST(inbox_suppression_states.done_at, EXCLUDED.done_at),
          write_site = EXCLUDED.write_site,
          updated_at = GREATEST(inbox_suppression_states.updated_at, EXCLUDED.updated_at)
  `;

export const DELETE_DUPLICATE_DM_IDENTITIES_SQL =
  "DELETE FROM dm_channel_identities WHERE channel_id = ANY($1::uuid[])";

function usage() {
  console.error([
    "Usage:",
    "  pnpm --filter @botiverse/raft-server exec tsx scripts/repair-dm-duplicate-channels.ts --input detailed.tsv [--server-id <uuid>] [--limit <n>] [--json]",
    "  DATABASE_URL=... pnpm --filter @botiverse/raft-server exec tsx scripts/repair-dm-duplicate-channels.ts [--server-id <uuid>] [--limit <n>] [--json]",
    "  DATABASE_URL=... pnpm --filter @botiverse/raft-server exec tsx scripts/repair-dm-duplicate-channels.ts --apply --confirm task154-dm-dedupe [--server-id <uuid>] [--limit <n>] [--json]",
    "",
    "Contract:",
    "  - Defaults to dry-run. With --input, dry-run is artifact-only and needs no database credentials.",
    "  - Without --input, dry-run opens a READ ONLY transaction and discovers duplicate groups live.",
    "  - --apply requires the exact confirmation token and still re-discovers/locks live rows before writing.",
    "  - Canonical channel: latest real message activity, then higher message count, then earliest created_at, then lowest id.",
    "  - Singleton-human groups require explicit human_self provenance on every row; agent-sender or missing/conflicting provenance is quarantined and never applied.",
    "  - Zero-message duplicate groups only soft-delete non-canonical rows after JSON/membership cleanup.",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    mode: "dry-run",
    inputPath: null,
    serverId: null,
    limit: null,
    confirm: null,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" && argv[i + 1]) {
      options.inputPath = argv[++i];
      continue;
    }
    if (arg === "--server-id" && argv[i + 1]) {
      options.serverId = argv[++i];
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      options.limit = Math.max(1, Number(argv[++i]) || 1);
      continue;
    }
    if (arg === "--apply") {
      options.mode = "apply";
      continue;
    }
    if (arg === "--confirm" && argv[i + 1]) {
      options.confirm = argv[++i];
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.mode === "apply" && options.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`--apply requires --confirm ${APPLY_CONFIRMATION}`);
  }
  if (options.mode === "apply" && options.inputPath) {
    throw new Error("--input is dry-run only; --apply must re-discover current duplicate groups from DATABASE_URL");
  }
  return options;
}

function parseNumber(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNullable(value: string | undefined): string | null {
  if (!value || value === "\\N") return null;
  return value;
}

export function parseDetailedTsv(content: string): DetailedRow[] {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  const [headerLine, ...body] = lines;
  if (!headerLine) return [];
  const headers = headerLine.split("\t");
  const index = new Map(headers.map((header, idx) => [header, idx]));
  const get = (columns: string[], name: string) => columns[index.get(name) ?? -1] ?? "";

  return body.map((line) => {
    const columns = line.split("\t");
    return {
      serverId: get(columns, "server_id"),
      dmKind: get(columns, "dm_kind") as DmKind,
      peerKey: get(columns, "peer_key"),
      dmIdentityKind: normalizeNullable(get(columns, "dm_identity_kind")),
      dmIdentityKey: normalizeNullable(get(columns, "dm_identity_key")),
      channelId: get(columns, "channel_id"),
      createdAt: get(columns, "created_at"),
      deletedAt: normalizeNullable(get(columns, "deleted_at")),
      messageCount: parseNumber(get(columns, "message_count")),
      agentSenderMessageCount: parseNumber(get(columns, "agent_sender_message_count")),
      lastMessageAt: normalizeNullable(get(columns, "last_message_at")),
      attachmentCount: parseNumber(get(columns, "attachment_count")),
      taskCount: parseNumber(get(columns, "task_count")),
      threadParentCount: parseNumber(get(columns, "thread_parent_count")),
      mentionCount: parseNumber(get(columns, "mention_count")),
      userReadCursorCount: parseNumber(get(columns, "user_read_cursor_count")),
      userInboxStateCount: parseNumber(get(columns, "user_inbox_state_count")),
      muteCount: parseNumber(get(columns, "mute_count")),
      suppressionCount: parseNumber(get(columns, "suppression_count")),
      notificationFactCount: parseNumber(get(columns, "notification_fact_count")),
      servingRowCount: parseNumber(get(columns, "serving_row_count")),
      serverMemberJsonRefCount: parseNumber(get(columns, "server_member_json_ref_count")),
    };
  });
}

function compareIsoDescNullable(a: string | null, b: string | null): number {
  if (a && b) return Date.parse(b) - Date.parse(a);
  if (a) return -1;
  if (b) return 1;
  return 0;
}

export function pickCanonicalChannel(rows: DetailedRow[]): DetailedRow {
  if (rows.length === 0) throw new Error("Cannot pick canonical channel for empty group");
  return [...rows].sort((a, b) => {
    const lastMessage = compareIsoDescNullable(a.lastMessageAt, b.lastMessageAt);
    if (lastMessage !== 0) return lastMessage;
    if (a.messageCount !== b.messageCount) return b.messageCount - a.messageCount;
    const created = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (created !== 0) return created;
    return a.channelId.localeCompare(b.channelId);
  })[0]!;
}

export function classifyGroup(rows: DetailedRow[]): GroupClass {
  const totalMessages = rows.reduce((sum, row) => sum + row.messageCount, 0);
  const totalServerMemberJsonRefs = rows.reduce((sum, row) => sum + row.serverMemberJsonRefCount, 0);
  if (totalMessages === 0) return "zero_message";
  if (totalMessages > 50 || totalServerMemberJsonRefs > 2) return "heavy_refs_or_messages";
  return "regular";
}

function classifyDisposition(rows: DetailedRow[], dmKind: DmKind, peerKey: string): {
  disposition: RepairDisposition;
  quarantineReason: QuarantineReason | null;
} {
  if (dmKind === "user_user_dm") {
    return { disposition: "repair", quarantineReason: null };
  }
  if (rows.some((row) => row.agentSenderMessageCount > 0)) {
    return { disposition: "quarantine", quarantineReason: "agent_sender_evidence" };
  }
  if (rows.some((row) => (
    row.dmIdentityKind !== null
    && (row.dmIdentityKind !== "human_self" || row.dmIdentityKey !== peerKey)
  ))) {
    return { disposition: "quarantine", quarantineReason: "identity_conflict" };
  }
  if (rows.some((row) => row.dmIdentityKind !== "human_self" || row.dmIdentityKey !== peerKey)) {
    return { disposition: "quarantine", quarantineReason: "missing_explicit_provenance" };
  }
  return { disposition: "repair", quarantineReason: null };
}

export function buildRepairGroups(rows: DetailedRow[], limit: number | null = null): RepairGroup[] {
  const byKey = new Map<string, DetailedRow[]>();
  for (const row of rows) {
    if (row.dmKind !== "self_user_dm" && row.dmKind !== "user_user_dm") continue;
    const key = `${row.serverId}\t${row.dmKind}\t${row.peerKey}`;
    const group = byKey.get(key) ?? [];
    group.push(row);
    byKey.set(key, group);
  }

  const groups = [...byKey.entries()]
    .filter(([, groupRows]) => groupRows.filter((row) => !row.deletedAt).length > 1)
    .map(([key, groupRows]) => {
      const activeRows = groupRows.filter((row) => !row.deletedAt);
      const canonical = pickCanonicalChannel(activeRows);
      const duplicateChannelIds = groupRows
        .map((row) => row.channelId)
        .filter((channelId) => channelId !== canonical.channelId);
      const disposition = classifyDisposition(groupRows, canonical.dmKind, canonical.peerKey);
      return {
        key,
        serverId: canonical.serverId,
        dmKind: canonical.dmKind,
        peerKey: canonical.peerKey,
        channels: groupRows,
        activeChannelIds: activeRows.map((row) => row.channelId),
        canonicalChannelId: canonical.channelId,
        duplicateChannelIds,
        ...disposition,
        groupClass: classifyGroup(groupRows),
        totalMessages: groupRows.reduce((sum, row) => sum + row.messageCount, 0),
        totalServerMemberJsonRefs: groupRows.reduce((sum, row) => sum + row.serverMemberJsonRefCount, 0),
      };
    })
    .sort((a, b) => b.totalMessages - a.totalMessages || a.key.localeCompare(b.key));

  return limit ? groups.slice(0, limit) : groups;
}

export function rewriteStringIdArray(value: unknown, canonicalId: string, duplicateIds: Set<string>): string[] | null {
  if (!Array.isArray(value)) return value == null ? null : [];
  const seen = new Set<string>();
  const rewritten: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const mapped = duplicateIds.has(item) ? canonicalId : item;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    rewritten.push(mapped);
  }
  return rewritten;
}

export function rewritePinnedRefs(value: unknown, canonicalId: string, duplicateIds: Set<string>): JsonRef[] | null {
  if (!Array.isArray(value)) return value == null ? null : [];
  const seen = new Set<string>();
  const rewritten: JsonRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const ref = item as JsonRef;
    const next = { ...ref };
    if (next.kind === "channel" && typeof next.id === "string" && duplicateIds.has(next.id)) {
      next.id = canonicalId;
    }
    const key = `${String(next.kind ?? "")}:${String(next.id ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rewritten.push(next);
  }
  return rewritten;
}

function summarizeGroups(groups: RepairGroup[]) {
  return {
    groupCount: groups.length,
    channelRows: groups.reduce((sum, group) => sum + group.channels.length, 0),
    activeChannelRows: groups.reduce((sum, group) => sum + group.activeChannelIds.length, 0),
    softDeletedChannelRows: groups.reduce((sum, group) => sum + group.channels.filter((row) => row.deletedAt).length, 0),
    duplicateChannelRows: groups.reduce((sum, group) => sum + group.duplicateChannelIds.length, 0),
    repairGroupCount: groups.filter((group) => group.disposition === "repair").length,
    quarantineGroupCount: groups.filter((group) => group.disposition === "quarantine").length,
    byKind: countBy(groups, (group) => group.dmKind),
    byClass: countBy(groups, (group) => group.groupClass),
    byDisposition: countBy(groups, (group) => group.disposition),
    byQuarantineReason: countBy(
      groups.filter((group) => group.quarantineReason !== null),
      (group) => group.quarantineReason!,
    ),
    totalMessages: groups.reduce((sum, group) => sum + group.totalMessages, 0),
    totalServerMemberJsonRefs: groups.reduce((sum, group) => sum + group.totalServerMemberJsonRefs, 0),
  };
}

function buildPlanResult(options: Options, groups: RepairGroup[]) {
  return {
    mode: options.mode,
    summary: summarizeGroups(groups),
    groups: groups.map((group) => ({
      serverId: group.serverId,
      dmKind: group.dmKind,
      peerKey: group.peerKey,
      groupClass: group.groupClass,
      canonicalChannelId: group.canonicalChannelId,
      duplicateChannelIds: group.duplicateChannelIds,
      disposition: group.disposition,
      quarantineReason: group.quarantineReason,
      activeChannelIds: group.activeChannelIds,
      totalMessages: group.totalMessages,
      totalServerMemberJsonRefs: group.totalServerMemberJsonRefs,
    })),
    applied: [] as Array<{ key: string; canonicalChannelId: string; duplicateChannelIds: string[]; serverMemberRowsUpdated: number }>,
  };
}

function printResult(options: Options, result: ReturnType<typeof buildPlanResult>) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${options.mode}: ${result.summary.groupCount} groups, ${result.summary.duplicateChannelRows} duplicate channel rows`);
  console.log(`disposition: ${JSON.stringify(result.summary.byDisposition)}`);
  if (result.summary.quarantineGroupCount > 0) {
    console.log(`quarantine reasons: ${JSON.stringify(result.summary.byQuarantineReason)}`);
  }
  console.log(`by class: ${JSON.stringify(result.summary.byClass)}`);
  console.log(`by kind: ${JSON.stringify(result.summary.byKind)}`);
  if (options.mode === "dry-run") console.log("No data mutated. Re-run with --apply --confirm task154-dm-dedupe after staging/founder gate.");
}

function countBy<T>(items: T[], keyFn: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function discoverDetailedRows(client: pg.PoolClient, serverId: string | null): Promise<DetailedRow[]> {
  const params: unknown[] = [];
  const serverFilter = serverId ? `AND c.server_id = $${params.push(serverId)}` : "";
  const result = await client.query(`
    WITH dm_shape AS (
      SELECT
        c.id,
        c.server_id,
        c.created_at,
        c.deleted_at,
        dci.kind AS dm_identity_kind,
        dci.peer_key AS dm_identity_key,
        COUNT(DISTINCT ch.user_id) AS human_count,
        COUNT(DISTINCT ca.agent_id) AS agent_count,
        ARRAY_AGG(DISTINCT ch.user_id ORDER BY ch.user_id) FILTER (WHERE ch.user_id IS NOT NULL) AS human_ids,
        ARRAY_AGG(DISTINCT ca.agent_id ORDER BY ca.agent_id) FILTER (WHERE ca.agent_id IS NOT NULL) AS agent_ids
      FROM channels c
      LEFT JOIN dm_channel_identities dci ON dci.channel_id = c.id
      LEFT JOIN channel_humans ch ON ch.channel_id = c.id
      LEFT JOIN channel_agents ca ON ca.channel_id = c.id
      WHERE c.type = 'dm'
        ${serverFilter}
      GROUP BY c.id, c.server_id, c.created_at, c.deleted_at, dci.kind, dci.peer_key
    ), normalized AS (
      SELECT
        id,
        server_id,
        created_at,
        deleted_at,
        dm_identity_kind,
        dm_identity_key,
        human_count,
        agent_count,
        human_ids,
        agent_ids,
        CASE
          WHEN human_count = 1 AND agent_count = 0 THEN 'self_user_dm'
          WHEN human_count = 2 AND agent_count = 0 THEN 'user_user_dm'
          ELSE 'other_dm_shape'
        END AS dm_kind,
        CASE
          WHEN human_count IN (1, 2) AND agent_count = 0 THEN array_to_string(human_ids, ',')
          ELSE COALESCE(array_to_string(human_ids, ','), '') || '|agents=' || COALESCE(array_to_string(agent_ids, ','), '')
        END AS peer_key
      FROM dm_shape
    ), duplicate_groups AS (
      SELECT server_id, dm_kind, peer_key
      FROM normalized
      WHERE deleted_at IS NULL
        AND dm_kind IN ('self_user_dm', 'user_user_dm')
      GROUP BY server_id, dm_kind, peer_key
      HAVING COUNT(*) > 1
    )
    SELECT
      n.server_id,
      n.dm_kind,
      n.peer_key,
      n.dm_identity_kind,
      n.dm_identity_key,
      n.id AS channel_id,
      n.created_at,
      n.deleted_at,
      COALESCE(msg.message_count, 0) AS message_count,
      COALESCE(msg.agent_sender_message_count, 0) AS agent_sender_message_count,
      msg.last_message_at,
      COALESCE(att.attachment_count, 0) AS attachment_count,
      COALESCE(t.task_count, 0) AS task_count,
      COALESCE(parent.thread_parent_count, 0) AS thread_parent_count,
      COALESCE(mm.mention_count, 0) AS mention_count,
      COALESCE(uc.read_cursor_count, 0) AS user_read_cursor_count,
      COALESCE(ui.inbox_state_count, 0) AS user_inbox_state_count,
      COALESCE(mute.mute_count, 0) AS mute_count,
      COALESCE(sup.suppression_count, 0) AS suppression_count,
      COALESCE(fact.fact_count, 0) AS notification_fact_count,
      COALESCE(serv.serving_count, 0) AS serving_row_count,
      COALESCE(sm.json_ref_count, 0) AS server_member_json_ref_count
    FROM normalized n
    JOIN duplicate_groups g
      ON g.server_id = n.server_id AND g.dm_kind = n.dm_kind AND g.peer_key = n.peer_key
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS message_count,
        COUNT(*) FILTER (WHERE sender_type = 'agent') AS agent_sender_message_count,
        MAX(created_at) AS last_message_at
      FROM messages WHERE channel_id = n.id
    ) msg ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*) AS attachment_count FROM attachments WHERE channel_id = n.id) att ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*) AS task_count FROM tasks WHERE channel_id = n.id) t ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*) AS thread_parent_count FROM messages WHERE channel_id = n.id AND thread_id IS NOT NULL) parent ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*) AS mention_count FROM message_mentions WHERE channel_id = n.id) mm ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*) AS read_cursor_count FROM user_channel_read_cursors WHERE channel_id = n.id) uc ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*) AS inbox_state_count FROM user_channel_inbox_states WHERE channel_id = n.id) ui ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*) AS mute_count FROM inbox_target_mute_states WHERE source_channel_id = n.id) mute ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*) AS suppression_count FROM inbox_suppression_states WHERE target_channel_id = n.id OR source_channel_id = n.id) sup ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*) AS fact_count FROM inbox_notification_facts WHERE source_channel_id = n.id) fact ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*) AS serving_count FROM inbox_serving_rows WHERE source_channel_id = n.id) serv ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS json_ref_count
      FROM server_members sm
      WHERE sm.server_id = n.server_id
        AND (
          COALESCE(sm.hidden_dm_ids::jsonb, '[]'::jsonb) ? n.id::text OR
          COALESCE(sm.sidebar_dm_order::jsonb, '[]'::jsonb) ? n.id::text OR
          COALESCE(sm.pinned_channel_ids::jsonb, '[]'::jsonb) ? n.id::text OR
          COALESCE(sm.pinned_order::jsonb, '[]'::jsonb) ? n.id::text OR
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(sm.pinned_refs::jsonb, '[]'::jsonb)) ref
            WHERE ref->>'kind' = 'channel' AND ref->>'id' = n.id::text
          )
        )
    ) sm ON TRUE
    ORDER BY n.dm_kind, n.server_id, n.peer_key, msg.last_message_at DESC NULLS LAST, msg.message_count DESC, n.created_at ASC
  `, params);

  return result.rows.map((row) => ({
    serverId: row.server_id,
    dmKind: row.dm_kind,
    peerKey: row.peer_key,
    dmIdentityKind: row.dm_identity_kind ?? null,
    dmIdentityKey: row.dm_identity_key ?? null,
    channelId: row.channel_id,
    createdAt: String(row.created_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    messageCount: Number(row.message_count),
    agentSenderMessageCount: Number(row.agent_sender_message_count),
    lastMessageAt: row.last_message_at ? String(row.last_message_at) : null,
    attachmentCount: Number(row.attachment_count),
    taskCount: Number(row.task_count),
    threadParentCount: Number(row.thread_parent_count),
    mentionCount: Number(row.mention_count),
    userReadCursorCount: Number(row.user_read_cursor_count),
    userInboxStateCount: Number(row.user_inbox_state_count),
    muteCount: Number(row.mute_count),
    suppressionCount: Number(row.suppression_count),
    notificationFactCount: Number(row.notification_fact_count),
    servingRowCount: Number(row.serving_row_count),
    serverMemberJsonRefCount: Number(row.server_member_json_ref_count),
  }));
}

async function assertNoUnsupportedRefs(client: pg.PoolClient, group: RepairGroup) {
  const channelIds = group.channels.map((row) => row.channelId);
  const result = await client.query<{
    task_messages: string;
    channel_conversion_jobs: string;
    attested_send_pending_drafts: string;
    joint_channels_canonical: string;
    joint_channel_servers_local: string;
    thread_follows: string;
  }>(`
    SELECT
      (SELECT COUNT(*)::text FROM messages WHERE channel_id = ANY($1::uuid[]) AND task_number IS NOT NULL) AS task_messages,
      (SELECT COUNT(*)::text FROM channel_conversion_jobs WHERE source_channel_id = ANY($1::uuid[]) AND status IN ('pending', 'running', 'failed')) AS channel_conversion_jobs,
      (SELECT COUNT(*)::text FROM attested_send_pending_drafts WHERE channel_id = ANY($1::uuid[])) AS attested_send_pending_drafts,
      (SELECT COUNT(*)::text FROM joint_channels WHERE canonical_channel_id = ANY($1::uuid[])) AS joint_channels_canonical,
      (SELECT COUNT(*)::text FROM joint_channel_servers WHERE local_channel_id = ANY($1::uuid[])) AS joint_channel_servers_local,
      (SELECT COUNT(*)::text FROM thread_follows WHERE thread_channel_id = ANY($1::uuid[])) AS thread_follows
  `, [channelIds]);
  const row = result.rows[0]!;
  const blockers = Object.entries(row).filter(([, value]) => Number(value) > 0);
  if (blockers.length > 0) {
    throw new Error(`Group ${group.key} has unsupported live refs: ${blockers.map(([key, value]) => `${key}=${value}`).join(", ")}`);
  }
}

async function assertGroupConverged(client: pg.PoolClient, group: RepairGroup) {
  const duplicateIds = group.duplicateChannelIds;
  const checks = await client.query<Record<string, string>>(`
    SELECT
      (SELECT COUNT(*)::text FROM messages WHERE channel_id = $1::uuid) AS canonical_messages,
      (SELECT COUNT(*)::text FROM messages WHERE channel_id = ANY($2::uuid[])) AS duplicate_messages,
      (SELECT COUNT(*)::text FROM attachments WHERE channel_id = ANY($2::uuid[])) AS duplicate_attachments,
      (SELECT COUNT(*)::text FROM tasks WHERE channel_id = ANY($2::uuid[])) AS duplicate_tasks,
      (SELECT COUNT(*)::text FROM message_mentions WHERE channel_id = ANY($2::uuid[])) AS duplicate_mentions,
      (SELECT COUNT(*)::text FROM share_artifacts WHERE channel_id = ANY($2::uuid[])) AS duplicate_share_artifacts,
      (SELECT COUNT(*)::text FROM channel_humans WHERE channel_id = ANY($2::uuid[])) AS duplicate_channel_humans,
      (SELECT COUNT(*)::text FROM channel_agents WHERE channel_id = ANY($2::uuid[])) AS duplicate_channel_agents,
      (SELECT COUNT(*)::text FROM user_channel_read_cursors WHERE channel_id = ANY($2::uuid[])) AS duplicate_user_read_cursors,
      (SELECT COUNT(*)::text FROM agent_channel_read_cursors WHERE channel_id = ANY($2::uuid[])) AS duplicate_agent_read_cursors,
      (SELECT COUNT(*)::text FROM user_channel_inbox_states WHERE channel_id = ANY($2::uuid[])) AS duplicate_user_inbox_states,
      (SELECT COUNT(*)::text FROM inbox_target_mute_states WHERE source_channel_id = ANY($2::uuid[])) AS duplicate_mutes,
      (SELECT COUNT(*)::text FROM inbox_suppression_states WHERE target_channel_id = ANY($2::uuid[]) OR source_channel_id = ANY($2::uuid[])) AS duplicate_suppressions,
      (SELECT COUNT(*)::text FROM inbox_notification_facts WHERE source_channel_id = ANY($2::uuid[])) AS duplicate_notification_facts,
      (SELECT COUNT(*)::text FROM inbox_serving_rows WHERE source_channel_id = ANY($2::uuid[])) AS duplicate_serving_rows,
      (SELECT COUNT(*)::text FROM channels WHERE id = ANY($2::uuid[]) AND deleted_at IS NULL) AS active_duplicate_channels,
      (SELECT COUNT(*)::text FROM server_members sm
        WHERE sm.server_id = $3::uuid
          AND (
            COALESCE(sm.hidden_dm_ids::jsonb, '[]'::jsonb) ?| $4::text[] OR
            COALESCE(sm.sidebar_dm_order::jsonb, '[]'::jsonb) ?| $4::text[] OR
            COALESCE(sm.pinned_channel_ids::jsonb, '[]'::jsonb) ?| $4::text[] OR
            COALESCE(sm.pinned_order::jsonb, '[]'::jsonb) ?| $4::text[] OR
            EXISTS (
              SELECT 1 FROM jsonb_array_elements(COALESCE(sm.pinned_refs::jsonb, '[]'::jsonb)) ref
              WHERE ref->>'kind' = 'channel' AND ref->>'id' = ANY($4::text[])
            )
          )) AS duplicate_server_member_json_refs
  `, [group.canonicalChannelId, duplicateIds, group.serverId, duplicateIds]);
  const row = checks.rows[0]!;
  const canonicalMessages = Number(row.canonical_messages ?? 0);
  if (canonicalMessages !== group.totalMessages) {
    throw new Error(`Group ${group.key} failed message conservation: canonical_messages=${canonicalMessages}, expected=${group.totalMessages}`);
  }
  const nonzero = Object.entries(row).filter(([key, value]) => key !== "canonical_messages" && Number(value) > 0);
  if (nonzero.length > 0) {
    throw new Error(`Group ${group.key} failed convergence checks: ${nonzero.map(([key, value]) => `${key}=${value}`).join(", ")}`);
  }
}

async function rewriteServerMemberJsonRefs(client: pg.PoolClient, group: RepairGroup) {
  const duplicateIds = new Set(group.duplicateChannelIds);
  const duplicateArray = group.duplicateChannelIds;
  const result = await client.query<{
    server_id: string;
    user_id: string;
    hidden_dm_ids: unknown;
    sidebar_dm_order: unknown;
    pinned_channel_ids: unknown;
    pinned_order: unknown;
    pinned_refs: unknown;
  }>(`
    SELECT server_id, user_id, hidden_dm_ids, sidebar_dm_order, pinned_channel_ids, pinned_order, pinned_refs
    FROM server_members
    WHERE server_id = $1::uuid
      AND (
        COALESCE(hidden_dm_ids::jsonb, '[]'::jsonb) ?| $2::text[] OR
        COALESCE(sidebar_dm_order::jsonb, '[]'::jsonb) ?| $2::text[] OR
        COALESCE(pinned_channel_ids::jsonb, '[]'::jsonb) ?| $2::text[] OR
        COALESCE(pinned_order::jsonb, '[]'::jsonb) ?| $2::text[] OR
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(pinned_refs::jsonb, '[]'::jsonb)) ref
          WHERE ref->>'kind' = 'channel' AND ref->>'id' = ANY($2::text[])
        )
      )
    FOR UPDATE
  `, [group.serverId, duplicateArray]);

  let updated = 0;
  for (const row of result.rows) {
    const next = {
      hiddenDmIds: rewriteStringIdArray(row.hidden_dm_ids, group.canonicalChannelId, duplicateIds),
      sidebarDmOrder: rewriteStringIdArray(row.sidebar_dm_order, group.canonicalChannelId, duplicateIds),
      pinnedChannelIds: rewriteStringIdArray(row.pinned_channel_ids, group.canonicalChannelId, duplicateIds),
      pinnedOrder: rewriteStringIdArray(row.pinned_order, group.canonicalChannelId, duplicateIds),
      pinnedRefs: rewritePinnedRefs(row.pinned_refs, group.canonicalChannelId, duplicateIds),
    };
    await client.query(`
      UPDATE server_members
      SET
        hidden_dm_ids = $3::json,
        sidebar_dm_order = $4::json,
        pinned_channel_ids = $5::json,
        pinned_order = $6::json,
        pinned_refs = $7::json
      WHERE server_id = $1::uuid AND user_id = $2::uuid
    `, [
      row.server_id,
      row.user_id,
      JSON.stringify(next.hiddenDmIds),
      JSON.stringify(next.sidebarDmOrder),
      JSON.stringify(next.pinnedChannelIds),
      JSON.stringify(next.pinnedOrder),
      JSON.stringify(next.pinnedRefs),
    ]);
    updated++;
  }
  return updated;
}

async function applyGroup(client: pg.PoolClient, group: RepairGroup) {
  await assertNoUnsupportedRefs(client, group);
  const allChannelIds = group.channels.map((row) => row.channelId);
  await client.query("SELECT id FROM channels WHERE id = ANY($1::uuid[]) FOR UPDATE", [allChannelIds]);
  const duplicateIds = group.duplicateChannelIds;
  const canonicalId = group.canonicalChannelId;

  const serverMemberRowsUpdated = await rewriteServerMemberJsonRefs(client, group);

  await client.query(`
    INSERT INTO channel_humans (channel_id, user_id, joined_at)
    SELECT $1::uuid, user_id, MIN(joined_at)
    FROM channel_humans
    WHERE channel_id = ANY($2::uuid[])
    GROUP BY user_id
    ON CONFLICT (channel_id, user_id) DO NOTHING
  `, [canonicalId, allChannelIds]);

  await client.query(`
    INSERT INTO channel_agents (channel_id, agent_id, added_at)
    SELECT $1::uuid, agent_id, MIN(added_at)
    FROM channel_agents
    WHERE channel_id = ANY($2::uuid[])
    GROUP BY agent_id
    ON CONFLICT (channel_id, agent_id) DO NOTHING
  `, [canonicalId, allChannelIds]);

  await client.query("UPDATE messages SET channel_id = $1::uuid, updated_at = NOW() WHERE channel_id = ANY($2::uuid[])", [canonicalId, duplicateIds]);
  await client.query("UPDATE attachments SET channel_id = $1::uuid WHERE channel_id = ANY($2::uuid[])", [canonicalId, duplicateIds]);
  await client.query("UPDATE tasks SET channel_id = $1::uuid, updated_at = NOW() WHERE channel_id = ANY($2::uuid[])", [canonicalId, duplicateIds]);
  await client.query("UPDATE message_mentions SET channel_id = $1::uuid WHERE channel_id = ANY($2::uuid[])", [canonicalId, duplicateIds]);
  await client.query("UPDATE share_artifacts SET channel_id = $1::uuid WHERE channel_id = ANY($2::uuid[])", [canonicalId, duplicateIds]);

  await client.query(`
    WITH message_counts AS (
      SELECT channel_id, COUNT(*) AS message_count
      FROM messages
      WHERE channel_id = ANY($1::uuid[])
      GROUP BY channel_id
    ), source AS (
      SELECT
        ch.user_id,
        ch.channel_id,
        COALESCE(mc.message_count, 0) AS message_count,
        rc.last_read_seq,
        rc.read_state_version,
        rc.updated_at
      FROM channel_humans ch
      LEFT JOIN user_channel_read_cursors rc
        ON rc.user_id = ch.user_id AND rc.channel_id = ch.channel_id
      LEFT JOIN message_counts mc ON mc.channel_id = ch.channel_id
      WHERE ch.channel_id = ANY($1::uuid[])
        AND (COALESCE(mc.message_count, 0) > 0 OR rc.user_id IS NOT NULL)
    ), merged AS (
      SELECT
        user_id,
        COALESCE(
          MIN(CASE WHEN message_count > 0 THEN COALESCE(last_read_seq, 0) END),
          MAX(last_read_seq),
          0
        ) AS last_read_seq,
        COALESCE(MAX(read_state_version), 0) AS read_state_version,
        COALESCE(MAX(updated_at), NOW()) AS updated_at
      FROM source
      GROUP BY user_id
    ), deleted AS (
      DELETE FROM user_channel_read_cursors WHERE channel_id = ANY($1::uuid[])
    )
    INSERT INTO user_channel_read_cursors (user_id, channel_id, last_read_seq, read_state_version, updated_at)
    SELECT user_id, $2::uuid, last_read_seq, read_state_version, updated_at FROM merged
    ON CONFLICT (user_id, channel_id) DO UPDATE
      SET last_read_seq = GREATEST(user_channel_read_cursors.last_read_seq, EXCLUDED.last_read_seq),
          read_state_version = GREATEST(user_channel_read_cursors.read_state_version, EXCLUDED.read_state_version),
          updated_at = GREATEST(user_channel_read_cursors.updated_at, EXCLUDED.updated_at)
  `, [allChannelIds, canonicalId]);

  await client.query(`
    WITH message_counts AS (
      SELECT channel_id, COUNT(*) AS message_count
      FROM messages
      WHERE channel_id = ANY($1::uuid[])
      GROUP BY channel_id
    ), source AS (
      SELECT
        ca.agent_id,
        ca.channel_id,
        COALESCE(mc.message_count, 0) AS message_count,
        rc.last_read_seq,
        rc.updated_at
      FROM channel_agents ca
      LEFT JOIN agent_channel_read_cursors rc
        ON rc.agent_id = ca.agent_id AND rc.channel_id = ca.channel_id
      LEFT JOIN message_counts mc ON mc.channel_id = ca.channel_id
      WHERE ca.channel_id = ANY($1::uuid[])
        AND (COALESCE(mc.message_count, 0) > 0 OR rc.agent_id IS NOT NULL)
    ), merged AS (
      SELECT
        agent_id,
        COALESCE(
          MIN(CASE WHEN message_count > 0 THEN COALESCE(last_read_seq, 0) END),
          MAX(last_read_seq),
          0
        ) AS last_read_seq,
        COALESCE(MAX(updated_at), NOW()) AS updated_at
      FROM source
      GROUP BY agent_id
    ), deleted AS (
      DELETE FROM agent_channel_read_cursors WHERE channel_id = ANY($1::uuid[])
    )
    INSERT INTO agent_channel_read_cursors (agent_id, channel_id, last_read_seq, updated_at)
    SELECT agent_id, $2::uuid, last_read_seq, updated_at FROM merged
    ON CONFLICT (agent_id, channel_id) DO UPDATE
      SET last_read_seq = GREATEST(agent_channel_read_cursors.last_read_seq, EXCLUDED.last_read_seq),
          updated_at = GREATEST(agent_channel_read_cursors.updated_at, EXCLUDED.updated_at)
  `, [allChannelIds, canonicalId]);

  await client.query(`
    WITH merged AS (
      SELECT
        user_id,
        CASE WHEN BOOL_OR(done_at IS NULL) THEN NULL ELSE MAX(done_at) END AS done_at,
        MAX(updated_at) AS updated_at
      FROM user_channel_inbox_states
      WHERE channel_id = ANY($1::uuid[])
      GROUP BY user_id
    ), deleted AS (
      DELETE FROM user_channel_inbox_states WHERE channel_id = ANY($1::uuid[])
    )
    INSERT INTO user_channel_inbox_states (user_id, channel_id, done_at, updated_at)
    SELECT user_id, $2::uuid, done_at, updated_at FROM merged
    ON CONFLICT (user_id, channel_id) DO UPDATE
      SET done_at = CASE
            WHEN user_channel_inbox_states.done_at IS NULL OR EXCLUDED.done_at IS NULL THEN NULL
            ELSE GREATEST(user_channel_inbox_states.done_at, EXCLUDED.done_at)
          END,
          updated_at = GREATEST(user_channel_inbox_states.updated_at, EXCLUDED.updated_at)
  `, [allChannelIds, canonicalId]);

  await client.query(`
    WITH merged AS (
      SELECT
        receiver_type,
        receiver_id,
        MAX(server_id::text)::uuid AS server_id,
        BOOL_OR(activity_muted) AS activity_muted,
        MIN(mute_from_seq) FILTER (WHERE mute_from_seq IS NOT NULL) AS mute_from_seq,
        MAX(prefs_version) AS prefs_version,
        MIN(created_at) AS created_at,
        MAX(updated_at) AS updated_at
      FROM inbox_target_mute_states
      WHERE source_channel_id = ANY($1::uuid[])
      GROUP BY receiver_type, receiver_id
    ), deleted AS (
      DELETE FROM inbox_target_mute_states WHERE source_channel_id = ANY($1::uuid[])
    )
    INSERT INTO inbox_target_mute_states (
      receiver_type, receiver_id, server_id, source_channel_id, activity_muted, mute_from_seq, prefs_version, created_at, updated_at
    )
    SELECT receiver_type, receiver_id, server_id, $2::uuid, activity_muted, mute_from_seq, prefs_version, created_at, updated_at FROM merged
    ON CONFLICT (receiver_type, receiver_id, source_channel_id) DO UPDATE
      SET activity_muted = inbox_target_mute_states.activity_muted OR EXCLUDED.activity_muted,
          mute_from_seq = CASE
            WHEN inbox_target_mute_states.mute_from_seq IS NULL THEN EXCLUDED.mute_from_seq
            WHEN EXCLUDED.mute_from_seq IS NULL THEN inbox_target_mute_states.mute_from_seq
            ELSE LEAST(inbox_target_mute_states.mute_from_seq, EXCLUDED.mute_from_seq)
          END,
          prefs_version = GREATEST(inbox_target_mute_states.prefs_version, EXCLUDED.prefs_version),
          updated_at = GREATEST(inbox_target_mute_states.updated_at, EXCLUDED.updated_at)
  `, [allChannelIds, canonicalId]);

  await client.query(`
    UPDATE inbox_notification_facts
    SET source_channel_id = $1::uuid
    WHERE source_channel_id = ANY($2::uuid[])
  `, [canonicalId, duplicateIds]);

  await client.query(MERGE_INBOX_SUPPRESSION_STATES_SQL, [canonicalId, duplicateIds, allChannelIds]);

  await client.query(`
    WITH source AS (
      SELECT * FROM inbox_serving_rows WHERE source_channel_id = ANY($1::uuid[])
    ), latest AS (
      SELECT DISTINCT ON (receiver_type, receiver_id)
        receiver_type, receiver_id, server_id, kind, latest_notified_message_id, latest_notified_seq, latest_notified_at, last_activity_at
      FROM source
      ORDER BY receiver_type, receiver_id, latest_notified_at DESC, latest_notified_seq DESC
    ), first_unread AS (
      SELECT DISTINCT ON (receiver_type, receiver_id)
        receiver_type, receiver_id, first_unread_message_id, first_unread_seq
      FROM source
      WHERE first_unread_message_id IS NOT NULL
      ORDER BY receiver_type, receiver_id, first_unread_seq ASC
    ), latest_mention AS (
      SELECT DISTINCT ON (receiver_type, receiver_id)
        receiver_type, receiver_id, latest_personal_mention_message_id, latest_personal_mention_seq
      FROM source
      WHERE latest_personal_mention_message_id IS NOT NULL
      ORDER BY receiver_type, receiver_id, latest_personal_mention_seq DESC
    ), aggregate AS (
      SELECT
        receiver_type,
        receiver_id,
        SUM(unread_count)::int AS unread_count,
        SUM(unread_mention_count)::int AS unread_mention_count,
        BOOL_OR(has_any_mention) AS has_any_mention,
        MAX(updated_at) AS updated_at
      FROM source
      GROUP BY receiver_type, receiver_id
    ), merged AS (
      SELECT
        l.receiver_type,
        l.receiver_id,
        l.server_id,
        l.kind,
        l.latest_notified_message_id,
        l.latest_notified_seq,
        l.latest_notified_at,
        l.last_activity_at,
        fu.first_unread_message_id,
        fu.first_unread_seq,
        a.unread_count,
        lm.latest_personal_mention_message_id,
        lm.latest_personal_mention_seq,
        a.unread_mention_count,
        a.has_any_mention,
        a.updated_at
      FROM latest l
      JOIN aggregate a USING (receiver_type, receiver_id)
      LEFT JOIN first_unread fu USING (receiver_type, receiver_id)
      LEFT JOIN latest_mention lm USING (receiver_type, receiver_id)
    ), deleted AS (
      DELETE FROM inbox_serving_rows WHERE source_channel_id = ANY($1::uuid[])
    )
    INSERT INTO inbox_serving_rows (
      receiver_type, receiver_id, server_id, kind, source_channel_id,
      latest_notified_message_id, latest_notified_seq, latest_notified_at, last_activity_at,
      first_unread_message_id, first_unread_seq, unread_count,
      latest_personal_mention_message_id, latest_personal_mention_seq, unread_mention_count, has_any_mention,
      updated_at
    )
    SELECT
      receiver_type, receiver_id, server_id, kind, $2::uuid,
      latest_notified_message_id, latest_notified_seq, latest_notified_at, last_activity_at,
      first_unread_message_id, first_unread_seq, unread_count,
      latest_personal_mention_message_id, latest_personal_mention_seq, unread_mention_count, has_any_mention,
      updated_at
    FROM merged
    ON CONFLICT (receiver_type, receiver_id, source_channel_id) DO UPDATE
      SET latest_notified_message_id = EXCLUDED.latest_notified_message_id,
          latest_notified_seq = EXCLUDED.latest_notified_seq,
          latest_notified_at = EXCLUDED.latest_notified_at,
          last_activity_at = EXCLUDED.last_activity_at,
          first_unread_message_id = EXCLUDED.first_unread_message_id,
          first_unread_seq = EXCLUDED.first_unread_seq,
          unread_count = EXCLUDED.unread_count,
          latest_personal_mention_message_id = EXCLUDED.latest_personal_mention_message_id,
          latest_personal_mention_seq = EXCLUDED.latest_personal_mention_seq,
          unread_mention_count = EXCLUDED.unread_mention_count,
          has_any_mention = EXCLUDED.has_any_mention,
          updated_at = EXCLUDED.updated_at
  `, [allChannelIds, canonicalId]);

  await client.query("DELETE FROM channel_humans WHERE channel_id = ANY($1::uuid[])", [duplicateIds]);
  await client.query("DELETE FROM channel_agents WHERE channel_id = ANY($1::uuid[])", [duplicateIds]);
  // Identity provenance is per physical channel. Once duplicate contents and
  // memberships converge on the canonical channel, stale duplicate identities
  // must not let a future find/create revive a tombstoned duplicate.
  await client.query(DELETE_DUPLICATE_DM_IDENTITIES_SQL, [duplicateIds]);
  await client.query("UPDATE channels SET deleted_at = NOW() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL", [duplicateIds]);
  await assertGroupConverged(client, group);

  return { serverMemberRowsUpdated };
}

async function loadRows(client: pg.PoolClient, options: Options): Promise<DetailedRow[]> {
  if (options.inputPath) {
    const input = fs.readFileSync(options.inputPath, "utf8");
    const rows = parseDetailedTsv(input);
    return options.serverId ? rows.filter((row) => row.serverId === options.serverId) : rows;
  }
  return discoverDetailedRows(client, options.serverId);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "dry-run" && options.inputPath) {
    const input = fs.readFileSync(options.inputPath, "utf8");
    const rows = parseDetailedTsv(input);
    const filteredRows = options.serverId ? rows.filter((row) => row.serverId === options.serverId) : rows;
    const groups = buildRepairGroups(filteredRows, options.limit);
    printResult(options, buildPlanResult(options, groups));
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    usage();
    throw new Error("DATABASE_URL is required");
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(options.mode === "dry-run" ? "BEGIN READ ONLY" : "BEGIN");
    const rows = await loadRows(client, options);
    const groups = buildRepairGroups(rows, options.limit);
    const result = buildPlanResult(options, groups);

    if (options.mode === "apply") {
      for (const group of groups) {
        if (group.disposition === "quarantine") continue;
        const applied = await applyGroup(client, group);
        result.applied.push({
          key: group.key,
          canonicalChannelId: group.canonicalChannelId,
          duplicateChannelIds: group.duplicateChannelIds,
          serverMemberRowsUpdated: applied.serverMemberRowsUpdated,
        });
      }
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }

    printResult(options, result);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function isMain() {
  const current = fileURLToPath(import.meta.url);
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return current === invoked;
}

if (isMain()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
