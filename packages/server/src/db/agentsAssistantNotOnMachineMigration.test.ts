import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// agents_assistant_not_on_machine: a personal assistant is never bound to a
// machine. Part 1 adds the CHECK NOT VALID (catalog-only on the hot agents
// table); part 2 only validates it.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(suffix: string): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith(suffix));
  assert.ok(entry, `${suffix} is in the journal`);
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

test("part 1 adds the CHECK NOT VALID under a 2 s lock wait; part 2 only validates", async () => {
  const part1 = await migration("_agents_assistant_not_on_machine");
  assertBoundedLockTimeout(part1[0], "part 1", { maxMs: 2_000 });
  assert.deepEqual(part1.slice(-1), [
    `ALTER TABLE "agents" ADD CONSTRAINT "agents_assistant_not_on_machine" CHECK ("agents"."assistant_owner_user_id" IS NULL OR "agents"."daemon_id" IS NULL) NOT VALID;`,
  ]);
  assert.ok(part1.slice(1, -1).every((s) => s.startsWith("SET LOCAL ")), "nothing else in part 1");
  const part2 = await migration("_agents_assistant_not_on_machine_validate");
  assertBoundedLockTimeout(part2[0], "part 2", { maxMs: 2_000 });
  assert.deepEqual(part2.slice(-1), [`ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_assistant_not_on_machine";`]);
  assert.ok(part2.slice(1, -1).every((s) => s.startsWith("SET LOCAL ")), "nothing else in part 2");
});

test("the CHECK binds new rows without a rescan, then validates; an assistant on a machine is rejected", async () => {
  const db = new PGlite();
  const owner = "10000000-0000-4000-8000-000000000001";
  const machine = "20000000-0000-4000-8000-000000000001";
  const assistant = "30000000-0000-4000-8000-000000000001";
  const agent = "30000000-0000-4000-8000-000000000002";
  try {
    await db.exec(`CREATE TABLE "agents" (
      "id" uuid PRIMARY KEY, "daemon_id" uuid, "assistant_owner_user_id" uuid);
      INSERT INTO "agents" (id, daemon_id, assistant_owner_user_id) VALUES
        ('${assistant}', NULL, '${owner}'), ('${agent}', '${machine}', NULL);`);
    const apply = async (steps: string[]) => {
      await db.exec("BEGIN");
      for (const step of steps) await db.exec(step);
      await db.exec("COMMIT");
    };
    const validated = async () => (await db.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname='agents_assistant_not_on_machine'`)).rows[0]?.convalidated;

    await apply(await migration("_agents_assistant_not_on_machine"));
    assert.equal(await validated(), false, "not rescanned under the DDL lock");
    await assert.rejects(db.query(`UPDATE agents SET daemon_id='${machine}' WHERE id='${assistant}'`), /agents_assistant_not_on_machine/);
    await assert.rejects(db.query(`UPDATE agents SET assistant_owner_user_id='${owner}' WHERE id='${agent}'`), /agents_assistant_not_on_machine/);

    await apply(await migration("_agents_assistant_not_on_machine_validate"));
    assert.equal(await validated(), true);
    await assert.rejects(
      db.query(`INSERT INTO agents (id, daemon_id, assistant_owner_user_id) VALUES ('30000000-0000-4000-8000-000000000003', '${machine}', '${owner}')`),
      /agents_assistant_not_on_machine/,
    );
  } finally {
    await db.close();
  }
});
