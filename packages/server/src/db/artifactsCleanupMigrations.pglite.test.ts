import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { encodeArtifactShortId } from "@botiverse/raft-shared";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";
import { resolveMigrationTransactionTimeout } from "./migrationPhases";

/**
 * Artifacts' next-release cleanup (task #proj-workspace:#159). Both migrations
 * run on a small table of the production shape: a whole history is not needed,
 * and neither one reads anything else.
 */

const drizzleUrl = (path: string) => new URL(`../../drizzle/${path}`, import.meta.url);
const journal = JSON.parse(readFileSync(drizzleUrl("meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };

/** By its name, not its number: a renumber moves the number. */
function migration(name: string): { tag: string; sql: string; statements: string[] } {
  const tag = journal.entries.map((entry) => entry.tag).find((candidate) => candidate.endsWith(`_${name}`));
  assert.ok(tag, `${name} is in the journal`);
  const sql = readFileSync(drizzleUrl(`${tag}.sql`), "utf8");
  return { tag, sql, statements: sql.split("--> statement-breakpoint").map((statement) => statement.trim()) };
}

const apply = (pg: PGlite, sql: string) => pg.exec(`BEGIN;\n${sql}\n;COMMIT;`);

/** The statements after the leading comments: assertBoundedLockTimeout reads the statement alone. */
const lockTimeoutOf = (statement: string | undefined) => statement?.split("\n").filter((line) => !line.startsWith("--")).join("\n").trim();

const DROPPED = ["desktop_key", "desktop_bytes", "phone_key", "phone_bytes"];

test("version_checks: the four old columns go, the file ids and the rows stay, and it runs again as a no-op", async () => {
  const { sql } = migration("version_checks_drop_shot_columns");
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE SCHEMA app_artifacts;
      CREATE TABLE app_artifacts.version_checks (
        id uuid PRIMARY KEY, version_id text NOT NULL, status text NOT NULL,
        desktop_key text, desktop_bytes integer, phone_key text, phone_bytes integer,
        desktop_file_id uuid, phone_file_id uuid);
      INSERT INTO app_artifacts.version_checks (id, version_id, status, desktop_file_id)
        VALUES ('11111111-1111-4111-8111-111111111111', 'v_1', 'done', '22222222-2222-4222-8222-222222222222');
    `);
    await apply(pg, sql);
    const columns = async () => (await pg.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'app_artifacts' AND table_name = 'version_checks' ORDER BY 1",
    )).rows.map((row) => row.column_name);
    assert.deepEqual(await columns(), ["desktop_file_id", "id", "phone_file_id", "status", "version_id"]);
    await apply(pg, sql);
    assert.deepEqual(await columns(), ["desktop_file_id", "id", "phone_file_id", "status", "version_id"], "IF EXISTS: nothing left to drop");
    const { rows } = await pg.query<{ desktop_file_id: string }>("SELECT desktop_file_id FROM app_artifacts.version_checks");
    assert.deepEqual(rows, [{ desktop_file_id: "22222222-2222-4222-8222-222222222222" }]);
  } finally {
    await pg.close();
  }
});

test("version_checks: bounded", () => {
  const { tag, sql, statements } = migration("version_checks_drop_shot_columns");
  assertBoundedLockTimeout(lockTimeoutOf(statements[0]), `${tag}'s lock timeout`, { maxMs: 2_000 });
  assert.equal(statements.length, 2, "one ALTER TABLE: the ACCESS EXCLUSIVE lock is taken once");
  for (const column of DROPPED) assert.match(statements[1]!, new RegExp(`DROP COLUMN IF EXISTS "${column}"`));
  assert.equal(resolveMigrationTransactionTimeout(tag, sql).source, "default");
});

const uuid = (last: string) => `cf5d7bb5-6bbe-4304-bc87-${last.padStart(12, "0")}`;
const ITEMS = {
  stored: `pt_${uuid("1")}`,
  // Mostly zero bytes: the short id is left-padded with "1".
  leadingZeros: "pt_00000000-0000-4000-8000-000000000001",
  deleted: `pt_${uuid("2")}`,
  revoked: `pt_${uuid("3")}`,
  oldName: `pt_${uuid("4")}`,
  othersShortId: `pt_${uuid("5")}`,
  shortIdShapedOldName: `pt_${uuid("6")}`,
  fixtureId: "pt_fake-roadmap",
  noName: `pt_${uuid("7")}`,
};
const shortIdOf = (id: string) => encodeArtifactShortId(id.slice("pt_".length));

async function itemsAfter(sql: string, runs = 1): Promise<Map<string, string | null>> {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE SCHEMA app_artifacts;
      CREATE TABLE app_artifacts.items (id text PRIMARY KEY, name text, deleted_at timestamptz, revoked_at timestamptz);
    `);
    const rows: Array<[string, string | null, string?]> = [
      [ITEMS.stored, shortIdOf(ITEMS.stored)],
      [ITEMS.leadingZeros, shortIdOf(ITEMS.leadingZeros)],
      [ITEMS.deleted, shortIdOf(ITEMS.deleted), "deleted_at"],
      [ITEMS.revoked, shortIdOf(ITEMS.revoked), "revoked_at"],
      [ITEMS.oldName, "launch-plan"],
      [ITEMS.othersShortId, shortIdOf(ITEMS.stored)],
      [ITEMS.shortIdShapedOldName, "1abcdefghijkmnopqrstuv"],
      [ITEMS.fixtureId, "ScAiFjjtiUvoyEYA6Ry12u"],
      [ITEMS.noName, null],
    ];
    for (const [id, name, when] of rows) {
      await pg.query(
        `INSERT INTO app_artifacts.items (id, name, deleted_at, revoked_at) VALUES ($1, $2, ${when === "deleted_at" ? "now()" : "NULL"}, ${when === "revoked_at" ? "now()" : "NULL"})`,
        [id, name],
      );
    }
    for (let run = 0; run < runs; run += 1) await apply(pg, sql);
    const { rows: after } = await pg.query<{ id: string; name: string | null }>("SELECT id, name FROM app_artifacts.items");
    return new Map(after.map((row) => [row.id, row.name]));
  } finally {
    await pg.close();
  }
}

test("items: only a name that is the row's own short id goes", async () => {
  const { sql } = migration("artifact_items_stored_short_ids_clear");
  const after = await itemsAfter(sql);
  assert.equal(after.get(ITEMS.stored), null);
  assert.equal(after.get(ITEMS.leadingZeros), null, "a short id with leading 1s");
  assert.equal(after.get(ITEMS.deleted), null, "a deleted row too: a restore reads the name");
  assert.equal(after.get(ITEMS.revoked), null);
  assert.equal(after.get(ITEMS.oldName), "launch-plan");
  assert.equal(after.get(ITEMS.othersShortId), shortIdOf(ITEMS.stored), "another Artifact's short id is only a name here");
  assert.equal(after.get(ITEMS.shortIdShapedOldName), "1abcdefghijkmnopqrstuv", "an old name that reads as a short id");
  assert.equal(after.get(ITEMS.fixtureId), "ScAiFjjtiUvoyEYA6Ry12u", "an id that is no uuid has no short id");
  assert.equal(after.get(ITEMS.noName), null);
});

test("items: running it again changes nothing", async () => {
  const { sql } = migration("artifact_items_stored_short_ids_clear");
  assert.deepEqual([...(await itemsAfter(sql, 2))].sort(), [...(await itemsAfter(sql))].sort());
});

test("items: past its time it stops without an error, keeping the rows it hasn't reached", async () => {
  const { sql } = migration("artifact_items_stored_short_ids_clear");
  const spent = sql.replace("> interval '10 seconds'", "> interval '-1 second'");
  assert.notEqual(spent, sql);
  const after = await itemsAfter(spent);
  assert.equal(after.get(ITEMS.stored), shortIdOf(ITEMS.stored));
  assert.equal(after.get(ITEMS.leadingZeros), shortIdOf(ITEMS.leadingZeros));
});

test("items: bounded by lock waits, rows and the default transaction timeout", () => {
  const { tag, sql, statements } = migration("artifact_items_stored_short_ids_clear");
  assertBoundedLockTimeout(lockTimeoutOf(statements[0]), `${tag}'s lock timeout`, { maxMs: 2_000 });
  assert.equal(statements[1], "SET LOCAL statement_timeout = '20s';", "a plain error before transaction_timeout ends the connection");
  assert.match(statements[2]!, /LIMIT 10000\s+FOR NO KEY UPDATE SKIP LOCKED/, "held rows are left, foreign key checks aren't blocked");
  assert.ok(statements[2]!.indexOf("EXIT WHEN clock_timestamp()") < statements[2]!.indexOf("UPDATE \"app_artifacts\""), "the time is read before a row is cleared");
  assert.equal(resolveMigrationTransactionTimeout(tag, sql).source, "default", "no longer limit: the release needs no declared long transaction");
});
