import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// An agent may change a channel member's channel role on its own authority
// (2026-11-17): a role event's requester is a person or an agent, exactly one.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const SUFFIX = "_channel_role_events_agent_requester";

type JournalEntry = { idx: number; tag: string };

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function target(): Promise<{ entries: JournalEntry[]; step: JournalEntry }> {
  const entries = (JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] }).entries;
  const step = entries.find((candidate) => candidate.tag.endsWith(SUFFIX));
  assert.ok(step, `${SUFFIX} is in the journal`);
  return { entries, step };
}

async function apply(client: PGlite, entries: JournalEntry[]): Promise<void> {
  for (const entry of entries) {
    await client.exec("BEGIN");
    try {
      for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"))) await client.exec(statement);
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
  INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${USER}', 'roles@slock.test', 'roles', 'test');
  INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES ('${SERVER}', 'Roles', 'roles', '${USER}');
  INSERT INTO "channels" ("id", "server_id", "name") VALUES ('${CHANNEL}', '${SERVER}', 'roles');
  INSERT INTO "agents" ("id", "server_id", "name") VALUES ('${AGENT}', '${SERVER}', 'scout');
`;

function eventInsert(requester: { user?: string; agent?: string }, legacy = false): string {
  const columns = legacy ? `"requester_user_id"` : `"requester_user_id", "requester_agent_id"`;
  const user = requester.user ? `'${requester.user}'` : "NULL";
  const values = legacy ? user : `${user}, ${requester.agent ? `'${requester.agent}'` : "NULL"}`;
  return `INSERT INTO "channel_membership_role_events" ("id", "channel_id", "server_id", ${columns}, "target_type", "target_id", "previous_role", "next_role", "authority_revision")
    VALUES (gen_random_uuid(), '${CHANNEL}', '${SERVER}', ${values}, 'agent', '${AGENT}', 'member', 'admin', 2)`;
}

test("the migration is lock-bounded and changes no data", async () => {
  const { step } = await target();
  const executable = statements(await readFile(path.join(DRIZZLE_DIR, `${step.tag}.sql`), "utf8"));
  assert.match(executable[0] ?? "", /^SET LOCAL lock_timeout = '2s';$/);
  for (const statement of executable) {
    assert.doesNotMatch(statement, /^UPDATE\b|\b(DELETE FROM|INSERT INTO|SET DATA TYPE|DEFAULT)\b/i);
  }
});

test("existing events keep their person, an agent can be the requester, and exactly one is set", async () => {
  const { entries, step } = await target();
  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx < step.idx));
    await client.exec(SEED);
    await client.exec(eventInsert({ user: USER }, true));

    await apply(client, [step]);
    // The previous release still writes requester_user_id only.
    await client.exec(eventInsert({ user: USER }, true));
    await client.exec(eventInsert({ agent: AGENT }));
    await assert.rejects(client.exec(eventInsert({})), /channel_membership_role_events_requester_check/, "no requester at all");
    await assert.rejects(client.exec(eventInsert({ user: USER, agent: AGENT })), /channel_membership_role_events_requester_check/, "not both");
    const rows = (await client.query<{ agent: string | null; person: string | null }>(`
      SELECT requester_agent_id AS agent, requester_user_id AS person FROM channel_membership_role_events
    `)).rows;
    assert.equal(rows.filter((row) => row.person === USER && row.agent === null).length, 2);
    assert.equal(rows.filter((row) => row.agent === AGENT && row.person === null).length, 1);
  } finally {
    await client.close();
  }
});
