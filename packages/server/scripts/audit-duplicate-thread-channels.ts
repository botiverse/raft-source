#!/usr/bin/env tsx
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "../src/db/schema.js";

type CliOptions = {
  serverId?: string;
  json: boolean;
};

type DuplicateThreadRow = {
  parentMessageId: string;
  parentChannelId: string;
  duplicateThreadCount: number;
  canonicalThreadId: string;
  threadChannelId: string;
  replyCount: number;
  lastReplyAt: string | null;
  createdAt: string;
  deletedAt: string | null;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--server-id" && argv[i + 1]) {
      options.serverId = argv[++i];
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  console.error(
    [
      "Usage:",
      "  DATABASE_URL=... tsx scripts/audit-duplicate-thread-channels.ts [--server-id <uuid>] [--json]",
      "",
      "Options:",
      "  --server-id <id>  Restrict audit to a single server",
      "  --json            Print machine-readable JSON instead of a text report",
    ].join("\n"),
  );
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    usage();
    throw new Error("DATABASE_URL is required");
  }

  const options = parseArgs(process.argv.slice(2));
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  const db = drizzle(pool, { schema });

  try {
    const scopeWhere = options.serverId
      ? sql`AND c.server_id = ${options.serverId}`
      : sql``;

    const rows = await db.execute<DuplicateThreadRow>(sql`
      WITH thread_stats AS (
        SELECT
          c.id AS thread_channel_id,
          c.parent_message_id,
          pm.channel_id AS parent_channel_id,
          c.created_at,
          c.deleted_at,
          COALESCE(stats.reply_count, 0)::int AS reply_count,
          stats.last_reply_at::text AS last_reply_at,
          ROW_NUMBER() OVER (
            PARTITION BY c.parent_message_id
            ORDER BY
              stats.last_reply_at DESC NULLS LAST,
              COALESCE(stats.reply_count, 0) DESC,
              c.created_at ASC,
              c.id ASC
          ) AS thread_rank,
          COUNT(*) OVER (PARTITION BY c.parent_message_id)::int AS duplicate_thread_count,
          FIRST_VALUE(c.id) OVER (
            PARTITION BY c.parent_message_id
            ORDER BY
              stats.last_reply_at DESC NULLS LAST,
              COALESCE(stats.reply_count, 0) DESC,
              c.created_at ASC,
              c.id ASC
          ) AS canonical_thread_id
        FROM channels c
        JOIN messages pm ON pm.id = c.parent_message_id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS reply_count,
            MAX(m.created_at) AS last_reply_at
          FROM messages m
          WHERE m.channel_id = c.id
        ) stats ON TRUE
        WHERE c.type = 'thread'
          AND c.deleted_at IS NULL
          AND c.parent_message_id IS NOT NULL
          ${scopeWhere}
      )
      SELECT
        parent_message_id::text AS "parentMessageId",
        parent_channel_id::text AS "parentChannelId",
        duplicate_thread_count AS "duplicateThreadCount",
        canonical_thread_id::text AS "canonicalThreadId",
        thread_channel_id::text AS "threadChannelId",
        reply_count AS "replyCount",
        last_reply_at AS "lastReplyAt",
        created_at::text AS "createdAt",
        deleted_at::text AS "deletedAt"
      FROM thread_stats
      WHERE duplicate_thread_count > 1
      ORDER BY parent_message_id, thread_rank
    `);

    if (options.json) {
      console.log(JSON.stringify(rows.rows, null, 2));
      return;
    }

    if (rows.rows.length === 0) {
      console.error("No duplicate active thread channels found.");
      return;
    }

    const grouped = new Map<string, DuplicateThreadRow[]>();
    for (const row of rows.rows) {
      const group = grouped.get(row.parentMessageId) ?? [];
      group.push(row);
      grouped.set(row.parentMessageId, group);
    }

    console.error(`Found ${grouped.size} parent messages with duplicate active thread channels.`);
    for (const [parentMessageId, group] of grouped) {
      console.error(`\nparent=${parentMessageId} parentChannel=${group[0]?.parentChannelId} canonical=${group[0]?.canonicalThreadId}`);
      for (const row of group) {
        const marker = row.threadChannelId === row.canonicalThreadId ? "*" : "-";
        console.error(
          `  ${marker} thread=${row.threadChannelId} replies=${row.replyCount} lastReplyAt=${row.lastReplyAt ?? "null"} createdAt=${row.createdAt}`,
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
