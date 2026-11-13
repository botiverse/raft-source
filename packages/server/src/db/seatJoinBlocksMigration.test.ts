import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Join links that can't let someone in (task #10 #proj-commercial): a new,
// empty table, one active row per person and server, a CHECK on what an ended
// row holds. Found by its tag's suffix, so a renumbering doesn't touch this.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const SUFFIX = "_seat_join_blocks";

type JournalEntry = { idx: number; tag: string };

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function target(): Promise<{ entries: JournalEntry[]; step: JournalEntry }> {
  const entries = (JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] }).entries;
  const step = entries.find((candidate) => candidate.tag.endsWith(SUFFIX));
  assert.ok(step, `${SUFFIX} is in the journal`);
  return { entries, step };
}

async function migrationStatements(entry: JournalEntry): Promise<string[]> {
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

async function apply(client: PGlite, entries: JournalEntry[]): Promise<void> {
  for (const entry of entries) {
    await client.exec("BEGIN");
    try {
      for (const statement of await migrationStatements(entry)) await client.exec(statement);
      await client.exec("COMMIT");
    } catch (error) {
      await client.exec("ROLLBACK");
      throw error;
    }
  }
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";
const SERVER = "33333333-3333-4333-8333-333333333333";

const SEED = `
  INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${OWNER}', 'owner@slock.test', 'owner', 'test');
  INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${GRACE}', 'grace@slock.test', 'grace', 'test');
  INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES ('${SERVER}', 'Lumen', 'lumen', '${OWNER}');
`;

function block(state = "active", extra = ""): string {
  return `INSERT INTO "seat_join_blocks" ("id", "server_id", "user_id", "inviter_user_id", "state"${extra ? ", \"resolved_at\", \"resolved_reason\"" : ""})
    VALUES (gen_random_uuid(), '${SERVER}', '${GRACE}', '${OWNER}', '${state}'${extra})`;
}

test("the migration is lock-bounded, only adds, and is the journal's own entry", async () => {
  const { step } = await target();
  const executable = await migrationStatements(step);
  assert.match(executable[0] ?? "", /^SET LOCAL lock_timeout = '\d+s';$/);
  for (const statement of executable) {
    assert.doesNotMatch(statement, /^UPDATE\b|\b(DROP|DELETE FROM|INSERT INTO|SET DATA TYPE)\b/i, "a new table: nothing dropped or rewritten");
    assert.match(statement, /^(SET LOCAL|CREATE TABLE "seat_join_blocks"|ALTER TABLE "seat_join_blocks" ADD CONSTRAINT|CREATE UNIQUE INDEX "idx_seat_join_blocks_active")/);
  }
});

test("one active row per person and server; an ended row says when and why; it goes with the person", async () => {
  const { entries, step } = await target();
  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx <= step.idx));
    await client.exec(SEED);
    await client.exec(block());
    await assert.rejects(client.exec(block()), /idx_seat_join_blocks_active/, "a second active row for Grace");
    await assert.rejects(client.exec(block("resolved")), /seat_join_blocks_state_shape/, "ended without when and why");
    await assert.rejects(client.exec(block("resolved", ", now(), 'gone'")), /seat_join_blocks_state_shape/, "an unknown reason");
    await client.exec(block("resolved", ", now(), 'expired'"));
    await client.exec(`DELETE FROM "users" WHERE "id" = '${GRACE}'`);
    const [{ count }] = (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM seat_join_blocks`)).rows;
    assert.equal(count, 0, "Grace's rows went with her");
  } finally {
    await client.close();
  }
});
