import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";

type MigrationJournal = {
  entries: Array<{
    idx: number;
    when: number;
    tag: string;
  }>;
};

const DRIZZLE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

const PGLITE_COMPATIBILITY_STATEMENTS = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "idx_messages_user_random_id"
    ON "messages" USING btree ("sender_id", "random_id")
    WHERE sender_type = 'user' and random_id is not null`,
  `CREATE INDEX IF NOT EXISTS "idx_inbox_serving_rows_receiver_server_last_activity"
    ON "inbox_serving_rows" USING btree
      ("receiver_type", "receiver_id", "server_id", "last_activity_at")`,
  `CREATE INDEX IF NOT EXISTS "idx_messages_sender_created_at"
    ON "messages" USING btree ("sender_id", "created_at", "id")`,
];

async function ensureMigrationTable(client: PGlite) {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
}

async function getLastAppliedMigrationMillis(client: PGlite): Promise<number> {
  const result = await client.query<{ created_at: string | number }>(
    `SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`,
  );
  const latest = result.rows[0]?.created_at;
  return latest == null ? 0 : Number(latest);
}

async function readMigrationJournal(drizzleDir: string): Promise<MigrationJournal> {
  const journalPath = path.join(drizzleDir, "meta", "_journal.json");
  const raw = await readFile(journalPath, "utf8");
  return JSON.parse(raw) as MigrationJournal;
}

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function migratePglite(client: PGlite, drizzleDir: string = DRIZZLE_DIR) {
  await ensureMigrationTable(client);

  const journal = await readMigrationJournal(drizzleDir);
  const lastAppliedMillis = await getLastAppliedMigrationMillis(client);
  const pending = journal.entries
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .filter((entry) => entry.when > lastAppliedMillis);

  // Local PGlite bootstrap intentionally keeps ALL pending statements and
  // journal inserts in ONE transaction. This preserves the local rollback
  // contract and is separate from the production deploy runner, which invokes
  // canonical node-postgres `migrate()` once per configured lock-sensitive
  // phase. Migrations may rely on transaction-scoped semantics (`SET LOCAL`,
  // `LOCK TABLE ... NOWAIT` held to commit), and a local mid-migration failure
  // rolls back the entire pending set — no partial schema, no journal advance.
  if (pending.length > 0) {
    await client.exec("BEGIN");
    try {
      for (const entry of pending) {
        const sqlPath = path.join(drizzleDir, `${entry.tag}.sql`);
        const sqlText = await readFile(sqlPath, "utf8");
        const statements = splitStatements(sqlText);
        for (const statement of statements) {
          await client.exec(statement);
        }
        const hash = createHash("sha256").update(sqlText).digest("hex");
        await client.query(
          `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
          [hash, entry.when],
        );
      }
      await client.exec("COMMIT");
    } catch (err) {
      await client.exec("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  // Compatibility statements target the real schema; custom test folders
  // (rollback/transaction teeth) don't have those relations.
  if (drizzleDir === DRIZZLE_DIR) {
    for (const statement of PGLITE_COMPATIBILITY_STATEMENTS) {
      await client.exec(statement);
    }
  }
}
