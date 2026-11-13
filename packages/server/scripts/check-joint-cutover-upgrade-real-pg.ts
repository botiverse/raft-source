import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.JOINT_MEMBERSHIP_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "a fresh isolated disposable PostgreSQL database is required",
  );
const migrations = fileURLToPath(new URL("../drizzle", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "joint-cutover-upgrade-"));
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  mkdirSync(join(scratch, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  );
  const cutover = journal.entries.findIndex((entry: { tag: string }) =>
    entry.tag.endsWith("_joint_membership_cutover"),
  );
  assert.ok(cutover > 0);
  const earlier = { ...journal, entries: journal.entries.slice(0, cutover) };
  for (const entry of earlier.entries)
    copyFileSync(
      join(migrations, entry.tag + ".sql"),
      join(scratch, entry.tag + ".sql"),
    );
  writeFileSync(join(scratch, "meta/_journal.json"), JSON.stringify(earlier));
  await migrate(drizzle(pool), { migrationsFolder: scratch });
  const current = randomUUID(),
    departed = randomUUID(),
    h = randomUUID(),
    b = randomUUID(),
    canonical = randomUUID(),
    hLocal = randomUUID(),
    bLocal = randomUUID(),
    j = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,name,password_hash) VALUES ($1,$2,'upgrade-current','synthetic'),($3,$4,'upgrade-departed','synthetic')",
    [current, current + "@test.invalid", departed, departed + "@test.invalid"],
  );
  await pool.query(
    "INSERT INTO servers(id,name,slug,owner_id) VALUES ($1,'upgrade H',$2,$3),($4,'upgrade B',$5,$3)",
    [h, h, current, b, b],
  );
  await pool.query(
    "INSERT INTO channels(id,server_id,name,type) VALUES ($1,$2,'upgrade canonical','channel'),($3,$2,'upgrade H local','joint'),($4,$5,'upgrade B local','joint')",
    [canonical, h, hLocal, bLocal, b],
  );
  await pool.query(
    "INSERT INTO joint_channels(id,canonical_channel_id,created_by_server_id,created_by_user_id) VALUES ($1,$2,$3,$4)",
    [j, canonical, h, current],
  );
  await pool.query(
    "INSERT INTO joint_channel_servers(joint_channel_id,server_id,local_channel_id,role) VALUES ($1,$2,$3,'host'),($1,$4,$5,'participant')",
    [j, h, hLocal, b, bLocal],
  );
  await pool.query(
    "INSERT INTO server_members(server_id,user_id,role) VALUES ($1,$2,'owner'),($3,$2,'owner')",
    [h, current, b],
  );
  await pool.query(
    "INSERT INTO joint_channel_members(joint_channel_id,user_id) VALUES ($1,$2)",
    [j, current],
  );
  await pool.query(
    "INSERT INTO joint_channel_admissions(joint_channel_id,user_id,server_id,admitted_by,admitted_at) VALUES ($1,$2,$3,$2,'2020-01-01'),($1,$2,$4,NULL,'2020-01-02'),($1,$5,$3,$2,'2020-01-03')",
    [j, current, h, b, departed],
  );
  const before = (
    await pool.query(
      "SELECT * FROM joint_channel_admissions ORDER BY user_id,server_id",
    )
  ).rows;
  const filenodes = (
    await pool.query(
      "SELECT relname,relfilenode FROM pg_class WHERE relname IN ('joint_channel_members','joint_channel_admissions') ORDER BY relname",
    )
  ).rows;
  await migrate(drizzle(pool), { migrationsFolder: migrations });
  assert.deepEqual(
    (
      await pool.query(
        "SELECT relname,relfilenode FROM pg_class WHERE relname IN ('joint_channel_members','joint_channel_admissions') ORDER BY relname",
      )
    ).rows,
    filenodes,
    "metadata-only additions do not rewrite either existing table",
  );
  const after = (
    await pool.query(
      "SELECT * FROM joint_channel_admissions ORDER BY user_id,server_id",
    )
  ).rows;
  assert.deepEqual(
    after.map(({ generation, ended_at, ...row }) => {
      assert.equal(ended_at === null, row.user_id === current);
      assert.equal(generation, 1);
      return row;
    }),
    before,
  );
  const counters = (
    await pool.query(
      "SELECT principal_kind,principal_id,last_generation FROM joint_membership_generations WHERE joint_channel_id=$1 ORDER BY principal_id",
      [j],
    )
  ).rows;
  assert.equal(counters.length, 2);
  assert.ok(
    counters.every(
      (row) => row.principal_kind === "user" && row.last_generation === 1,
    ),
  );
  assert.equal(
    (
      await pool.query(
        "SELECT generation FROM joint_channel_members WHERE joint_channel_id=$1",
        [j],
      )
    ).rows[0].generation,
    1,
  );
  await pool.query(
    "DELETE FROM joint_channel_members WHERE joint_channel_id=$1",
    [j],
  );
  await pool.query(
    "DELETE FROM joint_channel_admissions WHERE joint_channel_id=$1",
    [j],
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM joint_membership_generations WHERE joint_channel_id=$1",
        [j],
      )
    ).rows[0].n,
    2,
  );
  const next = await pool.query(
    "INSERT INTO joint_membership_generations(joint_channel_id,principal_kind,principal_id,last_generation) VALUES ($1,'user',$2,1) ON CONFLICT(joint_channel_id,principal_kind,principal_id) DO UPDATE SET last_generation=joint_membership_generations.last_generation+1 RETURNING last_generation",
    [j, current],
  );
  assert.equal(next.rows[0].last_generation, 2);
  console.log(
    "PASS actual upgrade: metadata-only generation and source-ending columns, dual-source/current and departed audit rows retain fields at episode 1; counters survive member/audit deletion and allocate episode 2",
  );
} finally {
  await pool.end();
  rmSync(scratch, { recursive: true, force: true });
}
