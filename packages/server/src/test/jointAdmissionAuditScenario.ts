import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

/** Apply the actual migrations, not a second hand-written version of the new
 * constraints. Minimal parent tables isolate the membership/audit lifetime. */
export async function jointAdmissionAuditScenario() {
  const drizzle = new URL("../../drizzle/", import.meta.url);
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", drizzle), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const migration = async (suffix: string) => {
    const entry = journal.entries.find(({ tag }) => tag.endsWith(suffix));
    assert.ok(entry, `missing migration ${suffix}`);
    return readFile(new URL(`${entry.tag}.sql`, drizzle), "utf8");
  };
  const db = await PGlite.create();
  const user = "10000000-0000-4000-8000-000000000001";
  const actor = "10000000-0000-4000-8000-000000000002";
  const server = "20000000-0000-4000-8000-000000000001";
  const joint = "30000000-0000-4000-8000-000000000001";
  const missing = "40000000-0000-4000-8000-000000000001";
  try {
    await db.exec(`CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE servers (id uuid PRIMARY KEY);
      CREATE TABLE joint_channels (id uuid PRIMARY KEY);
      CREATE TABLE joint_channel_servers (joint_channel_id uuid, server_id uuid,
        PRIMARY KEY (joint_channel_id, server_id));`);
    await db.exec(await migration("_joint_human_membership"));
    await db.query("INSERT INTO users VALUES ($1), ($2)", [user, actor]);
    await db.query("INSERT INTO servers VALUES ($1)", [server]);
    await db.query("INSERT INTO joint_channels VALUES ($1)", [joint]);
    await db.query("INSERT INTO joint_channel_servers VALUES ($1, $2)", [joint, server]);
    const seed = async () => {
      await db.query("INSERT INTO joint_channel_members (joint_channel_id, user_id) VALUES ($1,$2)", [joint, user]);
      await db.query(`INSERT INTO joint_channel_admissions
        (joint_channel_id,user_id,server_id,admitted_by,admitted_at)
        VALUES ($1,$2,$3,$4,'2026-01-01T00:00:00Z')`, [joint, user, server, actor]);
    };
    const audit = async () => (await db.query<{
      joint_channel_id: string; user_id: string; server_id: string; admitted_by: string | null; admitted_at: Date;
    }>("SELECT * FROM joint_channel_admissions")).rows;
    await seed();
    // Before the change the actual P1 FK erases the record on member removal.
    await db.query("DELETE FROM joint_channel_members WHERE user_id=$1", [user]);
    assert.equal((await audit()).length, 0, "pre-migration regression is present");
    await seed();
    const before = await audit();
    const upgrade = await migration("_joint_admission_audit");
    await db.transaction(async tx => { await tx.exec(upgrade); });
    assert.deepEqual(await audit(), before, "upgrade does not rewrite existing evidence");
    await db.query("DELETE FROM joint_channel_members WHERE user_id=$1", [user]);
    assert.deepEqual(await audit(), before, "membership removal retains every audit field");
    await db.query("DELETE FROM joint_channel_servers WHERE server_id=$1", [server]);
    assert.deepEqual(await audit(), before, "disconnect/projection retirement retains evidence");
    for (const [j, u, s] of [[missing, user, server], [joint, missing, server], [joint, user, missing]]) {
      await assert.rejects(db.query(`INSERT INTO joint_channel_admissions
        (joint_channel_id,user_id,server_id) VALUES ($1,$2,$3)`, [j, u, s]),
      (error: Error & { code?: string }) => error.code === "23503", "real entity references remain enforced");
    }
    await db.query("DELETE FROM users WHERE id=$1", [actor]);
    const afterActor = await audit();
    assert.equal(afterActor.length, 1);
    assert.equal(afterActor[0]!.admitted_by, null,
      "deleting the admitting actor still anonymizes attribution");
    await db.query("DELETE FROM users WHERE id=$1", [user]);
    assert.equal((await audit()).length, 0, "actual person deletion still retires their records");
  } finally {
    await db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await jointAdmissionAuditScenario();
  console.log("PASS: actual audit migration preserves evidence across member/projection removal; entity integrity retained");
}
