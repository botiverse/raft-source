import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { Database } from "../../db/index";
import { closeTestDatabase, discardParkedTestDatabase, openCaseDatabase, openTestDatabase, openTestPglite } from "./database";
import { enterIntegrationCase, IntegrationLifecycle } from "./lifecycle";
import { reclaimDatabase, readReuseBaseline, REUSE_CHECK_ENV, REUSE_ENV, REUSE_OPT_OUT, reuseOptedOut, selfCheck, type ReuseBaseline, type ReuseCounts } from "./reuseProbe";
import { createSeed } from "./seed";

// One test database per file (#triage:#516). The first half reclaims a fresh database after one
// kind of leftover each and checks the verdict; the self-check's own teeth are the negative
// controls. The second half runs consecutive cases the way dbTest does (openCaseDatabase) and
// checks what the next case gets.

const measure = <T>(_phase: string, work: () => Promise<T>) => work();
const task = `INSERT INTO durable_tasks (kind, payload_version, payload, state, attempts, max_attempts, lease_until)
  VALUES ('probe', 1, '{}', 'open', 1, 1, now())`;
const user = `INSERT INTO users (id, email, name, password_hash) VALUES (gen_random_uuid(), 'probe@example.com', 'Probe', 'x')`;
// change_log.seq takes its default from change_log_seq_seq, a sequence no OWNED BY ties to the table (0450).
const changeLog = `INSERT INTO change_log (scope_kind, scope_id, entity, entity_id, op) VALUES ('server', gen_random_uuid(), 'probe', 'probe', 'upsert')`;
const touchFlag = "UPDATE feature_flags SET updated_at = now() WHERE ctid = (SELECT ctid FROM feature_flags LIMIT 1)";

async function withFreshDatabase<T>(work: (client: PGlite) => Promise<T>): Promise<T> {
  await openTestDatabase();
  try {
    const client = openTestPglite();
    assert.ok(client, "an in-memory test database exposes its PGlite");
    return await work(client);
  } finally {
    await closeTestDatabase();
  }
}

let baseline: ReuseBaseline;
beforeAll(async () => {
  // From a restored database, as every case gets: without a template file the first open migrates
  // in place, and its sequences differ from any restore's (PostgreSQL logs them ahead in steps of 32).
  await withFreshDatabase(async () => {});
  baseline = await withFreshDatabase(readReuseBaseline);
  assert.ok(baseline.seeded.has("feature_flags"), "the template seeds feature flags");
});

function reclaim(client: PGlite, options: { caseFailed?: boolean; selfCheck?: boolean; baseline?: ReuseBaseline } = {}) {
  return reclaimDatabase(client, options.baseline ?? baseline, {
    caseFailed: options.caseFailed ?? false, catalogMark: baseline.catalogMark, selfCheck: options.selfCheck ?? true, measure,
  });
}

async function reclaimAfter(statements: string[], caseFailed = false): Promise<{ counts: ReuseCounts; clean: boolean | null }> {
  return withFreshDatabase(async (client) => {
    for (const statement of statements) await client.exec(statement).catch(() => {});
    const { counts, catalogMark } = await reclaim(client, { caseFailed });
    assert.equal(catalogMark !== null, counts.reusable === 1, "a database is kept exactly when it is reusable");
    return { counts, clean: counts.reusable ? await selfCheck(client, baseline) : null };
  });
}

const reusable: Array<[string, string[], Partial<ReuseCounts>]> = [
  ["an untouched database", [], { writtenTables: 0, seededRestored: 0 }],
  ["a written table", [task], { writtenTables: 1, seededRestored: 0 }],
  ["a write rolled back (its pages remain)", ["BEGIN", task, "ROLLBACK"], { writtenTables: 1 }],
  ["a referenced table, its CASCADE reaching a seeded table", [user], { seededRestored: 1 }],
  ["a changed seeded row", [touchFlag], { writtenTables: 0, seededRestored: 1 }],
  ["a seeded row its trigger guards, deleted", ["DELETE FROM read_cursor_widen_phase"], { seededRestored: 1 }],
  ["a change_log row (its sequence is a column default's, not OWNED BY)", [changeLog], {}],
  ["a sequence value a failed insert used", [task.replace("'open'", "'not-a-state'")], { writtenTables: 0 }],
  ["a table created and dropped again", ["CREATE TABLE reuse_probe_gone (id int)", "DROP TABLE reuse_probe_gone"], {}],
  ["LISTEN then UNLISTEN", ["LISTEN reuse_probe", "UNLISTEN reuse_probe"], {}],
  ["SET LOCAL and an xact advisory lock, committed", ["BEGIN", "SET LOCAL statement_timeout = 1234", "SELECT pg_advisory_xact_lock(42)", "COMMIT"], {}],
  // Left in the session; DISCARD ALL resets them, and the count says what it reset.
  ["a session setting", ["SET statement_timeout = 1234"], { "discarded.sessionSettings": 1, "setting.statement_timeout": 1 }],
  ["a transaction's isolation level and access mode (labelled `session` for good)",
    ["BEGIN", "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", "SET TRANSACTION READ ONLY", "COMMIT"],
    { "setting.transaction_isolation": 1, "setting.transaction_read_only": 1, "discarded.sessionSettings": undefined }],
  ["a LISTEN left open", ["LISTEN reuse_probe"], { "discarded.listening": 1 }],
  ["a named prepared statement", ["PREPARE reuse_probe AS SELECT 1"], { "discarded.preparedStatements": 1 }],
  ["a WITH HOLD cursor", ["BEGIN", "DECLARE reuse_probe CURSOR WITH HOLD FOR SELECT 1", "COMMIT"], { "discarded.cursors": 1 }],
  ["a session advisory lock", ["SELECT pg_advisory_lock(42)"], { "discarded.advisoryLocks": 1 }],
];

for (const [name, statements, expected] of reusable) {
  test(`reusable after ${name}, and clean afterwards`, async () => {
    const { counts, clean } = await reclaimAfter(statements);
    assert.equal(counts.reusable, 1, JSON.stringify(counts));
    assert.equal(clean, true);
    for (const [key, value] of Object.entries(expected)) assert.equal(counts[key], value, `${key}: ${JSON.stringify(counts)}`);
  });
}

const dropped: Array<[string, string[], string]> = [
  ["a failed case", [], "caseFailed"],
  ["an open transaction", ["BEGIN", "SELECT 1"], "openTransaction"],
  ["an aborted transaction", ["BEGIN", "SELECT 1/0"], "abortedTransaction"],
  ["a new table", ["CREATE TABLE reuse_probe_left (id int)"], "catalog"],
  ["the case's own TRUNCATE", ["TRUNCATE durable_tasks"], "catalog"],
  ["a new role", ["CREATE ROLE reuse_probe_role NOLOGIN"], "catalog"],
  ["a comment", ["COMMENT ON TABLE users IS 'reuse probe'"], "catalog"],
  ["a temp table", ["CREATE TEMP TABLE reuse_probe_temp (id int)"], "tempTables"],
];

for (const [name, statements, reason] of dropped) {
  test(`not reusable after ${name}`, async () => {
    const { counts } = await reclaimAfter(statements, reason === "caseFailed");
    assert.equal(counts[`drop.${reason}`], 1, JSON.stringify(counts));
    assert.equal(counts.reusable, undefined);
    assert.equal(counts.probeError, undefined);
  });
}

test("not reusable after a sequence no table owns moved, and the count names it", async () => {
  assert.ok(baseline.sequenceOwners.has("public.change_log_seq_seq"), "a sequence a column default calls counts as that table's");
  const unowned = [...baseline.sequences.keys()].find((name) => !baseline.sequenceOwners.has(name));
  assert.ok(unowned, "the template has a sequence no table owns");
  const { counts } = await reclaimAfter([`SELECT nextval('${unowned}')`]);
  assert.equal(counts["drop.sequence"], 1, JSON.stringify(counts));
  assert.equal(counts[`sequence.${unowned}`], 1, JSON.stringify(counts));
  assert.equal(counts.reusable, undefined);
});

test("the self-check fails a database that was not cleared (negative controls)", async () => {
  await withFreshDatabase(async (client) => {
    assert.equal(await selfCheck(client, baseline), true, "a fresh database passes");
    await client.exec(task);
    assert.equal(await selfCheck(client, baseline), false, "a written table fails it");
  });
  await withFreshDatabase(async (client) => {
    await client.exec(touchFlag);
    assert.equal(await selfCheck(client, baseline), false, "a changed seeded row fails it");
  });
  await withFreshDatabase(async (client) => {
    await client.exec("SELECT nextval(pg_get_serial_sequence('durable_tasks', 'id'))");
    assert.equal(await selfCheck(client, baseline), false, "a moved sequence fails it");
  });
});

test("a self-check failure discards the database and is counted, without throwing; RAFT_TEST_DB_REUSE_CHECK=0 skips it", async () => {
  // A baseline the clean can't reach: one sequence more than the database has.
  const unreachable = { ...baseline, sequences: new Map([...baseline.sequences, ["public.reuse_probe_missing", "1"]]) };
  await withFreshDatabase(async (client) => {
    const checked = await reclaim(client, { baseline: unreachable });
    assert.deepEqual([checked.counts.selfCheckFailed, checked.counts.reusable, checked.catalogMark], [1, undefined, null], JSON.stringify(checked.counts));
    const unchecked = await reclaim(client, { baseline: unreachable, selfCheck: false });
    assert.equal(unchecked.counts.reusable, 1, JSON.stringify(unchecked.counts));
    assert.equal(unchecked.counts.selfCheckFailed, undefined);
  });
});

// ---- Consecutive cases, as dbTest runs them (openCaseDatabase) ----

interface CaseResult<T> { counts: ReuseCounts; client: PGlite | null; value: T; phases: Record<string, number>; error?: unknown }

/** One case: its database from openCaseDatabase, closed by its lifecycle; a throw fails it, as under Vitest. */
async function runCase<T>(work: (db: Database, client: PGlite) => Promise<T>, options: { optedOut?: boolean } = {}): Promise<CaseResult<T | undefined>> {
  const lifecycle = new IntegrationLifecycle();
  const leave = enterIntegrationCase(lifecycle);
  let failed = false;
  let counts: ReuseCounts = {};
  let client: PGlite | null = null;
  let value: T | undefined;
  let error: unknown;
  try {
    const db = await openCaseDatabase({
      optedOut: options.optedOut,
      measure: (phase, run) => lifecycle.measure(phase, run),
      caseFailed: () => failed,
      closedByCase: () => !lifecycle.closing,
      report: (reported) => { counts = reported; },
    });
    client = openTestPglite();
    assert.ok(client);
    try {
      value = await work(db, client);
    } catch (thrown) {
      failed = true;
      error = thrown;
    }
  } finally {
    await lifecycle.close();
    leave();
  }
  return { counts, client, value, phases: lifecycle.timings, ...(failed ? { error } : {}) };
}

/** Starts a file: no database left by an earlier test. */
async function newFile(): Promise<void> {
  await discardParkedTestDatabase();
}

/** What a case can see of the data: every table's row count, every sequence, every seeded table's rows. */
async function observe(client: PGlite) {
  const tables = (await client.query<{ name: string }>(`
    SELECT c.oid::regclass::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 1`)).rows;
  const counts = (await client.query(tables.map(({ name }) => `SELECT '${name}' AS name, count(*)::int AS rows FROM ${name}`).join(" UNION ALL "))).rows;
  const sequences = (await client.query("SELECT schemaname, sequencename, last_value::text FROM pg_sequences ORDER BY 1, 2")).rows;
  const seeded: Record<string, unknown> = {};
  for (const name of baseline.seeded.keys()) {
    seeded[name] = (await client.query(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS rows FROM ${name} t`)).rows[0];
  }
  return { counts, sequences, seeded };
}

/** A case that writes widely: seeded users, server, channel, message, a task, a change_log row, a changed flag. */
async function writeWidely(db: Database, client: PGlite) {
  const seed = createSeed(db);
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  await seed.message({ channel, author: owner, content: "reuse probe" });
  await client.exec(touchFlag);
  await client.exec(changeLog);
  return (await client.query(`${task} RETURNING id`)).rows;
}

test("a reused database is indistinguishable from a fresh one for the next case, case after case", async () => {
  await newFile();
  const first = await runCase(async (db, client) => ({ seen: await observe(client), ids: await writeWidely(db, client) }));
  assert.equal(first.error, undefined);
  assert.equal(first.counts.restored, 1, JSON.stringify(first.counts));
  assert.equal(first.counts.reusable, 1, JSON.stringify(first.counts));
  for (const round of [2, 3]) {
    const next = await runCase(async (db, client) => ({ seen: await observe(client), ids: await writeWidely(db, client) }));
    assert.equal(next.error, undefined);
    assert.deepEqual(next.value?.seen, first.value?.seen, `case ${round} sees what a fresh database shows`);
    assert.deepEqual(next.value?.ids, first.value?.ids, `case ${round} gets the ids a fresh database gives`);
    assert.equal(next.counts.reused, 1, `case ${round} got the previous case's database: ${JSON.stringify(next.counts)}`);
    assert.equal(next.client, first.client, "the same connection");
    assert.equal(next.counts.reusable, 1, JSON.stringify(next.counts));
  }
  assert.ok(first.counts.writtenTables! > 3, `the case wrote widely: ${JSON.stringify(first.counts)}`);
  await newFile();
});

test("session settings a case leaves do not reach the next case (DISCARD ALL)", async () => {
  await newFile();
  const defaults = "SELECT current_setting('statement_timeout') AS timeout, current_setting('application_name') AS application, current_setting('search_path') AS path, current_setting('default_transaction_isolation') AS isolation";
  const fresh = await runCase(async (db, client) => {
    const shown = (await client.query(defaults)).rows;
    await db.transaction(async (tx) => { await tx.execute(sql`SELECT 1`); }, { isolationLevel: "serializable", accessMode: "read only" });
    await client.exec("SET statement_timeout = 1234; SET application_name = 'previous-case'; SET search_path = pg_catalog, public");
    await client.exec("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await client.exec("PREPARE reuse_probe AS SELECT 1; SELECT pg_advisory_lock(42); LISTEN reuse_probe");
    return shown;
  });
  assert.equal(fresh.counts.reusable, 1, JSON.stringify(fresh.counts));
  for (const key of ["discarded.sessionSettings", "discarded.preparedStatements", "discarded.advisoryLocks", "discarded.listening"]) {
    assert.equal(fresh.counts[key], 1, `${key}: ${JSON.stringify(fresh.counts)}`);
  }
  const next = await runCase(async (_db, client) => ({
    shown: (await client.query(defaults)).rows,
    inTransaction: await client.transaction(async (tx) => (await tx.query("SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS readOnly")).rows),
    left: (await client.query("SELECT (SELECT count(*)::int FROM pg_prepared_statements) AS prepared, (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory') AS advisory, (SELECT count(*)::int FROM pg_listening_channels()) AS listening")).rows,
  }));
  assert.equal(next.counts.reused, 1, JSON.stringify(next.counts));
  assert.deepEqual(next.value?.shown, fresh.value);
  assert.deepEqual(next.value?.inTransaction, [{ isolation: "read committed", readonly: "off" }]);
  assert.deepEqual(next.value?.left, [{ prepared: 0, advisory: 0, listening: 0 }]);
  await newFile();
});

test("a failed case, a temp table or DDL gives the next case a fresh database", async () => {
  const leftovers: Array<[string, (client: PGlite) => Promise<void>, string]> = [
    ["a failed case", async (client) => { await client.exec(task); throw new Error("deliberate failure"); }, "caseFailed"],
    ["a temp table", async (client) => { await client.exec("CREATE TEMP TABLE reuse_probe_temp (id int)"); }, "tempTables"],
    ["a new table", async (client) => { await client.exec("CREATE TABLE reuse_probe_left (id int)"); }, "catalog"],
    ["an open transaction", async (client) => { await client.exec("BEGIN; SELECT 1"); }, "openTransaction"],
  ];
  for (const [name, leave, reason] of leftovers) {
    await newFile();
    const before = await runCase(async (_db, client) => { await leave(client); });
    assert.equal(before.counts[`drop.${reason}`], 1, `${name}: ${JSON.stringify(before.counts)}`);
    const next = await runCase(async (_db, client) => (await client.query(`
      SELECT (SELECT count(*)::int FROM durable_tasks) AS tasks, to_regclass('reuse_probe_temp') IS NULL AS no_temp,
        to_regclass('reuse_probe_left') IS NULL AS no_table`)).rows);
    assert.equal(next.counts.restored, 1, `${name}: ${JSON.stringify(next.counts)}`);
    assert.notEqual(next.client, before.client, `${name}: a new connection`);
    assert.deepEqual(next.value, [{ tasks: 0, no_temp: true, no_table: true }], name);
  }
  await newFile();
});

test("a case that closes its database itself, or opens one explicitly, shares nothing", async () => {
  await newFile();
  const closer = await runCase(async () => { await closeTestDatabase(); });
  assert.equal(closer.counts["drop.closedByCase"], 1, JSON.stringify(closer.counts));
  const afterCloser = await runCase(async () => {});
  assert.equal(afterCloser.counts.restored, 1, JSON.stringify(afterCloser.counts));
  assert.equal(afterCloser.counts.reusable, 1, "and that one is kept");
  // An explicit open (suite hooks, loops, Playwright) discards the kept database and restores its own.
  const explicit = await withFreshDatabase(async (client) => client);
  assert.notEqual(explicit, afterCloser.client);
  const afterExplicit = await runCase(async () => {});
  assert.equal(afterExplicit.counts.restored, 1, JSON.stringify(afterExplicit.counts));
  await newFile();
});

test("RAFT_TEST_DB_REUSE=0 restores every case; RAFT_TEST_DB_REUSE_CHECK=0 reuses without the self-check", async () => {
  const saved = { reuse: process.env[REUSE_ENV], check: process.env[REUSE_CHECK_ENV] };
  try {
    await newFile();
    process.env[REUSE_ENV] = "0";
    const off = [await runCase(async (_db, client) => { await client.exec(task); }), await runCase(async () => {})];
    assert.notEqual(off[1]!.client, off[0]!.client, "a new database for every case");
    assert.deepEqual(off.map((result) => result.counts), [{}, {}], "nothing reclaimed, nothing counted");
    assert.deepEqual(off.map((result) => result.phases.reuseCheck), [undefined, undefined]);

    delete process.env[REUSE_ENV];
    process.env[REUSE_CHECK_ENV] = "0";
    const unchecked = [await runCase(async (_db, client) => { await client.exec(task); }), await runCase(async () => {})];
    assert.equal(unchecked[1]!.client, unchecked[0]!.client, "reused");
    assert.equal(unchecked[0]!.counts.reusable, 1, JSON.stringify(unchecked[0]!.counts));
    assert.equal(unchecked[0]!.phases.reuseSelfCheck, undefined, "no self-check");

    delete process.env[REUSE_CHECK_ENV];
    const checked = await runCase(async (_db, client) => { await client.exec(task); });
    assert.equal(checked.counts.reused, 1, JSON.stringify(checked.counts));
    assert.ok(checked.phases.reuseSelfCheck !== undefined, "the self-check runs by default");
  } finally {
    for (const [name, value] of [[REUSE_ENV, saved.reuse], [REUSE_CHECK_ENV, saved.check]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await newFile();
  }
});

test("a file on REUSE_OPT_OUT restores every case and reclaims nothing; each entry is a real file with its reason", async () => {
  for (const [file, reason] of Object.entries(REUSE_OPT_OUT)) {
    assert.ok(file.endsWith(".test.ts") && existsSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url))), `${file}: a test file, path from packages/server`);
    assert.ok(reason.trim(), `${file}: says why`);
  }
  const list = { "src/a.test.ts": "why" };
  assert.deepEqual([reuseOptedOut("src/a.test.ts", list), reuseOptedOut("src/b.test.ts", list), reuseOptedOut(undefined, list), reuseOptedOut("toString", list)],
    [true, false, false, false]);
  try {
    await newFile();
    const out = [
      await runCase(async (_db, client) => { await client.exec(task); }, { optedOut: true }),
      await runCase(async () => {}, { optedOut: true }),
    ];
    assert.notEqual(out[1]!.client, out[0]!.client, "a new database for every case");
    assert.deepEqual(out.map((result) => result.counts), [{ restored: 1, optedOut: 1 }, { restored: 1, optedOut: 1 }]);
    assert.deepEqual(out.map((result) => result.phases.reuseCheck), [undefined, undefined], "nothing reclaimed");
    const next = await runCase(async () => {});
    assert.equal(next.counts.restored, 1, `an opted-out case leaves no database behind: ${JSON.stringify(next.counts)}`);
  } finally {
    await newFile();
  }
});
