#!/usr/bin/env tsx
import { fileURLToPath } from "node:url";
import pg from "pg";

type Mode = "dry-run" | "apply";
type Options = {
  mode: Mode;
  serverId: string | null;
  limit: number | null;
  confirm: string | null;
  json: boolean;
};

export type EmptyThreadCandidate = {
  threadChannelId: string;
  serverId: string;
  parentMessageId: string;
  createdAt: string;
  replyCount: number;
  parentPointerCount: number;
  otherPointerCount: number;
};

type ForeignKeyRef = { schemaName: string; tableName: string; columnName: string };
type CountedRef = { table: string; column: string; count: number };
export type EmptyThreadDecision = EmptyThreadCandidate & {
  disposition: "delete" | "quarantine";
  reasons: string[];
  foreignKeyRefs: CountedRef[];
};

const APPLY_CONFIRMATION = "task180-empty-thread-cleanup";

function usage() {
  console.error([
    "Usage:",
    "  DATABASE_URL=... pnpm --filter @botiverse/raft-server exec tsx scripts/cleanup-empty-thread-channels.ts [--server-id <uuid>] [--limit <n>] [--json]",
    "  DATABASE_URL=... pnpm --filter @botiverse/raft-server exec tsx scripts/cleanup-empty-thread-channels.ts --apply --confirm task180-empty-thread-cleanup [--server-id <uuid>] [--limit <n>] [--json]",
    "",
    "Contract:",
    "  - Defaults to a READ ONLY dry-run.",
    "  - Candidates are active thread channels with zero reply messages.",
    "  - Any durable foreign-key reference or unexpected messages.thread_id pointer quarantines the row.",
    "  - Joint-channel projections are therefore quarantined rather than partially deleted.",
    "  - Apply discovers first, then uses a short lock timeout while blocking message writes for the destructive window.",
    "  - It re-discovers and locks every candidate, clears only its exact parent anchor, then hard-deletes the channel.",
    `  - --apply requires the exact token: --confirm ${APPLY_CONFIRMATION}`,
  ].join("\n"));
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { mode: "dry-run", serverId: null, limit: null, confirm: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      options.mode = "apply";
      continue;
    }
    if (arg === "--confirm" && argv[i + 1]) {
      options.confirm = argv[++i];
      continue;
    }
    if (arg === "--server-id" && argv[i + 1]) {
      options.serverId = argv[++i];
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      const limit = Number(argv[++i]);
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
      options.limit = limit;
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
  return options;
}

export function classifyCandidate(
  candidate: EmptyThreadCandidate,
  foreignKeyRefs: CountedRef[],
): EmptyThreadDecision {
  const reasons: string[] = [];
  if (candidate.replyCount !== 0) reasons.push("has_reply_messages");
  if (candidate.otherPointerCount !== 0) reasons.push("unexpected_thread_pointer");
  if (candidate.parentPointerCount > 1) reasons.push("multiple_parent_pointers");
  if (foreignKeyRefs.length > 0) reasons.push("durable_foreign_key_reference");
  return {
    ...candidate,
    disposition: reasons.length === 0 ? "delete" : "quarantine",
    reasons,
    foreignKeyRefs,
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function discoverCandidates(
  client: pg.PoolClient,
  options: Options,
  candidateIds: string[] | null = null,
): Promise<EmptyThreadCandidate[]> {
  const values: unknown[] = [];
  const filters = ["c.type = 'thread'", "c.deleted_at IS NULL", "c.parent_message_id IS NOT NULL"];
  if (options.serverId) {
    values.push(options.serverId);
    filters.push(`c.server_id = $${values.length}::uuid`);
  }
  if (candidateIds) {
    values.push(candidateIds);
    filters.push(`c.id = ANY($${values.length}::uuid[])`);
  }
  const limitSql = !candidateIds && options.limit ? `LIMIT ${options.limit}` : "";
  const result = await client.query<EmptyThreadCandidate>(`
    SELECT
      c.id::text AS "threadChannelId",
      c.server_id::text AS "serverId",
      c.parent_message_id::text AS "parentMessageId",
      c.created_at::text AS "createdAt",
      COALESCE(replies.reply_count, 0)::int AS "replyCount",
      COALESCE(pointers.parent_pointer_count, 0)::int AS "parentPointerCount",
      COALESCE(pointers.other_pointer_count, 0)::int AS "otherPointerCount"
    FROM channels c
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS reply_count FROM messages m WHERE m.channel_id = c.id
    ) replies ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE m.id = c.parent_message_id)::int AS parent_pointer_count,
        COUNT(*) FILTER (WHERE m.id <> c.parent_message_id)::int AS other_pointer_count
      FROM messages m
      WHERE m.thread_id = c.id::text
    ) pointers ON TRUE
    WHERE ${filters.join(" AND ")}
      AND COALESCE(replies.reply_count, 0) = 0
    ORDER BY c.created_at, c.id
    ${limitSql}
  `, values);
  return result.rows;
}

async function discoverChannelForeignKeys(client: pg.PoolClient): Promise<ForeignKeyRef[]> {
  const result = await client.query<ForeignKeyRef>(`
    SELECT ns.nspname AS "schemaName", rel.relname AS "tableName", att.attname AS "columnName"
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    JOIN unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON TRUE
    JOIN unnest(con.confkey) WITH ORDINALITY AS target(attnum, ordinality)
      ON target.ordinality = key.ordinality
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = key.attnum
    JOIN pg_attribute target_att ON target_att.attrelid = con.confrelid AND target_att.attnum = target.attnum
    WHERE con.contype = 'f'
      AND con.confrelid = 'channels'::regclass
      AND target_att.attname = 'id'
    ORDER BY ns.nspname, rel.relname, att.attname
  `);
  return result.rows;
}

async function countForeignKeyRefs(
  client: pg.PoolClient,
  candidates: EmptyThreadCandidate[],
  foreignKeys: ForeignKeyRef[],
): Promise<Map<string, CountedRef[]>> {
  const refsByChannel = new Map<string, CountedRef[]>();
  const ids = candidates.map((candidate) => candidate.threadChannelId);
  if (ids.length === 0) return refsByChannel;
  for (const foreignKey of foreignKeys) {
    const table = `${quoteIdentifier(foreignKey.schemaName)}.${quoteIdentifier(foreignKey.tableName)}`;
    const column = quoteIdentifier(foreignKey.columnName);
    const result = await client.query<{ channelId: string; count: number }>(
      `SELECT ${column}::text AS "channelId", COUNT(*)::int AS count
       FROM ${table}
       WHERE ${column} = ANY($1::uuid[])
       GROUP BY ${column}`,
      [ids],
    );
    for (const row of result.rows) {
      const refs = refsByChannel.get(row.channelId) ?? [];
      refs.push({
        table: `${foreignKey.schemaName}.${foreignKey.tableName}`,
        column: foreignKey.columnName,
        count: row.count,
      });
      refsByChannel.set(row.channelId, refs);
    }
  }
  return refsByChannel;
}

async function inspect(
  client: pg.PoolClient,
  options: Options,
  candidateIds: string[] | null = null,
): Promise<EmptyThreadDecision[]> {
  const candidates = await discoverCandidates(client, options, candidateIds);
  const foreignKeys = await discoverChannelForeignKeys(client);
  const refsByChannel = await countForeignKeyRefs(client, candidates, foreignKeys);
  return candidates.map((candidate) => classifyCandidate(candidate, refsByChannel.get(candidate.threadChannelId) ?? []));
}

async function applyCleanup(client: pg.PoolClient, options: Options): Promise<EmptyThreadDecision[]> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL statement_timeout = '5min'");
    const initial = await discoverCandidates(client, options);
    if (initial.length === 0) {
      await client.query("COMMIT");
      return [];
    }
    // messages.thread_id is intentionally not a foreign key. Block message
    // writes during the destructive window so a concurrent reply or pointer
    // cannot slip between the safety inspection and the final DELETE.
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE");
    await client.query(
      "SELECT id FROM channels WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [initial.map((candidate) => candidate.threadChannelId)],
    );
    await client.query(
      "SELECT id FROM messages WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [initial.map((candidate) => candidate.parentMessageId)],
    );
    const decisions = await inspect(
      client,
      options,
      initial.map((candidate) => candidate.threadChannelId),
    );
    for (const decision of decisions) {
      if (decision.disposition !== "delete") continue;
      await client.query(
        "UPDATE messages SET thread_id = NULL WHERE id = $1::uuid AND thread_id = $2::text",
        [decision.parentMessageId, decision.threadChannelId],
      );
      const deleted = await client.query(
        `DELETE FROM channels c
         WHERE c.id = $1::uuid
           AND c.type = 'thread'
           AND c.deleted_at IS NULL
           AND c.parent_message_id = $2::uuid
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = c.id::text)
         RETURNING c.id`,
        [decision.threadChannelId, decision.parentMessageId],
      );
      if (deleted.rowCount !== 1) {
        throw new Error(`Concurrent state change blocked deletion of ${decision.threadChannelId}`);
      }
    }
    await client.query("COMMIT");
    return decisions;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function printReport(mode: Mode, decisions: EmptyThreadDecision[], json: boolean) {
  const deletable = decisions.filter((decision) => decision.disposition === "delete");
  const quarantined = decisions.filter((decision) => decision.disposition === "quarantine");
  if (json) {
    console.log(JSON.stringify({ mode, deletable: deletable.length, quarantined: quarantined.length, decisions }, null, 2));
    return;
  }
  console.error(`${mode}: ${deletable.length} deletable empty thread channel(s), ${quarantined.length} quarantined.`);
  for (const decision of decisions) {
    console.error(
      `${decision.disposition === "delete" ? "DELETE" : "HOLD"} thread=${decision.threadChannelId} parent=${decision.parentMessageId}`
      + (decision.reasons.length > 0 ? ` reasons=${decision.reasons.join(",")}` : ""),
    );
    for (const ref of decision.foreignKeyRefs) {
      console.error(`  ref ${ref.table}.${ref.column}=${ref.count}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    usage();
    throw new Error("DATABASE_URL is required");
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    if (options.mode === "apply") {
      printReport("apply", await applyCleanup(client, options), options.json);
      return;
    }
    await client.query("BEGIN READ ONLY");
    try {
      printReport("dry-run", await inspect(client, options), options.json);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
