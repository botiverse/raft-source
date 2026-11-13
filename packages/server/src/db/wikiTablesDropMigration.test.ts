import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// The retired Wiki's tables all go: wiki_spaces, wiki_bindings and the three
// 0191 tables whose foreign keys point at wiki_spaces (0202 became a no-op
// before release). Agents and channels the dropped rows name are not touched.
// 0606 is a no-op since its first version locked servers, channels, agents and
// users in one transaction; 0611-0614 drop the foreign keys one hot table at a
// time, 0615 the tables (which then lock no hot table).
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const HOT_TABLES = ["servers", "channels", "agents", "users"];

type Migration = { tag: string; statements: string[] };

/** The Wiki drop migrations in journal order, each as the deploy runner splits it. */
async function wikiMigrations(): Promise<Migration[]> {
  const { entries } = JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  const tags = entries.map((entry) => entry.tag).filter((tag) => /^\d{4}_wiki_(tables|servers_fks|channels_fks|agents_fks|users_fks)_drop$/.test(tag));
  assert.deepEqual(tags, [
    "0606_wiki_tables_drop",
    "0611_wiki_servers_fks_drop",
    "0612_wiki_channels_fks_drop",
    "0613_wiki_agents_fks_drop",
    "0614_wiki_users_fks_drop",
    "0615_wiki_tables_drop",
  ]);
  return Promise.all(tags.map(async (tag) => ({
    tag,
    statements: (await readFile(path.join(DRIZZLE_DIR, `${tag}.sql`), "utf8"))
      .split("--> statement-breakpoint")
      .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
      .filter(Boolean),
  })));
}

async function apply(client: PGlite, statements: string[]): Promise<void> {
  await client.exec("BEGIN");
  try {
    for (const statement of statements) await client.exec(statement);
    await client.exec("COMMIT");
  } catch (error) {
    await client.exec("ROLLBACK");
    throw error;
  }
}

async function tableNames(client: PGlite): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  return rows.map((row) => row.table_name);
}

// The 0191/0205 shapes that matter here: the keys out of and into the Wiki tables.
const LEGACY_WIKI_SCHEMA = `
  CREATE TABLE servers (id uuid PRIMARY KEY);
  CREATE TABLE users (id uuid PRIMARY KEY);
  CREATE TABLE agents (id uuid PRIMARY KEY);
  CREATE TABLE channels (id uuid PRIMARY KEY);
  CREATE TABLE wiki_spaces (
    id uuid PRIMARY KEY,
    server_id uuid NOT NULL CONSTRAINT wiki_spaces_server_id_servers_id_fk REFERENCES servers(id) ON DELETE cascade,
    wiki_agent_id uuid NOT NULL CONSTRAINT wiki_spaces_wiki_agent_id_agents_id_fk REFERENCES agents(id) ON DELETE restrict,
    wiki_channel_id uuid NOT NULL CONSTRAINT wiki_spaces_wiki_channel_id_channels_id_fk REFERENCES channels(id) ON DELETE restrict,
    created_by_user_id uuid NOT NULL CONSTRAINT wiki_spaces_created_by_user_id_users_id_fk REFERENCES users(id) ON DELETE restrict
  );
  CREATE TABLE wiki_bindings (
    id uuid PRIMARY KEY,
    server_id uuid NOT NULL CONSTRAINT wiki_bindings_server_id_servers_id_fk REFERENCES servers(id) ON DELETE cascade,
    wiki_agent_id uuid NOT NULL CONSTRAINT wiki_bindings_wiki_agent_id_agents_id_fk REFERENCES agents(id) ON DELETE restrict,
    wiki_channel_id uuid NOT NULL CONSTRAINT wiki_bindings_wiki_channel_id_channels_id_fk REFERENCES channels(id) ON DELETE restrict,
    created_by_user_id uuid NOT NULL CONSTRAINT wiki_bindings_created_by_user_id_users_id_fk REFERENCES users(id) ON DELETE restrict
  );
  CREATE TABLE wiki_artifacts (id uuid PRIMARY KEY,
    server_id uuid NOT NULL CONSTRAINT wiki_artifacts_server_id_servers_id_fk REFERENCES servers(id) ON DELETE cascade,
    wiki_space_id uuid NOT NULL CONSTRAINT wiki_artifacts_wiki_space_id_wiki_spaces_id_fk REFERENCES wiki_spaces(id) ON DELETE cascade);
  CREATE TABLE wiki_jobs (id uuid PRIMARY KEY,
    server_id uuid NOT NULL CONSTRAINT wiki_jobs_server_id_servers_id_fk REFERENCES servers(id) ON DELETE cascade,
    wiki_space_id uuid NOT NULL CONSTRAINT wiki_jobs_wiki_space_id_wiki_spaces_id_fk REFERENCES wiki_spaces(id) ON DELETE cascade);
  CREATE TABLE wiki_source_coverage (
    channel_id uuid NOT NULL CONSTRAINT wiki_source_coverage_channel_id_channels_id_fk REFERENCES channels(id) ON DELETE cascade,
    wiki_space_id uuid NOT NULL CONSTRAINT wiki_source_coverage_wiki_space_id_wiki_spaces_id_fk REFERENCES wiki_spaces(id) ON DELETE cascade);
  INSERT INTO servers VALUES ('11111111-1111-4111-8111-111111111111');
  INSERT INTO users VALUES ('22222222-2222-4222-8222-222222222222');
  INSERT INTO agents VALUES ('33333333-3333-4333-8333-333333333333');
  INSERT INTO channels VALUES ('44444444-4444-4444-8444-444444444444');
  INSERT INTO wiki_spaces VALUES ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222');
  INSERT INTO wiki_bindings VALUES ('66666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222');
  INSERT INTO wiki_artifacts VALUES ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111',
    '55555555-5555-4555-8555-555555555555');
`;

async function applyAll(client: PGlite, migrations: Migration[]): Promise<void> {
  for (const { statements } of migrations) await apply(client, statements);
}

test("0606 is a no-op; every later step takes a bounded lock and no CASCADE", async () => {
  const [first, ...rest] = await wikiMigrations();
  assert.deepEqual(first!.statements, ["SELECT 1;"], "0606 does nothing");
  for (const { tag, statements } of rest) {
    assertBoundedLockTimeout(statements[0], `${tag}'s lock timeout`, { maxMs: 2_000 });
    assert.ok(statements.every((statement) => !/\bCASCADE\b/i.test(statement)), `${tag}: no CASCADE`);
  }
});

test("each foreign-key step locks one hot table, and together they drop every key from a Wiki table to one", async () => {
  const client = new PGlite();
  try {
    await client.exec(LEGACY_WIKI_SCHEMA);
    const keyParents = async () => (await client.query<{ conname: string; parent: string }>(
      `SELECT c.conname, p.relname AS parent FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid JOIN pg_class p ON p.oid = c.confrelid
       WHERE c.contype = 'f' AND t.relname LIKE 'wiki\\_%' AND p.relname NOT LIKE 'wiki\\_%' ORDER BY 1`,
    )).rows;
    assert.equal((await keyParents()).length, 11, "the 11 keys production has (4 servers, 3 channels, 2 agents, 2 users)");
    const steps = (await wikiMigrations()).slice(1, 5);
    for (const [index, { tag, statements }] of steps.entries()) {
      const before = await keyParents();
      await apply(client, statements);
      const after = await keyParents();
      const dropped = before.filter((key) => !after.some((left) => left.conname === key.conname));
      assert.deepEqual([...new Set(dropped.map((key) => key.parent))], [HOT_TABLES[index]], `${tag} drops the keys to ${HOT_TABLES[index]} only`);
    }
    assert.deepEqual(await keyParents(), [], "no key from a Wiki table to another table is left");
  } finally {
    await client.close();
  }
});

test("the final drop refuses while a Wiki table still has a key to another table", async () => {
  const client = new PGlite();
  try {
    await client.exec(LEGACY_WIKI_SCHEMA);
    const final = (await wikiMigrations()).at(-1)!;
    await assert.rejects(apply(client, final.statements), /a Wiki table still has a foreign key to another table/);
    assert.deepEqual(await tableNames(client), ["agents", "channels", "servers", "users", "wiki_artifacts", "wiki_bindings", "wiki_jobs", "wiki_source_coverage", "wiki_spaces"], "nothing dropped");
  } finally {
    await client.close();
  }
});

test("the Wiki drop removes all five Wiki tables and nothing else, and is a no-op on a rerun", async () => {
  const client = new PGlite();
  try {
    await client.exec(LEGACY_WIKI_SCHEMA);
    const migrations = await wikiMigrations();
    await applyAll(client, migrations);
    await applyAll(client, migrations);
    assert.deepEqual(await tableNames(client), ["agents", "channels", "servers", "users"]);
    assert.equal((await client.query("SELECT 1 FROM agents")).rows.length, 1, "the agent stays");
    assert.equal((await client.query("SELECT 1 FROM channels")).rows.length, 1, "the channel stays");
  } finally {
    await client.close();
  }
});

test("the Wiki drop is a no-op where none of the Wiki tables exist (staging, after 0606's first version)", async () => {
  const client = new PGlite();
  try {
    await applyAll(client, await wikiMigrations());
    assert.deepEqual(await tableNames(client), []);
  } finally {
    await client.close();
  }
});
