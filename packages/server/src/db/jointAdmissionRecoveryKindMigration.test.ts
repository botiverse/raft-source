import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// joint_channel_admissions.kind and joint_admission_recoveries (#wg-rbac:#23):
// part 1 is catalog-only on the existing table (constant default, CHECK NOT
// VALID); part 2 validates the CHECK on its own.
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

test("part 1 adds the column and a NOT VALID CHECK under a 2 s lock wait; part 2 only validates", async () => {
  const part1 = await migration("_joint_admission_recovery_kind");
  assertBoundedLockTimeout(part1[0], "part 1", { maxMs: 2_000 });
  assert.ok(part1.some((s) => s === `ALTER TABLE "joint_channel_admissions" ADD COLUMN "kind" text DEFAULT 'admission' NOT NULL;`));
  assert.ok(part1.some((s) => /ADD CONSTRAINT "joint_channel_admissions_kind_known" CHECK .* NOT VALID;$/.test(s)));
  const part2 = await migration("_joint_admission_recovery_kind_validate");
  assertBoundedLockTimeout(part2[0], "part 2", { maxMs: 2_000 });
  assert.deepEqual(part2.slice(-1), [`ALTER TABLE "joint_channel_admissions" VALIDATE CONSTRAINT "joint_channel_admissions_kind_known";`]);
  assert.ok(part2.slice(1, -1).every((s) => s.startsWith("SET LOCAL ")), "nothing else in part 2");
});

test("existing rows read 'admission' without a rescan; the CHECK binds new rows, then validates; a recovery record goes with its admission", async () => {
  const db = new PGlite();
  const joint = "30000000-0000-4000-8000-000000000001";
  const user = "10000000-0000-4000-8000-000000000001";
  const server = "20000000-0000-4000-8000-000000000001";
  try {
    await db.exec(`CREATE TABLE "joint_channel_admissions" (
      "joint_channel_id" uuid NOT NULL, "user_id" uuid NOT NULL, "server_id" uuid NOT NULL,
      "admitted_by" uuid, "ended_at" timestamptz, "generation" integer DEFAULT 1 NOT NULL,
      "admitted_at" timestamptz DEFAULT now() NOT NULL,
      PRIMARY KEY ("joint_channel_id","user_id","generation","server_id"));
      INSERT INTO "joint_channel_admissions" (joint_channel_id,user_id,server_id) VALUES ('${joint}','${user}','${server}');`);
    const apply = async (steps: string[]) => {
      await db.exec("BEGIN");
      for (const step of steps) await db.exec(step);
      await db.exec("COMMIT");
    };
    const validated = async () => (await db.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname='joint_channel_admissions_kind_known'`)).rows[0]?.convalidated;

    await apply(await migration("_joint_admission_recovery_kind"));
    assert.deepEqual((await db.query(`SELECT kind FROM joint_channel_admissions`)).rows, [{ kind: "admission" }]);
    assert.equal(await validated(), false, "not rescanned under the DDL lock");
    await assert.rejects(db.query(`INSERT INTO joint_channel_admissions (joint_channel_id,user_id,server_id,generation,kind) VALUES ('${joint}','${user}','${server}',2,'legacy')`), /joint_channel_admissions_kind_known/);
    await db.query(`INSERT INTO joint_channel_admissions (joint_channel_id,user_id,server_id,generation,kind) VALUES ('${joint}','${user}','${server}',2,'recovery')`);

    await apply(await migration("_joint_admission_recovery_kind_validate"));
    assert.equal(await validated(), true);

    await assert.rejects(db.query(`INSERT INTO joint_admission_recoveries (joint_channel_id,user_id,generation,server_id,run_id,approval_ref) VALUES ('${joint}','${user}',3,'${server}','r','a')`), /joint_admission_recoveries_admission_fk/);
    await db.query(`INSERT INTO joint_admission_recoveries (joint_channel_id,user_id,generation,server_id,run_id,approval_ref) VALUES ('${joint}','${user}',2,'${server}','r','a')`);
    await db.query(`DELETE FROM joint_channel_admissions WHERE generation=2`);
    assert.deepEqual((await db.query(`SELECT count(*)::int n FROM joint_admission_recoveries`)).rows, [{ n: 0 }]);
  } finally {
    await db.close();
  }
});
