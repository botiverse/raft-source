import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// RFC 081 inbox items: third_party_agent_events.object_ref, related_channel_id
// and consumed_via. Nullable, no default, no NOT NULL, no foreign key (older
// nodes insert without them during a rolling deploy; existing rows stay NULL,
// D9). The CHECK is added NOT VALID and never validated in the migration (its
// one transaction would scan under ACCESS EXCLUSIVE; every existing row is
// NULL, and new writes are checked); the partial index is
// built in the migration only on a small table (otherwise by
// db:create-device-session-key-indexes, CONCURRENTLY).
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith("_inbox_items_object_ref"));
  assert.ok(entry, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

const TABLE = `CREATE TABLE "third_party_agent_events" (
  "id" serial PRIMARY KEY,
  "agent_id" uuid NOT NULL,
  "client_id" uuid,
  "system_app" text,
  "status" text NOT NULL DEFAULT 'queued',
  "created_at" timestamptz NOT NULL DEFAULT now()
)`;

test("adds three nullable columns with no default and no foreign key, a NOT VALID CHECK it does not validate, under a bounded lock wait", async () => {
  const steps = await migration();
  assertBoundedLockTimeout(steps[0], "inbox items", { maxMs: 5_000 });
  assert.equal(steps[1], "SET LOCAL statement_timeout = '30s';");
  assert.deepEqual(steps.slice(2, 6), [
    `ALTER TABLE "third_party_agent_events" ADD COLUMN "object_ref" text;`,
    `ALTER TABLE "third_party_agent_events" ADD COLUMN "related_channel_id" uuid;`,
    `ALTER TABLE "third_party_agent_events" ADD COLUMN "consumed_via" text;`,
    `ALTER TABLE "third_party_agent_events" ADD CONSTRAINT "third_party_agent_events_consumed_via_known" CHECK ("third_party_agent_events"."consumed_via" is null or "third_party_agent_events"."consumed_via" in ('read', 'dismissed')) NOT VALID;`,
  ]);
  assert.ok(!steps.some((step) => /VALIDATE CONSTRAINT/i.test(step)), "no validating scan under the migration's ACCESS EXCLUSIVE lock");
  // The index only inside the size guard, never a plain CREATE INDEX on a large table.
  assert.equal(steps.length, 7);
  assert.match(steps[6]!, /IF pg_relation_size\('public\.third_party_agent_events'::regclass\) <= 1048576 THEN\s+CREATE INDEX IF NOT EXISTS "idx_third_party_agent_events_agent_unconsumed_item"/);
  assert.ok(!steps.some((step) => /REFERENCES/i.test(step)), "no foreign key to channels");
});

test("existing rows stay NULL; an older node's insert still succeeds; consumed_via takes read and dismissed only; the index is partial on unconsumed rows", async () => {
  const db = new PGlite();
  try {
    await db.exec(`${TABLE};
      INSERT INTO "third_party_agent_events" (agent_id, status) VALUES ('11111111-1111-4111-8111-111111111111', 'delivered');`);
    await db.exec("BEGIN");
    for (const step of await migration()) await db.exec(step);
    await db.exec("COMMIT");
    assert.deepEqual((await db.query(`SELECT object_ref, related_channel_id, consumed_via FROM third_party_agent_events`)).rows, [
      { object_ref: null, related_channel_id: null, consumed_via: null },
    ]);
    await db.query(`INSERT INTO third_party_agent_events (agent_id) VALUES ('22222222-2222-4222-8222-222222222222')`);
    for (const via of ["read", "dismissed"]) {
      await db.query(`INSERT INTO third_party_agent_events (agent_id, status, consumed_via, object_ref) VALUES ($1, 'delivered', $2, 'pr-1')`, ["33333333-3333-4333-8333-333333333333", via]);
    }
    await assert.rejects(
      db.query(`INSERT INTO third_party_agent_events (agent_id, consumed_via) VALUES ('44444444-4444-4444-8444-444444444444', 'seen')`),
      /third_party_agent_events_consumed_via_known/,
    );
    // NOT VALID: the constraint is in place for new writes, not yet validated.
    const constraint = await db.query<{ convalidated: boolean }>(`SELECT convalidated FROM pg_constraint WHERE conname = 'third_party_agent_events_consumed_via_known'`);
    assert.deepEqual(constraint.rows, [{ convalidated: false }]);
    const index = await db.query<{ def: string; valid: boolean }>(`SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'idx_third_party_agent_events_agent_unconsumed_item'`);
    assert.equal(index.rows.length, 1, "built on a small table");
    assert.equal(index.rows[0]!.valid, true);
    assert.match(index.rows[0]!.def, /\(agent_id, client_id, system_app, object_ref, created_at\) WHERE \(status = ANY \(ARRAY\['queued'::text, 'delivering'::text\]\)\)/);
  } finally {
    await db.close();
  }
});
