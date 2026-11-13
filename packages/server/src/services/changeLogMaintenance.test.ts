import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { changeLogDropAllowed, maintainChangeLog, runChangeLogMaintenance } from "./changeLogMaintenance";

const at = (hourUtc: number) => new Date(Date.UTC(2026, 9, 27, hourUtc, 30));

// The migrated test database comes from a template cached across runs (keyed by
// the migrations), so its partitions end 14 days after the day it was built, not
// after today. Bring it up to today first; the window itself follows the
// database's now(), and `at()` only picks the drop window.
async function catchUpToToday() {
  await maintainChangeLog(at(10));
}

test("change_log drops expired partitions only in the 18:00-22:00 UTC window", async ({ db }) => {
  assert.deepEqual([17, 18, 21, 22].map((hour) => changeLogDropAllowed(at(hour))), [false, true, true, false]);
  await catchUpToToday();
  // An expired day (well past the 8-day retention), as an old deploy would have left it.
  await db.execute(sql.raw(`CREATE TABLE public.change_log_p20200101 PARTITION OF public.change_log
    FOR VALUES FROM ('2020-01-01 00:00:00+00') TO ('2020-01-02 00:00:00+00')`));

  const outside = await maintainChangeLog(at(10));
  assert.equal(outside.ran, true);
  assert.deepEqual(outside.dropped, [], "outside the low window nothing is detached");
  assert.deepEqual(outside.created, [], "the window already exists, so nothing is created");

  // A template older than the retention also has expired days of its own; only
  // the one made here is asserted.
  const inside = await maintainChangeLog(at(19));
  assert.ok(inside.dropped.includes("change_log_p20200101"), inside.dropped.join(","));
  assert.equal((await db.execute(sql`SELECT to_regclass('public.change_log_p20200101') AS t`)).rows[0]!.t, null, "detached and dropped");
});

test("change_log creates a missing day by ATTACH, keeps the default partition and reports rows stuck in it", async ({ db }) => {
  await catchUpToToday();
  const lastDay = String((await db.execute(sql`
    SELECT max(c.relname) AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.change_log'::regclass AND c.relname ~ '^change_log_p[0-9]{8}$'`)).rows[0]!.name);
  await db.execute(sql.raw(`DROP TABLE public.${lastDay}`));
  const recreated = await maintainChangeLog(at(10));
  assert.deepEqual(recreated.created, [lastDay]);
  const [check] = (await db.execute(sql`
    SELECT count(*) AS n FROM pg_constraint WHERE conrelid = ${`public.${lastDay}`}::regclass AND conname LIKE '%_range'`)).rows;
  assert.equal(Number(check!.n), 0, "the temporary range CHECK used for the attach is removed");
  assert.ok((await db.execute(sql`SELECT to_regclass('public.change_log_default') AS t`)).rows[0]!.t, "the default partition stays");

  // A row dated past the window has no partition: it lands in the default one,
  // which maintenance reports instead of silently keeping forever.
  await db.execute(sql`INSERT INTO change_log (created_at, scope_kind, scope_id, entity, entity_id, op)
    VALUES (now() + interval '40 days', 'server', gen_random_uuid(), 'server', 'x', 'reset')`);
  const errors: string[] = [];
  const reported = await runChangeLogMaintenance({ info: () => {}, error: (line: string) => errors.push(line) }, at(10));
  assert.equal(reported.defaultRows, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /change_log_default holds rows \(1\)/);
});
