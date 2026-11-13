import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// A person can ask for an action card (task #10 #proj-commercial):
// requester_agent_id becomes nullable, requester_user_id is added, exactly one
// is set. The FK and the CHECK come NOT VALID (catalog-only), then VALIDATE in
// their own migration (one transaction each).
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const SUFFIXES = ["_action_cards_member_requester", "_action_cards_member_requester_validate"] as const;

type JournalEntry = { idx: number; tag: string };

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function targets(): Promise<{ entries: JournalEntry[]; steps: JournalEntry[] }> {
  const entries = (JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] }).entries;
  const steps = SUFFIXES.map((suffix) => {
    const entry = entries.find((candidate) => candidate.tag.endsWith(suffix));
    assert.ok(entry, `${suffix} is in the journal`);
    return entry;
  });
  assert.equal(steps[1]!.idx, steps[0]!.idx + 1, "consecutive");
  return { entries, steps };
}

async function migrationStatements(entry: JournalEntry): Promise<string[]> {
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

async function apply(client: PGlite, entries: JournalEntry[]): Promise<void> {
  for (const entry of entries) {
    await client.exec("BEGIN");
    try {
      for (const statement of await migrationStatements(entry)) await client.exec(statement);
      await client.exec("COMMIT");
    } catch (error) {
      await client.exec("ROLLBACK");
      throw error;
    }
  }
}

const USER = "11111111-1111-4111-8111-111111111111";
const SERVER = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";

const SEED = `
  INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${USER}', 'seats@slock.test', 'seats', 'test');
  INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES ('${SERVER}', 'Seats', 'seats', '${USER}');
  INSERT INTO "channels" ("id", "server_id", "name") VALUES ('${CHANNEL}', '${SERVER}', 'seats');
  INSERT INTO "agents" ("id", "server_id", "name") VALUES ('${AGENT}', '${SERVER}', 'scout');
`;

let messageCount = 0;
function cardInsert(requester: { agent?: string; user?: string }): string {
  messageCount += 1;
  const message = `55555555-5555-4555-8555-${String(messageCount).padStart(12, "0")}`;
  const agent = requester.agent ? `'${requester.agent}'` : "NULL";
  const user = requester.user ? `'${requester.user}'` : "NULL";
  return `
    INSERT INTO "messages" ("id", "channel_id", "sender_type", "sender_id", "content") VALUES ('${message}', '${CHANNEL}', 'user', '${USER}', '');
    INSERT INTO "action_cards" ("id", "server_id", "message_id", "requester_agent_id", "requester_user_id", "action_type", "payload")
    VALUES (gen_random_uuid(), '${SERVER}', '${message}', ${agent}, ${user}, 'seats:add', '{}'::jsonb);
  `;
}
function agentOnlyInsert(): string {
  messageCount += 1;
  const message = `55555555-5555-4555-8555-${String(messageCount).padStart(12, "0")}`;
  return `
    INSERT INTO "messages" ("id", "channel_id", "sender_type", "sender_id", "content") VALUES ('${message}', '${CHANNEL}', 'agent', '${AGENT}', '');
    INSERT INTO "action_cards" ("id", "server_id", "message_id", "requester_agent_id", "action_type", "payload")
    VALUES (gen_random_uuid(), '${SERVER}', '${message}', '${AGENT}', 'agent:create', '{}'::jsonb);
  `;
}

test("the migrations are lock-bounded, catalog-only then VALIDATE, and change no data", async () => {
  const { steps } = await targets();
  const [add, validate] = await Promise.all(steps.map(migrationStatements));
  for (const executable of [add!, validate!]) {
    assert.match(executable[0] ?? "", /^SET LOCAL lock_timeout = '\d+s';$/);
    for (const statement of executable) {
      assert.doesNotMatch(statement, /\bDROP\s+(COLUMN|INDEX|TABLE|CONSTRAINT)\b/i);
      assert.doesNotMatch(statement, /^UPDATE\b|\b(DELETE FROM|INSERT INTO|SET DATA TYPE|DEFAULT)\b/i, "no rewrite, no data change");
    }
  }
  for (const statement of add!.filter((s) => /ADD CONSTRAINT/.test(s))) {
    assert.match(statement, /NOT VALID;$/, "constraints bind new rows without scanning");
  }
  assert.deepEqual(validate!.slice(1), [
    `ALTER TABLE "action_cards" VALIDATE CONSTRAINT "action_cards_requester_user_id_users_id_fk";`,
    `ALTER TABLE "action_cards" VALIDATE CONSTRAINT "action_cards_one_requester";`,
  ], "the scans run alone, under SHARE UPDATE EXCLUSIVE");
});

test("agent cards keep working, a person can be the requester, and exactly one requester is set", async () => {
  const { entries, steps } = await targets();
  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx < steps[0]!.idx));
    await client.exec(SEED);
    // The previous release writes agent cards without the new column.
    await client.exec(agentOnlyInsert());

    await apply(client, [steps[0]!]);
    await client.exec(agentOnlyInsert());
    await client.exec(cardInsert({ user: USER }));
    await assert.rejects(client.exec(cardInsert({})), /action_cards_one_requester/, "no requester at all");
    await assert.rejects(client.exec(cardInsert({ agent: AGENT, user: USER })), /action_cards_one_requester/, "not both");

    await apply(client, steps.slice(1));
    await assert.rejects(client.exec(cardInsert({})), /action_cards_one_requester/);
    const rows = (await client.query<{ agent: string | null; person: string | null }>(`
      SELECT requester_agent_id AS agent, requester_user_id AS person FROM action_cards ORDER BY created_at, agent NULLS LAST
    `)).rows;
    assert.equal(rows.filter((row) => row.agent === AGENT && row.person === null).length, 2);
    assert.equal(rows.filter((row) => row.agent === null && row.person === USER).length, 1);
  } finally {
    await client.close();
  }
});

test("a person's cards go when the person is deleted", async () => {
  const { entries, steps } = await targets();
  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx <= steps[1]!.idx));
    await client.exec(SEED);
    const other = "66666666-6666-4666-8666-666666666666";
    await client.exec(`INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${other}', 'asker@slock.test', 'asker', 'test')`);
    await client.exec(cardInsert({ user: other }));
    await client.exec(`DELETE FROM "users" WHERE "id" = '${other}'`);
    const [{ count }] = (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM action_cards WHERE requester_user_id IS NOT NULL`)).rows;
    assert.equal(count, 0);
  } finally {
    await client.close();
  }
});
