#!/usr/bin/env tsx
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "../src/db/schema.js";
import { buildSearchText } from "../src/services/searchService.js";

type CliOptions = {
  batchSize: number;
  limit: number | null;
  dryRun: boolean;
  serverId?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    batchSize: 1000,
    limit: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--batch-size" && argv[i + 1]) {
      options.batchSize = Math.max(1, Number(argv[++i]) || 1000);
      continue;
    }
    if (arg === "--limit" && argv[i + 1]) {
      options.limit = Math.max(1, Number(argv[++i]) || 1);
      continue;
    }
    if (arg === "--server-id" && argv[i + 1]) {
      options.serverId = argv[++i];
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
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
      "  DATABASE_URL=... tsx scripts/backfill-search.ts [--batch-size 1000] [--limit 5000] [--server-id <uuid>] [--dry-run]",
      "",
      "Options:",
      "  --batch-size <n>  Number of rows per batch (default: 1000)",
      "  --limit <n>       Max number of rows to backfill before exiting",
      "  --server-id <id>  Restrict backfill to a single server",
      "  --dry-run         Show pending rows/sample output without writing",
    ].join("\n"),
  );
}

function buildScopeJoin(serverId?: string) {
  return serverId
    ? sql`JOIN channels c ON c.id = m.channel_id`
    : sql``;
}

function buildScopeWhere(serverId?: string) {
  return serverId
    ? sql`AND c.server_id = ${serverId}`
    : sql``;
}

async function countPending(db: ReturnType<typeof drizzle<typeof schema>>, serverId?: string) {
  const rows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM messages m
    ${buildScopeJoin(serverId)}
    WHERE m.search_text IS NULL
    ${buildScopeWhere(serverId)}
  `);
  return Number(rows.rows[0]?.count ?? "0");
}

async function selectBatch(
  db: ReturnType<typeof drizzle<typeof schema>>,
  batchSize: number,
  serverId?: string,
) {
  const rows = await db.execute<{ id: string; seq: number | string; content: string }>(sql`
    SELECT m.id, m.seq, m.content
    FROM messages m
    ${buildScopeJoin(serverId)}
    WHERE m.search_text IS NULL
    ${buildScopeWhere(serverId)}
    ORDER BY m.seq ASC
    LIMIT ${batchSize}
  `);
  return rows.rows.map((row) => ({
    id: row.id,
    seq: typeof row.seq === "number" ? row.seq : Number(row.seq),
    content: row.content,
  }));
}

async function updateBatch(
  db: ReturnType<typeof drizzle<typeof schema>>,
  updates: Array<{ id: string; searchText: string }>,
) {
  if (updates.length === 0) return;
  const values = updates.map((update) => sql`(${update.id}::uuid, ${update.searchText})`);
  await db.execute(sql`
    UPDATE messages AS m
    SET search_text = v.search_text
    FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, search_text)
    WHERE m.id = v.id
  `);
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
    const pending = await countPending(db, options.serverId);
    console.error(`Pending rows with NULL search_text: ${pending}`);
    if (pending === 0) return;

    if (options.dryRun) {
      const sample = await selectBatch(db, Math.min(options.batchSize, 5), options.serverId);
      console.error("Dry run sample:");
      for (const row of sample) {
        const searchText = buildSearchText(row.content);
        console.error(`  seq=${row.seq} id=${row.id} => ${JSON.stringify(searchText)}`);
      }
      return;
    }

    let processed = 0;
    while (true) {
      const remaining = options.limit == null ? options.batchSize : Math.min(options.batchSize, options.limit - processed);
      if (remaining <= 0) break;

      const batch = await selectBatch(db, remaining, options.serverId);
      if (batch.length === 0) break;

      const updates = batch.map((row) => ({
        id: row.id,
        searchText: buildSearchText(row.content),
      }));
      await updateBatch(db, updates);

      processed += updates.length;
      const lastSeq = batch[batch.length - 1]?.seq ?? "-";
      console.error(`Backfilled ${processed} rows so far (last seq=${lastSeq})`);

      if (options.limit != null && processed >= options.limit) break;
    }

    const pendingAfter = await countPending(db, options.serverId);
    console.error(`Done. Remaining rows with NULL search_text: ${pendingAfter}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
