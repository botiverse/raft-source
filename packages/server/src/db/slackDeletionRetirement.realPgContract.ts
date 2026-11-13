/** Real PostgreSQL exercise of the shipped SQL, commit-aware deploy logging and lock interleavings. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, test } from "vitest";

const adminUrl = process.env.SLACK_VERIFIED_INGRESS_REAL_PG_URL;
const required = process.env.SLACK_VERIFIED_INGRESS_REAL_PG_REQUIRED === "1";
const serverDir = fileURLToPath(new URL("../..", import.meta.url));
const migrationsDir = path.join(serverDir, "drizzle");
const journal = JSON.parse(readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
const tag = journal.entries.find((entry) => entry.tag.endsWith("_slack_deletion_capture_retirement"))?.tag;
assert.ok(tag);
const retirementSql = readFileSync(path.join(migrationsDir, `${tag}.sql`), "utf8");
const aggregateSql = readFileSync(path.join(serverDir, "scripts/ops/slack-deletion-retirement/counts.sql"), "utf8");
const databases: string[] = [];
const folders: string[] = [];
const unexpectedClientErrors: Error[] = [];

function testClient(connectionString: string) {
  const client = new pg.Client({ connectionString });
  // Keep an asynchronous connection failure from crashing the runner, but
  // still fail the suite after all clients and temporary databases are closed.
  client.on("error", (error: Error) => { unexpectedClientErrors.push(error); });
  return client;
}

afterAll(async () => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  if (adminUrl) {
    const admin = testClient(adminUrl);
    await admin.connect();
    try {
      for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally { await admin.end(); }
  }
  assert.deepEqual(unexpectedClientErrors, [], "unexpected PostgreSQL client errors");
});

async function fixture() {
  assert.ok(adminUrl, "SLACK_VERIFIED_INGRESS_REAL_PG_URL is required");
  const name = `slack_retire_${randomUUID().replaceAll("-", "")}`;
  const admin = testClient(adminUrl);
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${name}"`); databases.push(name); } finally { await admin.end(); }
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  const client = testClient(url.toString());
  await client.connect();
  await client.query(`
    CREATE TABLE external_app_registrations (id uuid PRIMARY KEY, provider text NOT NULL, environment text NOT NULL, provider_app_id text NOT NULL);
    CREATE TABLE external_app_installs (id uuid PRIMARY KEY, registration_id uuid NOT NULL, provider_app_id text NOT NULL, provider_authority_id text NOT NULL);
    CREATE TABLE external_channel_bindings (id uuid PRIMARY KEY, registration_id uuid NOT NULL, install_id uuid NOT NULL,
      provider_conversation_id text NOT NULL, state text NOT NULL, state_reason text, binding_epoch integer NOT NULL, updated_at timestamptz NOT NULL);
  `);
  // The evidence table, constraints and legacy trigger are the actual released migration.
  await client.query("BEGIN");
  await client.query(readFileSync(path.join(migrationsDir, "0486_slack_channel_deletion_evidence.sql"), "utf8"));
  await client.query("COMMIT");
  const reg = randomUUID(), install = randomUUID();
  await client.query("INSERT INTO external_app_registrations VALUES ($1, 'slack', 'test', 'A_TEST')", [reg]);
  await client.query("INSERT INTO external_app_installs VALUES ($1, $2, 'A_TEST', 'T_TEST')", [install, reg]);
  async function binding(channel: string, state = "paused", reason: string | null = "provider_channel_deleted") {
    const id = randomUUID();
    await client.query("INSERT INTO external_channel_bindings VALUES ($1,$2,$3,$4,$5,$6,1,now())", [id, reg, install, channel, state, reason]);
    return id;
  }
  return { url: url.toString(), client, reg, install, binding };
}

function migrationFolder(sql: string) {
  const folder = mkdtempSync(path.join(os.tmpdir(), "slack-retirement-"));
  folders.push(folder); mkdirSync(path.join(folder, "meta"));
  writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql",
    entries: [{ idx: 0, version: "7", when: 1800000000000, tag, breakpoints: true }] }));
  writeFileSync(path.join(folder, `${tag}.sql`), sql);
  return folder;
}

function runDeploy(url: string, sql: string) {
  return spawnSync(process.execPath, ["--import", "@oxc-node/core/register", "scripts/migrate-deploy.ts"], {
    cwd: serverDir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, DATABASE_URL: url, MIGRATIONS_FOLDER: migrationFolder(sql),
      SERVER_MIGRATION_PHASE_CONTRACT_REQUIRED: "true", SERVER_MIGRATION_EXPECTED_LOCK_TIMEOUT_MS: "5000",
      SERVER_MIGRATION_ADVISORY_LOCK_NAMESPACE: "1907", SERVER_MIGRATION_ADVISORY_LOCK_KEY: "245" },
  });
}

async function triggerExists(c: pg.Client) {
  const result = await c.query("SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'capture_legacy_slack_channel_deletion' AND NOT tgisinternal) AS present");
  return result.rows[0].present as boolean;
}

test("retirement preserves facts, aborts bad identities, and logs counts only after commit", { skip: !(adminUrl || required), timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    const missing = await f.binding("C_MISSING");
    const missingAgain = await f.binding("C_MISSING"); // same scope: only one fact is needed
    await f.binding("C_LEGACY");
    await f.binding("C_SIGNED");
    await f.binding("C_ARCHIVED", "paused", "provider_channel_archived");
    await f.client.query("DELETE FROM slack_channel_deletions WHERE provider_conversation_id IN ('C_MISSING', 'C_SIGNED')");
    await f.client.query(`INSERT INTO slack_channel_deletions
      (id, registration_id, environment, provider_app_id, provider_authority_id, provider_conversation_id,
       source_install_id, source_kind, source_key, provider_event_id, provider_event_type, signing_secret_revision, payload_sha256, observed_at)
      VALUES ($1,$2,'test','A_TEST','T_TEST','C_SIGNED',$3,'signed_event','event:E_SIGNED','E_SIGNED','channel_deleted',2,$4,now())`,
      [randomUUID(), f.reg, f.install, "a".repeat(64)]);
    const before = await f.client.query("SELECT * FROM slack_channel_deletions ORDER BY source_key");
    const otherReg = randomUUID(), badInstall = randomUUID();
    await f.client.query("INSERT INTO external_app_registrations VALUES ($1,'slack','test','A_OTHER')", [otherReg]);
    await f.client.query("INSERT INTO external_app_installs VALUES ($1,$2,'A_OTHER','T_OTHER')", [badInstall, otherReg]);
    const bad = randomUUID();
    await f.client.query("INSERT INTO external_channel_bindings VALUES ($1,$2,$3,'C_BAD','paused','provider_channel_deleted',1,now())", [bad, f.reg, badInstall]);
    assert.deepEqual((await f.client.query(aggregateSql)).rows[0],
      { invalid_identities: "1", needs_fact: "2", already_covered: "2" });
    const failedIdentity = runDeploy(f.url, retirementSql);
    assert.notEqual(failedIdentity.status, 0);
    assert.match(failedIdentity.stderr, /invalid binding identities=1/);
    assert.doesNotMatch(failedIdentity.stdout, /MIGRATION_REPORT/);
    assert.equal(await triggerExists(f.client), true);
    assert.deepEqual((await f.client.query("SELECT * FROM slack_channel_deletions ORDER BY source_key")).rows, before.rows);
    await f.client.query("DELETE FROM external_channel_bindings WHERE id=$1", [bad]);
    assert.deepEqual((await f.client.query(aggregateSql)).rows[0],
      { invalid_identities: "0", needs_fact: "2", already_covered: "2" });

    const failedAfterNotice = runDeploy(f.url, `${retirementSql}\n--> statement-breakpoint\nSELECT 1/0;`);
    assert.notEqual(failedAfterNotice.status, 0);
    assert.doesNotMatch(failedAfterNotice.stdout, /MIGRATION_REPORT/, "rolled-back notices are not reported");
    assert.equal(await triggerExists(f.client), true);
    assert.deepEqual((await f.client.query("SELECT * FROM slack_channel_deletions ORDER BY source_key")).rows, before.rows);

    const success = runDeploy(f.url, `${retirementSql}\n--> statement-breakpoint\nDO $$ BEGIN RAISE NOTICE 'MIGRATION_REPORT migration=other value=private'; END $$;`);
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /\[MIGRATION_REPORT migration=slack_deletion_capture_retirement backfilled_bindings=2 previously_covered_bindings=2 inserted_facts=1\]/);
    assert.doesNotMatch(success.stdout, /value=private/, "non-numeric reports are not forwarded");
    assert.equal(await triggerExists(f.client), false);
    assert.equal((await f.client.query("SELECT to_regprocedure('capture_legacy_slack_channel_deletion()') AS name")).rows[0].name, null);
    const rows = await f.client.query("SELECT * FROM slack_channel_deletions ORDER BY source_key");
    assert.equal(rows.rowCount, 3);
    for (const original of before.rows) assert.deepEqual(rows.rows.find((row) => row.id === original.id), original);
    const backfill = rows.rows.find((row) => row.provider_conversation_id === "C_MISSING");
    assert.ok(backfill); assert.equal(backfill.source_kind, "legacy_binding");
    assert.ok([missing, missingAgain].includes(backfill.source_binding_id));
    assert.equal(backfill.provider_event_id, null); assert.equal(backfill.payload_sha256, null);
    assert.equal(rows.rows.some((row) => row.provider_conversation_id === "C_ARCHIVED"), false);
    assert.deepEqual((await f.client.query(aggregateSql)).rows[0],
      { invalid_identities: "0", needs_fact: "0", already_covered: "4" });
    const again = runDeploy(f.url, retirementSql);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /MIGRATION_REPORT/, "journal prevents reapplying the migration");
    assert.deepEqual((await f.client.query("SELECT * FROM slack_channel_deletions ORDER BY source_key")).rows, rows.rows);
  } finally { await f.client.end(); }
});

test("signed deletion and retirement serialize in both lock orders without losing facts", { skip: !(adminUrl || required), timeout: 60_000 }, async () => {
  const f = await fixture();
  const writer = testClient(f.url);
  const migrator = testClient(f.url);
  const observer = testClient(f.url);
  await writer.connect(); await migrator.connect(); await observer.connect();
  const first = await f.binding("C_FIRST", "active", null);
  const second = await f.binding("C_SECOND", "active", null);
  async function writeSigned(channel: string, binding: string) {
    await writer.query("SELECT id FROM external_app_installs WHERE id=$1 FOR UPDATE", [f.install]);
    await writer.query("SELECT id FROM external_channel_bindings WHERE id=$1 FOR UPDATE", [binding]);
    await writer.query(`INSERT INTO slack_channel_deletions
      (id, registration_id, environment, provider_app_id, provider_authority_id, provider_conversation_id,
       source_install_id, source_kind, source_key, provider_event_id, provider_event_type, signing_secret_revision, payload_sha256, observed_at)
      VALUES ($1,$2,'test','A_TEST','T_TEST',$3,$4,'signed_event',$5,$6,'channel_deleted',1,$7,now())`,
      [randomUUID(), f.reg, channel, f.install, `event:${channel}`, channel, "b".repeat(64)]);
    await writer.query("UPDATE external_channel_bindings SET state='paused', state_reason='provider_channel_deleted' WHERE id=$1", [binding]);
  }
  try {
    await writer.query("BEGIN"); await writeSigned("C_FIRST", first);
    await migrator.query("BEGIN");
    // Capture pid before starting the pending query; pg clients serialize queries.
    const migratorPid = (await migrator.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    const migrating = migrator.query(retirementSql);
    let blocked = false;
    for (let n = 0; n < 200 && !blocked; n += 1) {
      blocked = (await observer.query("SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked", [writerPid, migratorPid])).rows[0].blocked;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "migration waits for a real in-flight writer");
    await writer.query("COMMIT"); await migrating;
    await migrator.query("ROLLBACK"); // repeat the opposite ordering from the same pre-retirement state
    assert.equal(await triggerExists(f.client), true);
    assert.equal((await f.client.query("SELECT count(*)::int n FROM slack_channel_deletions WHERE source_kind='signed_event' AND provider_conversation_id='C_FIRST'")).rows[0].n, 1);

    await migrator.query("BEGIN"); await migrator.query(retirementSql);
    await writer.query("BEGIN");
    const writerPid2 = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    const migratorPid2 = (await migrator.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    const writing = writeSigned("C_SECOND", second);
    blocked = false;
    for (let n = 0; n < 200 && !blocked; n += 1) {
      blocked = (await observer.query("SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked", [migratorPid2, writerPid2])).rows[0].blocked;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "a real writer waits behind retirement's table lock");
    await migrator.query("COMMIT"); await writing; await writer.query("COMMIT");
    assert.equal(await triggerExists(f.client), false);
    const facts = await f.client.query("SELECT provider_conversation_id, source_kind FROM slack_channel_deletions WHERE provider_conversation_id IN ('C_FIRST','C_SECOND') ORDER BY provider_conversation_id, source_kind");
    assert.ok(facts.rows.some((row) => row.provider_conversation_id === "C_FIRST" && row.source_kind === "signed_event"));
    assert.deepEqual(facts.rows.filter((row) => row.provider_conversation_id === "C_SECOND"), [{ provider_conversation_id: "C_SECOND", source_kind: "signed_event" }]);
  } finally {
    await writer.query("ROLLBACK").catch(() => {}); await migrator.query("ROLLBACK").catch(() => {});
    await writer.end(); await migrator.end(); await observer.end(); await f.client.end();
  }
});

test("lock timeout rolls retirement back without changing the trigger or facts", { skip: !(adminUrl || required), timeout: 30_000 }, async () => {
  const f = await fixture();
  const holder = testClient(f.url);
  const migrator = testClient(f.url);
  await holder.connect(); await migrator.connect();
  try {
    await f.binding("C_EXISTING");
    const before = (await f.client.query("SELECT * FROM slack_channel_deletions")).rows;
    await holder.query("BEGIN");
    await holder.query("SELECT count(*) FROM external_channel_bindings"); // AccessShare conflicts with retirement's DDL lock.
    await migrator.query("BEGIN");
    await assert.rejects(migrator.query(retirementSql), (error: unknown) => (error as { code?: string }).code === "55P03");
    await migrator.query("ROLLBACK"); await holder.query("ROLLBACK");
    assert.equal(await triggerExists(f.client), true);
    assert.deepEqual((await f.client.query("SELECT * FROM slack_channel_deletions")).rows, before);
  } finally {
    await holder.query("ROLLBACK").catch(() => {}); await migrator.query("ROLLBACK").catch(() => {});
    await holder.end(); await migrator.end(); await f.client.end();
  }
});
