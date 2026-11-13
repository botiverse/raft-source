import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { DEFAULT_OPTIONS, parseArgs, run, type Options } from "./revoke-orphaned-app-bot-keys";

// The tables reduced to the columns the script reads and writes.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const LIVE_APP = id(0x401);
const GONE_APP = id(0x402);
const INSTALL = id(0x403);
const PERSON = id(0x101);

// agent id -> managed_by_app_install_id
const AGENTS: Record<string, string | null> = {
  [id(0x301)]: null, // orphaned Bot, App-minted key
  [id(0x302)]: null, // orphaned Bot, pre-issued_via key for a deleted App
  [id(0x303)]: INSTALL, // a managed Bot
  [id(0x304)]: null, // an ordinary agent
  [id(0x305)]: null, // ordinary agent whose 'unknown' key names a live App
};
// credential id -> [agent, name, issued_via, created_by_user_id, expect revoked]
const KEYS: Record<string, [string, string, string | null, string | null, boolean]> = {
  [id(0x501)]: [id(0x301), `app-bot:${GONE_APP}`, "app", null, true],
  [id(0x502)]: [id(0x302), `app-bot:${GONE_APP}`, "unknown", null, true],
  [id(0x503)]: [id(0x303), `app-bot:${LIVE_APP}`, "app", null, false],
  // A person's key named like a Bot key, on an ordinary agent: never touched.
  [id(0x504)]: [id(0x304), `app-bot:${GONE_APP}`, "human", PERSON, false],
  [id(0x505)]: [id(0x304), "ci-runner", "human", PERSON, false],
  // 'unknown' with a person recorded: never touched.
  [id(0x506)]: [id(0x304), `app-bot:${GONE_APP}`, "unknown", PERSON, false],
  // A legacy name for an App that still exists: not orphaned by a deletion.
  [id(0x507)]: [id(0x305), `app-bot:${LIVE_APP}`, "unknown", null, false],
  // A malformed id after the prefix: no cast error, not matched.
  [id(0x508)]: [id(0x305), "app-bot:not-a-uuid", "unknown", null, false],
};
const DELETED_AGENTS = new Set([id(0x301), id(0x302)]);
// credential id -> last_used_at, as an SQL expression: online is seen within the presence window (120 s).
const LAST_USED: Record<string, string> = {
  [id(0x501)]: "now() - interval '30 seconds'", // orphaned and online: an open stream outlives the revocation
  [id(0x502)]: "now() - interval '1 hour'", // orphaned, last seen long ago
  [id(0x503)]: "now()", // online, but a managed Bot's key: not matched, not counted
};

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE oauth_clients (id uuid PRIMARY KEY);
    CREATE TABLE agents (id uuid PRIMARY KEY, managed_by_app_install_id uuid, deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE agent_credentials (
      id uuid PRIMARY KEY, agent_id uuid NOT NULL REFERENCES agents(id), name text, issued_via text,
      created_by_user_id uuid, revoked_at timestamptz, revoked_reason text, last_used_at timestamptz
    );
    INSERT INTO oauth_clients (id) VALUES ('${LIVE_APP}');
  `);
  for (const [agentId, install] of Object.entries(AGENTS)) {
    await db.query(`INSERT INTO agents (id, managed_by_app_install_id) VALUES ($1, $2)`, [agentId, install]);
  }
  for (const [keyId, [agentId, name, issuedVia, createdBy]] of Object.entries(KEYS)) {
    await db.query(
      `INSERT INTO agent_credentials (id, agent_id, name, issued_via, created_by_user_id) VALUES ($1, $2, $3, $4, $5)`,
      [keyId, agentId, name, issuedVia, createdBy],
    );
  }
  for (const [keyId, at] of Object.entries(LAST_USED)) {
    await db.query(`UPDATE agent_credentials SET last_used_at = ${at} WHERE id = $1`, [keyId]);
  }
  return db;
}

const quiet = (overrides: Partial<Options> = {}): Options => ({ ...DEFAULT_OPTIONS, log: () => undefined, ...overrides });

test("revokes only orphaned App Bot keys and soft-deletes only those Bots, in small slices", async () => {
  const db = await seeded();
  const lines: string[] = [];
  const dry = await run(db, quiet({ write: false, batchSize: 3, log: (line) => lines.push(line) }));
  assert.equal(dry.completed, true);
  assert.deepEqual([dry.keys, dry.agents], [2, 2]);
  // Of the two, only the one seen within the presence window is online; the managed Bot's online key isn't counted.
  assert.deepEqual([dry.online, dry.onlineAgentIds], [1, [id(0x301)]]);
  assert.ok(lines.some((line) => line.startsWith("[ORPHANED_APP_BOT_KEYS_DONE] mode=dry-run") && line.includes(" online=1 ")), lines.join("\n"));
  assert.ok(lines.some((line) => line.startsWith("[ORPHANED_APP_BOT_KEYS_ONLINE] 1 agent(s)") && line.endsWith(`agent_ids=${id(0x301)}`)), lines.join("\n"));
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM agent_credentials WHERE revoked_at IS NOT NULL`)).rows[0]!.n, 0, "dry-run writes nothing");

  const applied = await run(db, quiet({ batchSize: 3 }));
  assert.equal(applied.completed, true);
  assert.equal(applied.scanned, Object.keys(KEYS).length);
  assert.deepEqual([applied.keys, applied.agents], [2, 2]);
  assert.deepEqual([applied.online, applied.onlineAgentIds], [1, [id(0x301)]], "apply reports which revoked Bots were online");
  const keys = await db.query<{ id: string; revoked_at: Date | null; revoked_reason: string | null }>(`SELECT id, revoked_at, revoked_reason FROM agent_credentials`);
  for (const row of keys.rows) {
    const expected = KEYS[row.id]![4];
    assert.equal(row.revoked_at !== null, expected, `key ${row.id}`);
    if (expected) assert.equal(row.revoked_reason, "app_deleted");
  }
  const agents = await db.query<{ id: string; deleted_at: Date | null }>(`SELECT id, deleted_at FROM agents`);
  for (const row of agents.rows) assert.equal(row.deleted_at !== null, DELETED_AGENTS.has(row.id), `agent ${row.id}`);

  // Idempotent.
  const quietLines: string[] = [];
  const again = await run(db, quiet({ batchSize: 3, log: (line) => quietLines.push(line) }));
  assert.deepEqual([again.keys, again.agents, again.online], [0, 0, 0]);
  assert.ok(!quietLines.some((line) => line.startsWith("[ORPHANED_APP_BOT_KEYS_ONLINE]")), "no online line when none is online");
});

test("stops after --max-batches with a resume point, and resuming finishes the walk", async () => {
  const db = await seeded();
  const lines: string[] = [];
  const first = await run(db, quiet({ batchSize: 2, maxBatches: 1, log: (line) => lines.push(line) }));
  assert.equal(first.completed, false);
  assert.ok(lines.some((line) => line === `[ORPHANED_APP_BOT_KEYS_RESUME] --start-after ${first.lastId}`));
  const rest = await run(db, quiet({ batchSize: 2, startAfter: first.lastId }));
  assert.equal(rest.completed, true);
  assert.equal(first.keys + rest.keys, 2);
});

test("arguments: dry-run by default, bounded batch and sleep, uuid resume point", () => {
  assert.equal(parseArgs([]).apply, false);
  assert.equal(parseArgs(["--", "--apply", "--sleep-ms", "50"]).sleepMs, 50);
  assert.throws(() => parseArgs(["--batch", "0"]), /--batch/);
  assert.throws(() => parseArgs(["--sleep-ms", "-1"]), /--sleep-ms/);
  assert.throws(() => parseArgs(["--start-after", "x"]), /--start-after/);
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});
