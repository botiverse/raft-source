import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  BACKFILL_STEPS,
  DEFAULT_BATCH_OPTIONS,
  parseArgs,
  runBackfill,
  verify,
  type BatchOptions,
} from "./backfill-agent-credential-issued-via";

// Migration 0401 (expand: nullable columns, NOT VALID constraints, legacy-writer
// trigger) applied to tables reduced to the columns it and the backfill read,
// then the backfill's batch functions against that database.
const migrationPath = path.resolve(import.meta.dirname, "../drizzle/0401_agent_credentials_issued_via.sql");

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const USER_OWNER = id(0x101);
const USER_ISSUER = id(0x102);
const MACHINE = id(0x201);
const AGENT_HOSTED = "a1b2c3d4-0000-4000-8000-000000000301";
const AGENT_EXTERNAL = "b2c3d4e5-0000-4000-8000-000000000302";
const AGENT_MANAGED = "c3d4e5f6-0000-4000-8000-000000000303";
const AGENT_UNHOSTED = "d4e5f6a7-0000-4000-8000-000000000304";
const AGENT_BOT = "e5f6a7b8-0000-4000-8000-000000000305";
const AGENT_HOSTED_LATE = "f6a7b8c9-0000-4000-8000-000000000306";
const CLIENT = id(0x401);
const INSTALL = id(0x402);

type Expected = { issuedVia: string; createdBy: string | null; machine: string | null };
// Rows that existed before 0401: credential id -> [agent, name, created_by_user_id, expected].
const PRE_EXISTING: Record<string, [string, string | null, string | null, Expected]> = {
  // 1. provision: referenced by the provision row; the creator is cleared.
  [id(0x501)]: [AGENT_HOSTED, "Cloud runtime", USER_OWNER, { issuedVia: "provision", createdBy: null, machine: null }],
  // 2. bootstrap exchange: the token's issuer becomes the credential's.
  [id(0x502)]: [AGENT_EXTERNAL, null, null, { issuedVia: "human", createdBy: USER_ISSUER, machine: null }],
  // 3. direct human mint.
  [id(0x503)]: [AGENT_EXTERNAL, "ci-runner", USER_OWNER, { issuedVia: "human", createdBy: USER_OWNER, machine: null }],
  //    a runner-shaped name does not override a recorded person.
  [id(0x504)]: [AGENT_MANAGED, "runner:claude:c3d4e5f6", USER_OWNER, { issuedVia: "human", createdBy: USER_OWNER, machine: null }],
  // 4. computer: daemon runner name for this agent; the agent's current Machine.
  [id(0x505)]: [AGENT_MANAGED, "runner:claude:c3d4e5f6", null, { issuedVia: "computer", createdBy: null, machine: MACHINE }],
  [id(0x506)]: [AGENT_MANAGED, "runner:gemini-cli:c3d4e5f6", null, { issuedVia: "computer", createdBy: null, machine: MACHINE }],
  //    an agent with no Machine: computer, no machine.
  [id(0x507)]: [AGENT_UNHOSTED, "runner:codex:d4e5f6a7", null, { issuedVia: "computer", createdBy: null, machine: null }],
  //    a runner name for another agent's id, or not the exact shape: unknown.
  [id(0x508)]: [AGENT_MANAGED, "runner:claude:deadbeef", null, { issuedVia: "unknown", createdBy: null, machine: null }],
  [id(0x509)]: [AGENT_MANAGED, "runner:claude:c3d4e5f6:extra", null, { issuedVia: "unknown", createdBy: null, machine: null }],
  [id(0x50a)]: [AGENT_MANAGED, "runner:claude:C3D4E5F6", null, { issuedVia: "unknown", createdBy: null, machine: null }],
  // 5. app: `app-bot:<client id>` on that App's Bot agent.
  [id(0x50b)]: [AGENT_BOT, `app-bot:${CLIENT}`, null, { issuedVia: "app", createdBy: null, machine: null }],
  //    the same name on an agent that is not that App's Bot: unknown.
  [id(0x50c)]: [AGENT_EXTERNAL, `app-bot:${CLIENT}`, null, { issuedVia: "unknown", createdBy: null, machine: null }],
  //    another client's id on the Bot agent: unknown.
  [id(0x50d)]: [AGENT_BOT, `app-bot:${id(0x499)}`, null, { issuedVia: "unknown", createdBy: null, machine: null }],
  // 6. nothing to go on (e.g. a bootstrap exchange that lost its race).
  [id(0x50e)]: [AGENT_EXTERNAL, null, null, { issuedVia: "unknown", createdBy: null, machine: null }],
};

// Rows an older server build inserts after 0401 (rollout window): the trigger
// classifies them at insert time; the provision / bootstrap link comes after.
const ROLLOUT_PROVISION = id(0x5a1); // cloud-runtime mint with its creator -> trigger 'human'
const ROLLOUT_BOOTSTRAP = id(0x5a2); // bootstrap exchange without issuer -> trigger 'unknown'
const ROLLOUT_EXPECTED: Record<string, { trigger: Expected; backfilled: Expected }> = {
  [ROLLOUT_PROVISION]: {
    trigger: { issuedVia: "human", createdBy: USER_OWNER, machine: null },
    backfilled: { issuedVia: "provision", createdBy: null, machine: null },
  },
  [ROLLOUT_BOOTSTRAP]: {
    trigger: { issuedVia: "unknown", createdBy: null, machine: null },
    backfilled: { issuedVia: "human", createdBy: USER_ISSUER, machine: null },
  },
};

const ALL_IDS = [...Object.keys(PRE_EXISTING), ROLLOUT_PROVISION, ROLLOUT_BOOTSTRAP].sort();
const NO_CHANGES = Object.fromEntries(BACKFILL_STEPS.map((step) => [step.name, 0]));
const CHECK_E = "(e) every bootstrap-consumed credential is human, issued by the token's issuer";

// Per step, the rows the first --apply changes.
const EXPECTED_CHANGES = {
  "provision": 2, // 0x501 + rollout 0x5a1
  "human (bootstrap token)": 2, // 0x502 + rollout 0x5a2
  "human": 2,
  "computer": 3,
  "app": 1,
  "unknown": 6,
};

async function setUp(): Promise<PGlite> {
  const client = new PGlite();
  await client.exec(`
    CREATE TABLE "users" ("id" uuid PRIMARY KEY NOT NULL);
    CREATE TABLE "daemons" ("id" uuid PRIMARY KEY NOT NULL);
    CREATE TABLE "agents" (
      "id" uuid PRIMARY KEY NOT NULL,
      "daemon_id" uuid REFERENCES "daemons"("id") ON DELETE SET NULL
    );
    CREATE TABLE "agent_credentials" (
      "id" uuid PRIMARY KEY NOT NULL,
      "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
      "name" text,
      "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
    );
    CREATE TABLE "agent_runtime_provisions" (
      "agent_id" uuid PRIMARY KEY NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
      "credential_id" uuid REFERENCES "agent_credentials"("id") ON DELETE SET NULL
    );
    CREATE TABLE "agent_bootstrap_tokens" (
      "id" uuid PRIMARY KEY NOT NULL,
      "issued_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "consumed_credential_id" uuid REFERENCES "agent_credentials"("id") ON DELETE SET NULL
    );
    CREATE TABLE "oauth_client_installs" ("id" uuid PRIMARY KEY NOT NULL, "client_id" uuid NOT NULL);
    CREATE TABLE "app_bot_bindings" (
      "id" uuid PRIMARY KEY NOT NULL,
      "install_id" uuid NOT NULL REFERENCES "oauth_client_installs"("id") ON DELETE CASCADE,
      "agent_id" uuid NOT NULL REFERENCES "agents"("id")
    );

    INSERT INTO "users" VALUES ('${USER_OWNER}'), ('${USER_ISSUER}');
    INSERT INTO "daemons" VALUES ('${MACHINE}');
    INSERT INTO "agents" VALUES
      ('${AGENT_HOSTED}', NULL),
      ('${AGENT_EXTERNAL}', NULL),
      ('${AGENT_MANAGED}', '${MACHINE}'),
      ('${AGENT_UNHOSTED}', NULL),
      ('${AGENT_BOT}', NULL),
      ('${AGENT_HOSTED_LATE}', NULL);
    INSERT INTO "oauth_client_installs" VALUES ('${INSTALL}', '${CLIENT}');
    INSERT INTO "app_bot_bindings" VALUES ('${id(0x403)}', '${INSTALL}', '${AGENT_BOT}');
  `);
  for (const [credentialId, [agentId, name, createdBy]] of Object.entries(PRE_EXISTING)) {
    await client.query(
      `INSERT INTO "agent_credentials" ("id", "agent_id", "name", "created_by_user_id") VALUES ($1, $2, $3, $4)`,
      [credentialId, agentId, name, createdBy],
    );
  }
  await client.exec(`
    INSERT INTO "agent_runtime_provisions" VALUES ('${AGENT_HOSTED}', '${id(0x501)}');
    INSERT INTO "agent_bootstrap_tokens" VALUES ('${id(0x601)}', '${USER_ISSUER}', '${id(0x502)}');
  `);

  const migration = await readFile(migrationPath, "utf8");
  for (const statement of migration.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
    await client.exec(statement);
  }

  // Rollout window: an older build's inserts (no issued_via), then its links.
  await client.query(
    `INSERT INTO "agent_credentials" ("id", "agent_id", "name", "created_by_user_id") VALUES ($1, $2, 'Cloud runtime', $3)`,
    [ROLLOUT_PROVISION, AGENT_HOSTED_LATE, USER_OWNER],
  );
  await client.query(`INSERT INTO "agent_runtime_provisions" VALUES ($1, $2)`, [AGENT_HOSTED_LATE, ROLLOUT_PROVISION]);
  await client.query(`INSERT INTO "agent_credentials" ("id", "agent_id") VALUES ($1, $2)`, [ROLLOUT_BOOTSTRAP, AGENT_EXTERNAL]);
  await client.query(`INSERT INTO "agent_bootstrap_tokens" VALUES ($1, $2, $3)`, [id(0x602), USER_ISSUER, ROLLOUT_BOOTSTRAP]);
  return client;
}

async function snapshot(client: PGlite): Promise<Record<string, Expected>> {
  const { rows } = await client.query<{ id: string; issued_via: string | null; created_by_user_id: string | null; issued_by_machine_id: string | null }>(
    `SELECT "id", "issued_via", "created_by_user_id", "issued_by_machine_id" FROM "agent_credentials" ORDER BY "id"`,
  );
  return Object.fromEntries(rows.map((row) => [row.id, {
    issuedVia: row.issued_via as string,
    createdBy: row.created_by_user_id,
    machine: row.issued_by_machine_id,
  }]));
}

function quiet(overrides: Partial<BatchOptions> = {}): BatchOptions {
  return { ...DEFAULT_BATCH_OPTIONS, log: () => undefined, ...overrides };
}

test("0401 is expand-only: existing rows stay NULL, older builds' inserts are classified by the trigger", async () => {
  const client = await setUp();
  try {
    const rows = await snapshot(client);
    for (const credentialId of Object.keys(PRE_EXISTING)) {
      assert.deepEqual(rows[credentialId], { issuedVia: null, createdBy: PRE_EXISTING[credentialId]![2], machine: null }, credentialId);
    }
    for (const [credentialId, { trigger }] of Object.entries(ROLLOUT_EXPECTED)) {
      assert.deepEqual(rows[credentialId], trigger, `trigger ${credentialId}`);
    }

    // Constraints are added NOT VALID: not validated in the migration.
    const { rows: constraints } = await client.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'agent_credentials'::regclass AND conname LIKE 'agent_credentials_issued%' ORDER BY conname`,
    );
    assert.deepEqual(constraints, [
      { conname: "agent_credentials_issued_by_machine_id_daemons_id_fk", convalidated: false },
      { conname: "agent_credentials_issued_via_check", convalidated: false },
    ]);
    const { rows: [column] } = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'agent_credentials' AND column_name = 'issued_via'`,
    );
    assert.equal(column!.is_nullable, "YES");

    // A server built before 0401 inserting without issued_via: insert-time rules.
    const legacy: Array<[number, string, string | null, string | null, string, string | null]> = [
      [0x5f1, AGENT_EXTERNAL, "ci-runner", USER_OWNER, "human", null],
      [0x5f2, AGENT_MANAGED, "runner:claude:c3d4e5f6", null, "computer", MACHINE],
      [0x5f3, AGENT_BOT, `app-bot:${CLIENT}`, null, "app", null],
      [0x5f4, AGENT_EXTERNAL, null, null, "unknown", null],
    ];
    for (const [n, agentId, name, createdBy] of legacy) {
      await client.query(
        `INSERT INTO "agent_credentials" ("id", "agent_id", "name", "created_by_user_id") VALUES ($1, $2, $3, $4)`,
        [id(n), agentId, name, createdBy],
      );
    }
    for (const [n, , name, , issuedVia, machine] of legacy) {
      const { rows: [row] } = await client.query<{ issued_via: string; issued_by_machine_id: string | null }>(
        `SELECT "issued_via", "issued_by_machine_id" FROM "agent_credentials" WHERE "id" = $1`, [id(n)],
      );
      assert.deepEqual({ issuedVia: row!.issued_via, machine: row!.issued_by_machine_id }, { issuedVia, machine }, `legacy insert ${name ?? "unnamed"}`);
    }
    // A current writer's explicit value is kept as written.
    await client.query(
      `INSERT INTO "agent_credentials" ("id", "agent_id", "name", "issued_via") VALUES ($1, $2, 'Cloud runtime', 'provision')`,
      [id(0x5f5), AGENT_HOSTED],
    );
    const { rows: [explicit] } = await client.query<{ issued_via: string }>(`SELECT "issued_via" FROM "agent_credentials" WHERE "id" = $1`, [id(0x5f5)]);
    assert.equal(explicit!.issued_via, "provision");
    // NOT VALID still checks new rows: the value set is closed.
    await assert.rejects(
      client.query(`INSERT INTO "agent_credentials" ("id", "agent_id", "issued_via") VALUES ('${id(0x5ff)}', '${AGENT_EXTERNAL}', 'bootstrap')`),
      /agent_credentials_issued_via_check/,
    );
  } finally {
    await client.close();
  }
});

test("one pass over fixed id slices classifies every class across slice boundaries, verifies, and a re-run changes nothing", async () => {
  const client = await setUp();
  try {
    const before = await verify(client);
    assert.deepEqual(before.filter((r) => !r.ok).map((r) => r.check).sort(), [
      "(b) every provision-referenced credential is provision",
      "(d) no row has a NULL issued_via",
      CHECK_E,
    ]);

    // Dry-run: the same slice walk, counting, without writing.
    const unchanged = await snapshot(client);
    const dry = await runBackfill(client, quiet({ write: false, batchSize: 4 }));
    assert.deepEqual(dry.changed, EXPECTED_CHANGES);
    assert.equal(dry.completed, true);
    assert.deepEqual(await snapshot(client), unchanged, "dry-run writes nothing");

    // Slices of 3 over 16 rows: 6 slices, each mixing classes (ids sort the
    // provision, bootstrap, human, computer, app and unknown rows together).
    const logged: string[] = [];
    const result = await runBackfill(client, quiet({ batchSize: 3, progressEvery: 2, log: (line) => logged.push(line) }));
    assert.deepEqual(result.changed, EXPECTED_CHANGES);
    assert.deepEqual(
      { completed: result.completed, batches: result.batches, scanned: result.scanned, lastId: result.lastId },
      { completed: true, batches: 6, scanned: ALL_IDS.length, lastId: ALL_IDS.at(-1) },
    );
    const progress = logged.filter((line) => line.startsWith("[ISSUED_VIA_BACKFILL_PROGRESS]"));
    assert.equal(progress.length, 3, "a progress line every 2 slices");
    assert.match(progress[0]!, new RegExp(`batches=2 scanned=6 .*last_id=${ALL_IDS[5]} elapsed=`));
    assert.ok(logged.at(-1)!.startsWith("[ISSUED_VIA_BACKFILL_DONE]"));

    const rows = await snapshot(client);
    for (const [credentialId, [, name, , expected]] of Object.entries(PRE_EXISTING)) {
      assert.deepEqual(rows[credentialId], expected, `credential ${credentialId} (${name ?? "unnamed"})`);
    }
    for (const [credentialId, { backfilled }] of Object.entries(ROLLOUT_EXPECTED)) {
      assert.deepEqual(rows[credentialId], backfilled, `rollout-window ${credentialId}`);
    }
    for (const r of await verify(client)) assert.ok(r.ok, `${r.check}: ${r.count}`);

    // Idempotent: a second run (dry or applied) over classified data changes nothing.
    const done = await snapshot(client);
    assert.deepEqual((await runBackfill(client, quiet({ write: false }))).changed, NO_CHANGES);
    const again = await runBackfill(client, quiet({ batchSize: 5 }));
    assert.deepEqual(again.changed, NO_CHANGES);
    assert.equal(again.scanned, ALL_IDS.length);
    assert.deepEqual(await snapshot(client), done);

    // The backfilled machine link is a real FK: the Machine's removal clears it.
    await client.exec(`DELETE FROM "daemons" WHERE "id" = '${MACHINE}'`);
    assert.equal((await snapshot(client))[id(0x505)]!.machine, null);
  } finally {
    await client.close();
  }
});

test("a stopped backfill (--max-batches, or a signal) resumes with --start-after to the same result", async () => {
  const reference = await setUp();
  const interrupted = await setUp();
  try {
    await runBackfill(reference, quiet());

    // --max-batches 2 with slices of 3: the first 6 ids done, the rest untouched.
    const logged: string[] = [];
    const first = await runBackfill(interrupted, quiet({ batchSize: 3, maxBatches: 2, log: (line) => logged.push(line) }));
    assert.deepEqual({ completed: first.completed, batches: first.batches, lastId: first.lastId }, { completed: false, batches: 2, lastId: ALL_IDS[5] });
    assert.ok(logged.some((line) => line.startsWith("[ISSUED_VIA_BACKFILL_STOPPED]")));
    assert.equal(logged.at(-1), `[ISSUED_VIA_BACKFILL_RESUME] --start-after ${ALL_IDS[5]}`);
    const partial = await snapshot(interrupted);
    const expectedRows = await snapshot(reference);
    for (const credentialId of ALL_IDS.slice(0, 6)) assert.deepEqual(partial[credentialId], expectedRows[credentialId], `walked ${credentialId}`);
    assert.ok(ALL_IDS.slice(6).some((credentialId) => partial[credentialId]!.issuedVia === null), "rows past the stop are untouched");
    assert.ok((await verify(interrupted)).some((r) => !r.ok), "partially applied");

    // A signal: stop after the slice in flight.
    let polls = 0;
    const second = await runBackfill(interrupted, quiet({ batchSize: 2, startAfter: first.lastId, shouldStop: () => ++polls > 1 }));
    assert.deepEqual({ completed: second.completed, batches: second.batches, lastId: second.lastId }, { completed: false, batches: 1, lastId: ALL_IDS[7] });

    // Resume from the printed id: only the rest of the table is walked.
    const rest = await runBackfill(interrupted, quiet({ batchSize: 4, startAfter: second.lastId }));
    assert.deepEqual({ completed: rest.completed, scanned: rest.scanned }, { completed: true, scanned: ALL_IDS.length - 8 });
    assert.deepEqual(await snapshot(interrupted), expectedRows);
    for (const r of await verify(interrupted)) assert.ok(r.ok, r.check);
  } finally {
    await reference.close();
    await interrupted.close();
  }
});

test("check (e): a bootstrap-consumed credential not 'human' with the token's issuer fails verification; the backfill corrects it", async () => {
  const client = await setUp();
  try {
    await runBackfill(client, quiet());
    const checkE = async () => (await verify(client)).find((r) => r.check === CHECK_E)!;
    assert.deepEqual(await checkE(), { check: CHECK_E, count: 0, ok: true });

    // Another person recorded as issuer, and a non-human class.
    await client.query(`UPDATE "agent_credentials" SET "created_by_user_id" = $1 WHERE "id" = $2`, [USER_OWNER, id(0x502)]);
    await client.query(`UPDATE "agent_credentials" SET "issued_via" = 'unknown', "created_by_user_id" = NULL WHERE "id" = $1`, [ROLLOUT_BOOTSTRAP]);
    assert.deepEqual(await checkE(), { check: CHECK_E, count: 2, ok: false });

    const fixed = await runBackfill(client, quiet({ batchSize: 4 }));
    assert.deepEqual(fixed.changed, { ...NO_CHANGES, "human (bootstrap token)": 2 });
    for (const r of await verify(client)) assert.ok(r.ok, `${r.check}: ${r.count}`);
    const rows = await snapshot(client);
    assert.deepEqual(rows[id(0x502)], { issuedVia: "human", createdBy: USER_ISSUER, machine: null });
    assert.deepEqual(rows[ROLLOUT_BOOTSTRAP], { issuedVia: "human", createdBy: USER_ISSUER, machine: null });
  } finally {
    await client.close();
  }
});

test("CLI arguments: dry-run by default, explicit apply / verify, bounded batch and pause, resume and limits", () => {
  const defaults = { mode: "dry-run", batchSize: 1000, sleepMs: 0, startAfter: null, maxBatches: null, progressEvery: 100 };
  assert.deepEqual(parseArgs([]), defaults);
  assert.deepEqual(
    parseArgs(["--", "--apply", "--batch", "500", "--sleep-ms", "50", "--start-after", id(0x505), "--max-batches", "10", "--progress-every", "5"]),
    { mode: "apply", batchSize: 500, sleepMs: 50, startAfter: id(0x505), maxBatches: 10, progressEvery: 5 },
  );
  assert.equal(parseArgs(["--verify"]).mode, "verify");
  assert.equal(parseArgs(["--apply", "--dry-run"]).mode, "dry-run");
  assert.throws(() => parseArgs(["--batch", "0"]), /--batch/);
  assert.throws(() => parseArgs(["--batch", "20000"]), /--batch/);
  assert.throws(() => parseArgs(["--sleep-ms", "-1"]), /--sleep-ms/);
  assert.throws(() => parseArgs(["--start-after", "runner:claude:c3d4e5f6"]), /--start-after/);
  assert.throws(() => parseArgs(["--start-after"]), /--start-after/);
  assert.throws(() => parseArgs(["--max-batches", "0"]), /--max-batches/);
  assert.throws(() => parseArgs(["--progress-every", "1.5"]), /--progress-every/);
  assert.throws(() => parseArgs(["--force"]), /Unknown argument/);
});
