// RFC 057 / PR #5770 review P1-2: the PGlite migration applier must share the
// production deploy migrator's transaction model — ALL pending statements plus
// their journal inserts in ONE transaction — so migrations may rely on
// transaction-scoped semantics (SET LOCAL, LOCK ... NOWAIT held to commit) and a
// mid-set failure leaves zero partial state and no journal advance.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migratePglite } from "./pgliteMigrations.js";

function makeFolder(entries: Array<{ tag: string; sql: string }>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pglite-mig-"));
  mkdirSync(path.join(dir, "meta"));
  writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({
      entries: entries.map((e, i) => ({ idx: i, when: i + 1, tag: e.tag })),
    }),
  );
  for (const e of entries) {
    writeFileSync(path.join(dir, `${e.tag}.sql`), e.sql);
  }
  return dir;
}

test("pglite migrator: pending set + journal commit atomically; SET LOCAL and bare LOCK ... NOWAIT are legal", async () => {
  const dir = makeFolder([
    {
      tag: "0001_first",
      sql: [
        `SET LOCAL statement_timeout = '10s';`,
        `CREATE TABLE widen_tx_probe (id integer PRIMARY KEY);`,
        `LOCK TABLE widen_tx_probe IN ACCESS EXCLUSIVE MODE NOWAIT;`,
        `INSERT INTO widen_tx_probe (id) VALUES (1);`,
      ].join("--> statement-breakpoint\n"),
    },
  ]);
  const client = new PGlite();
  try {
    await migratePglite(client, dir);
    const rows = await client.query<{ id: number }>(`SELECT id FROM widen_tx_probe`);
    assert.equal(rows.rows[0]?.id, 1);
    const journal = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "__drizzle_migrations"`,
    );
    assert.equal(journal.rows[0]?.n, 1, "journal advanced with the set");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pglite migrator: a failing migration rolls back the WHOLE pending set — zero partial state, journal untouched", async () => {
  const dir = makeFolder([
    { tag: "0001_ok", sql: `CREATE TABLE widen_rollback_a (id integer PRIMARY KEY);` },
    {
      tag: "0002_boom",
      sql: [
        `CREATE TABLE widen_rollback_b (id integer PRIMARY KEY);`,
        `SELECT 1/0;`,
      ].join("--> statement-breakpoint\n"),
    },
  ]);
  const client = new PGlite();
  try {
    await assert.rejects(migratePglite(client, dir), /division by zero/);
    const a = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('widen_rollback_a', 'widen_rollback_b')`,
    );
    assert.equal(a.rows[0]?.n, 0, "no table from the pending set may survive");
    const journal = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "__drizzle_migrations"`,
    );
    assert.equal(journal.rows[0]?.n, 0, "journal must not advance past a failed set");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
