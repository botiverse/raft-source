#!/usr/bin/env tsx
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq } from "drizzle-orm";
import type { Database } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import {
  backfillLegacyAttachmentObjectsBatch,
  getAttachmentObjectParityReport,
  runAttachmentObjectBackfill,
} from "../src/services/attachmentObjectBackfillService.js";

type Options = { apply: boolean; batchSize: number; maxRows: number | null; serverId?: string };

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false, batchSize: 100, maxRows: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--batch-size" && argv[index + 1]) options.batchSize = Number(argv[++index]);
    else if (arg === "--max-rows" && argv[index + 1]) options.maxRows = Number(argv[++index]);
    else if (arg === "--server-id" && argv[index + 1]) options.serverId = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1_000) {
    throw new Error("--batch-size must be an integer between 1 and 1000");
  }
  if (options.maxRows !== null && (!Number.isSafeInteger(options.maxRows) || options.maxRows < 1)) {
    throw new Error("--max-rows must be a positive integer");
  }
  return options;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const options = parseArgs(process.argv.slice(2));
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  const db = drizzle(pool, { schema }) as unknown as Database;
  try {
    await runAttachmentObjectBackfill({
      options,
      fleetReadyEnv: process.env.ATTACHMENT_OBJECT_DUAL_WRITE_FLEET_READY,
      serverExists: async (id) =>
        (await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.id, id)).limit(1)).length > 0,
      readParity: () => getAttachmentObjectParityReport(db, options.serverId),
      runBatch: (limit) => backfillLegacyAttachmentObjectsBatch(db, limit, {}, options.serverId),
      log: (record) => console.error(JSON.stringify(record)),
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
