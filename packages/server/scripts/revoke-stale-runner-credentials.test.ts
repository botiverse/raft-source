import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migratePglite } from "../src/db/pgliteMigrations";
import {
  checkEndpoint, DEFAULT_OPTIONS, DELETED_AGENT_REVOKED_REASON, DELETED_AGENT_SPLIT_AT, parseArgs, REVOKED_REASON, run, runDeletedAgents,
  type DeletedAgentsOptions, type Options,
} from "./revoke-stale-runner-credentials";

// The real schema (every migration), seeded with raw SQL.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const PERSON = id(0x101);
const SERVER = id(0x201);
const OTHER_SERVER = id(0x202);
const LIVE_MACHINE = id(0x301);
const SILENT_MACHINE = id(0x302);
const NEVER_SEEN_MACHINE = id(0x303);

// agent id -> [server, machine, status, deleted]
const AGENTS: Record<string, [string, string | null, "active" | "inactive", boolean]> = {
  [id(0x401)]: [SERVER, LIVE_MACHINE, "active", false], // on a live Machine: every key deferred
  [id(0x402)]: [SERVER, LIVE_MACHINE, "active", false], // live Machine, one key in use
  [id(0x403)]: [SERVER, LIVE_MACHINE, "active", true], // deleted
  [id(0x404)]: [SERVER, LIVE_MACHINE, "inactive", false], // inactive, but its Machine is live: deferred
  [id(0x405)]: [OTHER_SERVER, SILENT_MACHINE, "active", false], // its Machine went silent (3 days)
  [id(0x406)]: [SERVER, null, "active", false], // no Machine; only keys that are not runner credentials
  [id(0x407)]: [SERVER, null, "active", false], // no Machine
  [id(0x408)]: [SERVER, NEVER_SEEN_MACHINE, "active", false], // Machine never heartbeated
};
const A = Object.keys(AGENTS);

type Key = {
  agent: string;
  name: string;
  issuedVia: string;
  createdBy?: string;
  /** Days ago. */
  created: number;
  used?: number;
  revokedReason?: string;
  provision?: boolean;
  revoke: boolean;
};
const RUNNER = "runner:claude:00000000";
const KEYS: Record<string, Key> = {
  [id(0x501)]: { agent: A[0]!, name: RUNNER, issuedVia: "computer", created: 40, used: 35, revoke: false }, // live Machine: newest, stale
  [id(0x502)]: { agent: A[1]!, name: "runner:codex:00000000", issuedVia: "computer", created: 300, revoke: false }, // live Machine, never used
  [id(0x503)]: { agent: A[2]!, name: RUNNER, issuedVia: "computer", created: 80, used: 70, revoke: true }, // deleted agent
  [id(0x504)]: { agent: A[0]!, name: RUNNER, issuedVia: "computer", created: 110, used: 100, revoke: false }, // live Machine: OLDER key, stale
  [id(0x505)]: { agent: A[3]!, name: RUNNER, issuedVia: "computer", created: 45, revoke: false }, // inactive agent, live Machine
  [id(0x506)]: { agent: A[4]!, name: RUNNER, issuedVia: "computer", created: 140, used: 130, revoke: true }, // silent Machine
  [id(0x507)]: { agent: A[0]!, name: RUNNER, issuedVia: "computer", created: 50, revoke: false }, // live Machine: older, never used
  [id(0x508)]: { agent: A[1]!, name: "runner:codex:00000000", issuedVia: "computer", created: 200, used: 1, revoke: false }, // used yesterday
  // Never runner credentials, all stale, on an agent with no Machine:
  [id(0x509)]: { agent: A[5]!, name: RUNNER, issuedVia: "human", createdBy: PERSON, created: 90, revoke: false },
  [id(0x50a)]: { agent: A[5]!, name: "app-bot:x", issuedVia: "app", created: 90, revoke: false },
  [id(0x50b)]: { agent: A[5]!, name: RUNNER, issuedVia: "provision", created: 90, revoke: false },
  [id(0x50c)]: { agent: A[5]!, name: RUNNER, issuedVia: "unknown", created: 90, revoke: false },
  [id(0x50d)]: { agent: A[5]!, name: "ci-runner", issuedVia: "computer", created: 90, revoke: false },
  [id(0x50e)]: { agent: A[5]!, name: RUNNER, issuedVia: "computer", createdBy: PERSON, created: 90, revoke: false },
  [id(0x50f)]: { agent: A[5]!, name: RUNNER, issuedVia: "computer", created: 90, provision: true, revoke: false },
  [id(0x510)]: { agent: A[5]!, name: RUNNER, issuedVia: "computer", created: 90, revokedReason: "managed_runner_launch_ended", revoke: false },
  [id(0x511)]: { agent: A[6]!, name: RUNNER, issuedVia: "computer", created: 60, used: 40, revoke: true }, // no Machine
  [id(0x512)]: { agent: A[7]!, name: RUNNER, issuedVia: "computer", created: 200, revoke: true }, // Machine never seen, never used
};
const REVOKED = Object.keys(KEYS).filter((key) => KEYS[key]!.revoke).sort();

let template: File | Blob;

beforeAll(async () => {
  const db = new PGlite();
  await migratePglite(db);
  template = await db.dumpDataDir("none");
  await db.close();
});

async function seeded(): Promise<PGlite> {
  const db = new PGlite({ loadDataDir: template });
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, 'p@test.invalid', 'p', 'x')`, [PERSON]);
  for (const [serverId, slug] of [[SERVER, "s1"], [OTHER_SERVER, "s2"]]) {
    await db.query(`INSERT INTO servers (id, name, slug, owner_id) VALUES ($1, $2, $2, $3)`, [serverId, slug, PERSON]);
  }
  for (const [machineId, serverId, heartbeat] of [
    [LIVE_MACHINE, SERVER, "now() - interval '5 minutes'"],
    [SILENT_MACHINE, OTHER_SERVER, "now() - interval '3 days'"],
    [NEVER_SEEN_MACHINE, SERVER, "NULL"],
  ] as const) {
    await db.query(
      `INSERT INTO daemons (id, server_id, user_id, name, api_key_hash, last_heartbeat) VALUES ($1, $2, $3, 'm', 'x', ${heartbeat})`,
      [machineId, serverId, PERSON],
    );
  }
  for (const [agentId, [serverId, machineId, status, deleted]] of Object.entries(AGENTS)) {
    await db.query(
      `INSERT INTO agents (id, server_id, name, daemon_id, status, deleted_at) VALUES ($1, $2, $5, $3, $4, ${deleted ? "now()" : "NULL"})`,
      [agentId, serverId, machineId, status, `agent-${agentId.slice(-3)}`],
    );
  }
  for (const [keyId, key] of Object.entries(KEYS)) {
    await db.query(
      `INSERT INTO agent_credentials (id, agent_id, api_key_hash, api_key_prefix, scopes, name, issued_via, created_by_user_id,
         created_at, last_used_at, revoked_at, revoked_reason)
       VALUES ($1, $2, 'x', 'sk_agent_x', '{send}', $3, $4, $5, now() - make_interval(days => $6::int),
         CASE WHEN $7::int IS NULL THEN NULL ELSE now() - make_interval(days => $7::int) END,
         CASE WHEN $8::text IS NULL THEN NULL ELSE now() - interval '80 days' END, $8::text)`,
      [keyId, key.agent, key.name, key.issuedVia, key.createdBy ?? null, key.created, key.used ?? null, key.revokedReason ?? null],
    );
    if (key.provision) {
      await db.query(
        `INSERT INTO agent_runtime_provisions (agent_id, server_id, provider, state, credential_id, provisioned_name, provisioned_instructions)
         VALUES ($1, $2, 'antiproton', 'active', $3, 'n', 'i')`,
        [key.agent, SERVER, keyId],
      );
    }
  }
  return db;
}

const quiet = (overrides: Partial<Options> = {}): Options => ({ ...DEFAULT_OPTIONS, log: () => undefined, ...overrides });
const credentials = async (db: PGlite) => (await db.query<{ id: string; revoked_at: Date | null; revoked_reason: string | null; revoked_by_user_id: string | null }>(
  `SELECT id, revoked_at, revoked_reason, revoked_by_user_id FROM agent_credentials ORDER BY id`,
)).rows;

test("dry-run reports what it would revoke and writes nothing; apply revokes exactly that; a re-run changes nothing", async () => {
  const db = await seeded();
  const before = await credentials(db);
  const dry = await run(db, quiet({ batchSize: 3 }));
  assert.equal(dry.completed, true);
  assert.equal(dry.scanned, Object.keys(KEYS).length);
  assert.deepEqual(dry.counts, {
    candidates: 10, stale: 9, deferredLiveMachine: 5, toRevoke: 4,
    ageBelow60d: 1, age60To120d: 1, age120dPlus: 2, neverUsed: 1, used: 3,
  });
  assert.deepEqual([dry.agents, dry.servers], [4, 2]);
  assert.deepEqual([dry.deferredAgents, dry.deferredServers], [3, 1]);
  assert.deepEqual([dry.firstToRevokeId, dry.lastToRevokeId], [REVOKED[0], REVOKED.at(-1)]);
  assert.equal(dry.revoked, 0);
  assert.deepEqual(await credentials(db), before, "dry-run writes nothing");

  const lines: string[] = [];
  const applied = await run(db, quiet({ batchSize: 3, write: true, runId: "t1", log: (line) => lines.push(line) }));
  assert.equal(applied.completed, true);
  assert.equal(applied.revoked, 4);
  assert.deepEqual(applied.counts, dry.counts);
  for (const row of await credentials(db)) {
    const key = KEYS[row.id]!;
    if (key.revoke) {
      assert.ok(row.revoked_at !== null, `key ${row.id} revoked`);
      assert.equal(row.revoked_reason, REVOKED_REASON);
      assert.equal(row.revoked_by_user_id, null);
    } else {
      assert.deepEqual(row, before.find((b) => b.id === row.id), `key ${row.id} untouched`);
    }
  }
  // Newest or not makes no difference on a live Machine: A1's older stale keys stay too.
  assert.deepEqual(REVOKED.filter((key) => KEYS[key]!.agent === A[0]), []);
  const receipts = lines.filter((line) => line.startsWith("[STALE_RUNNER_CREDENTIALS_RECEIPT] run_id=t1 "));
  assert.equal(receipts.length, applied.batches, "one receipt per slice");
  assert.equal(receipts.reduce((sum, line) => sum + Number(/ revoked=(\d+) /.exec(line)![1]), 0), 4);
  assert.ok(receipts.some((line) => line.includes(`slice_after=- slice_last=${id(0x503)} revoked=1 first_id=${id(0x503)} last_id=${id(0x503)}`)), receipts.join("\n"));

  const after = await credentials(db);
  const again = await run(db, quiet({ batchSize: 3, write: true, runId: "t2" }));
  assert.deepEqual([again.revoked, again.counts.toRevoke, again.counts.deferredLiveMachine], [0, 0, 5]);
  assert.deepEqual(await credentials(db), after, "a re-run changes nothing");
});

test("apply re-checks the rule: a use or a Machine coming back after the dry-run is respected", async () => {
  const db = await seeded();
  const dry = await run(db, quiet({ batchSize: 3 }));
  assert.equal(dry.counts.toRevoke, 4);
  // Used since the dry-run: now fresh.
  await db.query(`UPDATE agent_credentials SET last_used_at = now() WHERE id = $1`, [id(0x511)]);
  // The silent Machine reconnected: its agent's keys are deferred.
  await db.query(`UPDATE daemons SET last_heartbeat = now() WHERE id = $1`, [SILENT_MACHINE]);
  const applied = await run(db, quiet({ batchSize: 3, write: true, runId: "t3" }));
  assert.equal(applied.revoked, 2);
  const revoked = (await credentials(db)).filter((row) => row.revoked_reason === REVOKED_REASON).map((row) => row.id);
  assert.deepEqual(revoked, [id(0x503), id(0x512)]);
});

test("a stopped walk resumes from its printed id and finishes the same", async () => {
  const db = await seeded();
  const lines: string[] = [];
  const first = await run(db, quiet({ batchSize: 3, maxBatches: 2, write: true, runId: "t4", log: (line) => lines.push(line) }));
  assert.equal(first.completed, false);
  assert.ok(lines.includes(`[STALE_RUNNER_CREDENTIALS_RESUME] --start-after ${first.lastId}`));
  const rest = await run(db, quiet({ batchSize: 3, write: true, runId: "t4", startAfter: first.lastId }));
  assert.equal(rest.completed, true);
  assert.equal(first.revoked + rest.revoked, 4);
});

test("--days and --heartbeat-hours move their lines", async () => {
  const db = await seeded();
  // Only last activity 120+ days ago: 0x506 (130 d) and 0x512 (200 d, never used); 0x502 (300 d) is on a live Machine.
  const old = await run(db, quiet({ days: 120 }));
  assert.deepEqual([old.counts.toRevoke, old.firstToRevokeId, old.lastToRevokeId], [2, id(0x506), id(0x512)]);
  // A 4-day window counts the Machine silent for 3 days as live.
  const wide = await run(db, quiet({ heartbeatHours: 96 }));
  assert.deepEqual([wide.counts.toRevoke, wide.counts.deferredLiveMachine], [3, 6]);
});

test("arguments and the production endpoint guard", () => {
  const base = ["--environment", "production"];
  assert.equal(parseArgs(base).apply, false);
  assert.deepEqual([parseArgs(base).days, parseArgs(base).heartbeatHours], [30, 24]);
  const apply = parseArgs(["--", ...base, "--apply", "--approval-reference", "https://raft/msg/1", "--run-id", "r-1", "--sleep-ms", "50"]);
  assert.deepEqual([apply.apply, apply.runId, apply.sleepMs], [true, "r-1", 50]);
  assert.throws(() => parseArgs([]), /--environment/);
  assert.throws(() => parseArgs([...base, "--apply", "--run-id", "r"]), /--approval-reference/);
  assert.throws(() => parseArgs([...base, "--apply", "--approval-reference", "m"]), /--run-id/);
  assert.throws(() => parseArgs([...base, "--run-id", "r"]), /only for --apply/);
  assert.throws(() => parseArgs([...base, "--days", "6"]), /--days/);
  assert.throws(() => parseArgs([...base, "--heartbeat-hours", "0"]), /--heartbeat-hours/);
  assert.throws(() => parseArgs([...base, "--batch", "0"]), /--batch/);
  assert.throws(() => parseArgs([...base, "--start-after", "x"]), /--start-after/);
  assert.throws(() => parseArgs([...base, "--nope"]), /Unknown argument/);
  assert.match(checkEndpoint("production", false, false) ?? "", /replica/);
  assert.match(checkEndpoint("production", true, true) ?? "", /primary/);
  assert.equal(checkEndpoint("production", false, true), null);
  assert.equal(checkEndpoint("production", true, false), null);
  assert.equal(checkEndpoint("staging", false, false), null);
});

// --mode deleted-agents ------------------------------------------------------

const DELETED_OLD = id(0x601); // deleted before the 2026-10-13 split (old delete path)
const DELETED_NEW = id(0x602); // deleted after it, other server
const DELETED_AT_SPLIT = id(0x603); // deleted exactly at the split: counts as on/after
const LIVE = id(0x604);
const MISSING = id(0x605); // no agents row (FK bypassed in the seed)
const DELETED_AGENTS: Record<string, [string, string | null]> = {
  [DELETED_OLD]: [SERVER, "2026-09-01T12:00:00Z"],
  [DELETED_NEW]: [OTHER_SERVER, "2026-10-20T12:00:00Z"],
  [DELETED_AT_SPLIT]: [SERVER, DELETED_AGENT_SPLIT_AT],
  [LIVE]: [SERVER, null],
};

type DeletedKey = { agent: string; issuedVia: string | null; createdBy?: string; usedDaysAgo?: number; revokedReason?: string; revoke: boolean };
const DELETED_KEYS: Record<string, DeletedKey> = {
  // Every issued_via of an agent deleted before the split, including NULL.
  [id(0x701)]: { agent: DELETED_OLD, issuedVia: "computer", revoke: true },
  [id(0x702)]: { agent: DELETED_OLD, issuedVia: "human", createdBy: PERSON, usedDaysAgo: 1, revoke: true },
  [id(0x703)]: { agent: DELETED_OLD, issuedVia: "app", revoke: true },
  [id(0x704)]: { agent: DELETED_OLD, issuedVia: "provision", revoke: true },
  [id(0x705)]: { agent: DELETED_OLD, issuedVia: "unknown", usedDaysAgo: 30, revoke: true },
  [id(0x706)]: { agent: DELETED_OLD, issuedVia: null, revoke: true },
  [id(0x707)]: { agent: DELETED_OLD, issuedVia: "computer", revokedReason: "runner_credential_stale", revoke: false }, // already revoked
  [id(0x708)]: { agent: DELETED_NEW, issuedVia: "human", createdBy: PERSON, revoke: true },
  [id(0x709)]: { agent: DELETED_NEW, issuedVia: "computer", revoke: true },
  [id(0x70a)]: { agent: DELETED_AT_SPLIT, issuedVia: "app", revoke: true },
  [id(0x70b)]: { agent: MISSING, issuedVia: "computer", revoke: true },
  // A live agent: every kind stays, used or not.
  [id(0x70c)]: { agent: LIVE, issuedVia: "computer", revoke: false },
  [id(0x70d)]: { agent: LIVE, issuedVia: "human", createdBy: PERSON, usedDaysAgo: 1, revoke: false },
  [id(0x70e)]: { agent: LIVE, issuedVia: "app", revoke: false },
  [id(0x70f)]: { agent: LIVE, issuedVia: "provision", revoke: false },
  [id(0x710)]: { agent: LIVE, issuedVia: "unknown", revoke: false },
  [id(0x711)]: { agent: LIVE, issuedVia: null, revoke: false },
  [id(0x712)]: { agent: LIVE, issuedVia: "human", createdBy: PERSON, revokedReason: "user_revoked", revoke: false },
};

type Token = { agent: string; consumed?: boolean; revokedReason?: string; expired?: boolean; revoke: boolean };
const TOKENS: Record<string, Token> = {
  [id(0x801)]: { agent: DELETED_OLD, revoke: true },
  [id(0x802)]: { agent: DELETED_OLD, expired: true, revoke: true },
  [id(0x803)]: { agent: DELETED_OLD, consumed: true, revoke: false }, // exchanged: left alone
  [id(0x804)]: { agent: DELETED_OLD, revokedReason: "agent_archived", revoke: false },
  [id(0x805)]: { agent: DELETED_NEW, revoke: true },
  [id(0x806)]: { agent: LIVE, revoke: false },
  [id(0x807)]: { agent: MISSING, revoke: true },
};

async function seededDeleted(): Promise<PGlite> {
  const db = new PGlite({ loadDataDir: template });
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, 'p@test.invalid', 'p', 'x')`, [PERSON]);
  for (const [serverId, slug] of [[SERVER, "s1"], [OTHER_SERVER, "s2"]]) {
    await db.query(`INSERT INTO servers (id, name, slug, owner_id) VALUES ($1, $2, $2, $3)`, [serverId, slug, PERSON]);
  }
  for (const [agentId, [serverId, deletedAt]] of Object.entries(DELETED_AGENTS)) {
    await db.query(`INSERT INTO agents (id, server_id, name, deleted_at) VALUES ($1, $2, $3, $4::timestamptz)`,
      [agentId, serverId, `agent-${agentId.slice(-3)}`, deletedAt]);
  }
  // Rows of an agent that no longer exists: the FKs would refuse them.
  await db.query(`SET session_replication_role = replica`);
  for (const [keyId, key] of Object.entries(DELETED_KEYS)) {
    await db.query(
      `INSERT INTO agent_credentials (id, agent_id, api_key_hash, api_key_prefix, scopes, name, issued_via, created_by_user_id,
         last_used_at, revoked_at, revoked_reason)
       VALUES ($1, $2, 'x', 'sk_agent_x', '{send}', 'k', $3, $4,
         CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5::int) END,
         CASE WHEN $6::text IS NULL THEN NULL ELSE now() - interval '10 days' END, $6::text)`,
      [keyId, key.agent, key.issuedVia, key.createdBy ?? null, key.usedDaysAgo ?? null, key.revokedReason ?? null],
    );
  }
  for (const [tokenId, token] of Object.entries(TOKENS)) {
    await db.query(
      `INSERT INTO agent_bootstrap_tokens (id, token_lookup_hash, token_hash, token_prefix, target_agent_id, server_id, issued_by_user_id,
         scopes, ttl_expires_at, consumed_at, revoked_at, revoked_reason)
       VALUES ($1, decode(md5($8), 'hex'), 'x', 'abtk_x', $2, $3, $4, '{send}',
         now() + CASE WHEN $5::boolean THEN interval '-1 day' ELSE interval '30 minutes' END,
         CASE WHEN $6::boolean THEN now() - interval '1 day' ELSE NULL END,
         CASE WHEN $7::text IS NULL THEN NULL ELSE now() - interval '10 days' END, $7::text)`,
      [tokenId, token.agent, SERVER, PERSON, token.expired ?? false, token.consumed ?? false, token.revokedReason ?? null, tokenId],
    );
  }
  await db.query(`SET session_replication_role = DEFAULT`);
  return db;
}

type Revocable = { id: string; revoked_at: Date | null; revoked_reason: string | null; revoked_by_user_id: string | null };
const deletedQuiet = (overrides: Partial<DeletedAgentsOptions> = {}): DeletedAgentsOptions => ({ ...quiet({ batchSize: 3 }), ...overrides });
const tokens = async (db: PGlite) => (await db.query<Revocable & { consumed_at: Date | null }>(
  `SELECT id, revoked_at, revoked_reason, revoked_by_user_id, consumed_at FROM agent_bootstrap_tokens ORDER BY id`,
)).rows;
const revokedIds = (rows: Revocable[]) => rows.filter((row) => row.revoked_reason === DELETED_AGENT_REVOKED_REASON).map((row) => row.id);
const expected = (rows: Record<string, { revoke: boolean }>) => Object.keys(rows).filter((key) => rows[key]!.revoke).sort();

test("deleted-agents: dry-run counts and writes nothing; apply revokes every kind of a deleted or missing agent's key, and its unused tokens, only", async () => {
  const db = await seededDeleted();
  const beforeKeys = await credentials(db);
  const beforeTokens = await tokens(db);
  const dry = await runDeletedAgents(db, deletedQuiet());
  assert.equal(dry.completed, true);
  assert.equal(dry.credentials.scanned, Object.keys(DELETED_KEYS).length);
  assert.equal(dry.bootstrapTokens.scanned, Object.keys(TOKENS).length);
  assert.deepEqual(dry.credentials.counts, { toRevoke: 10, deletedBefore: 6, deletedOnOrAfter: 3, agentMissing: 1, used7d: 1, expired: 0 });
  // Every issued_via, a NULL one included.
  assert.deepEqual(dry.credentials.byIssuedVia, { computer: 3, human: 2, app: 2, provision: 1, unknown: 1, null: 1 });
  // The date split: what was deleted on or after 2026-10-13 (a path that did not revoke), and by whom it was issued.
  assert.deepEqual(dry.credentials.onOrAfterByIssuedVia, { human: 1, computer: 1, app: 1 });
  assert.deepEqual([dry.credentials.lateAgents, dry.credentials.lateAgentIds], [2, [DELETED_NEW, DELETED_AT_SPLIT].sort()]);
  assert.deepEqual([dry.credentials.agents, dry.credentials.servers], [4, 2]);
  assert.deepEqual([dry.credentials.firstToRevokeId, dry.credentials.lastToRevokeId], [id(0x701), id(0x70b)]);
  assert.deepEqual(dry.bootstrapTokens.counts, { toRevoke: 4, deletedBefore: 2, deletedOnOrAfter: 1, agentMissing: 1, used7d: 0, expired: 1 });
  assert.deepEqual(dry.bootstrapTokens.byIssuedVia, {});
  assert.deepEqual([dry.credentials.revoked, dry.bootstrapTokens.revoked], [0, 0]);
  assert.deepEqual(await credentials(db), beforeKeys, "dry-run writes no credential");
  assert.deepEqual(await tokens(db), beforeTokens, "dry-run writes no token");

  const lines: string[] = [];
  const applied = await runDeletedAgents(db, deletedQuiet({ write: true, runId: "d1", log: (line) => lines.push(line) }));
  assert.equal(applied.completed, true);
  assert.deepEqual([applied.credentials.revoked, applied.bootstrapTokens.revoked], [10, 4]);
  assert.deepEqual(applied.credentials.counts, dry.credentials.counts);
  const afterKeys = await credentials(db);
  for (const row of afterKeys) {
    if (DELETED_KEYS[row.id]!.revoke) {
      assert.ok(row.revoked_at !== null, `key ${row.id} revoked`);
      assert.deepEqual([row.revoked_reason, row.revoked_by_user_id], [DELETED_AGENT_REVOKED_REASON, null]);
    } else {
      // A live agent's keys, and keys already revoked, stay exactly as they were.
      assert.deepEqual(row, beforeKeys.find((b) => b.id === row.id), `key ${row.id} untouched`);
    }
  }
  assert.deepEqual(revokedIds(afterKeys), expected(DELETED_KEYS));
  const afterTokens = await tokens(db);
  for (const row of afterTokens) {
    if (TOKENS[row.id]!.revoke) {
      assert.deepEqual([row.revoked_reason, row.revoked_by_user_id, row.consumed_at], [DELETED_AGENT_REVOKED_REASON, null, null]);
    } else {
      assert.deepEqual(row, beforeTokens.find((b) => b.id === row.id), `token ${row.id} untouched`);
    }
  }
  assert.deepEqual(revokedIds(afterTokens), expected(TOKENS));
  const receipts = lines.filter((line) => line.startsWith("[DELETED_AGENT_CREDENTIALS_RECEIPT] phase="));
  assert.equal(receipts.length, applied.credentials.batches + applied.bootstrapTokens.batches, "one receipt per slice");
  assert.ok(receipts.every((line) => line.includes(" run_id=d1 ")));
  assert.ok(lines.some((line) => line.startsWith("[DELETED_AGENT_CREDENTIALS_DONE] phase=credentials mode=apply ")));
  assert.ok(lines.some((line) => line.startsWith("[DELETED_AGENT_CREDENTIALS_DONE] phase=bootstrap-tokens mode=apply ")));
  const summary = JSON.parse(lines.find((line) => line.startsWith("[DELETED_AGENT_CREDENTIALS_SUMMARY] "))!.replace(/^\S+ /, "")) as { rule: string; splitAt: string };
  assert.deepEqual([summary.rule, summary.splitAt], ["deleted-agents", DELETED_AGENT_SPLIT_AT]);
  assert.ok(!lines.some((line) => line.includes("STALE_RUNNER")), "its own tags");

  const again = await runDeletedAgents(db, deletedQuiet({ write: true, runId: "d2" }));
  assert.deepEqual([again.credentials.revoked, again.bootstrapTokens.revoked, again.credentials.counts.toRevoke], [0, 0, 0]);
  assert.deepEqual([await credentials(db), await tokens(db)], [afterKeys, afterTokens], "a re-run changes nothing");
});

test("deleted-agents: the UPDATE re-checks the rule (a key revoked since, or an agent live again, is left alone)", async () => {
  const db = await seededDeleted();
  const dry = await runDeletedAgents(db, deletedQuiet());
  assert.equal(dry.credentials.counts.toRevoke, 10);
  await db.query(`UPDATE agent_credentials SET revoked_at = now(), revoked_reason = 'agent_archived' WHERE id = $1`, [id(0x708)]);
  await db.query(`UPDATE agents SET deleted_at = NULL WHERE id = $1`, [DELETED_OLD]);
  const applied = await runDeletedAgents(db, deletedQuiet({ write: true, runId: "d3" }));
  assert.deepEqual([applied.credentials.revoked, applied.bootstrapTokens.revoked], [3, 2]);
  assert.deepEqual(revokedIds(await credentials(db)), [id(0x709), id(0x70a), id(0x70b)]);
  assert.deepEqual(revokedIds(await tokens(db)), [id(0x805), id(0x807)]);
});

test("deleted-agents: a stopped walk prints where to resume, in either phase, and finishes the same", async () => {
  const db = await seededDeleted();
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  // 18 keys in slices of 3, then 7 tokens. Stop after 2 credential slices; then the other 4 (the
  // empty slice that ends a phase is not a batch) and 1 token slice; then the rest.
  const first = await runDeletedAgents(db, deletedQuiet({ write: true, runId: "d4", maxBatches: 2, log }));
  assert.deepEqual([first.completed, first.credentials.completed, first.bootstrapTokens.skipped], [false, false, true]);
  assert.ok(lines.includes(`[DELETED_AGENT_CREDENTIALS_RESUME] --mode deleted-agents --start-after ${first.credentials.lastId}`), lines.join("\n"));
  const second = await runDeletedAgents(db, deletedQuiet({ write: true, runId: "d4", maxBatches: 5, startAfter: first.credentials.lastId, log }));
  assert.deepEqual([second.completed, second.credentials.completed, second.bootstrapTokens.batches], [false, true, 1]);
  assert.ok(lines.includes(`[DELETED_AGENT_CREDENTIALS_RESUME] --mode deleted-agents --start-phase bootstrap-tokens --start-after ${second.bootstrapTokens.lastId}`), lines.join("\n"));
  const rest = await runDeletedAgents(db, deletedQuiet({ write: true, runId: "d4", startPhase: "bootstrap-tokens", startAfter: second.bootstrapTokens.lastId }));
  assert.deepEqual([rest.completed, rest.credentials.skipped, rest.credentials.scanned], [true, true, 0]);
  assert.equal(first.credentials.revoked + second.credentials.revoked, 10);
  assert.equal(second.bootstrapTokens.revoked + rest.bootstrapTokens.revoked, 4);
});

test("deleted-agents: arguments", () => {
  const base = ["--environment", "production", "--mode", "deleted-agents"];
  assert.equal(parseArgs(["--environment", "production"]).mode, "runner-stale");
  assert.deepEqual([parseArgs(base).mode, parseArgs(base).startPhase, parseArgs(base).apply], ["deleted-agents", "credentials", false]);
  const apply = parseArgs([...base, "--apply", "--approval-reference", "m", "--run-id", "dac-1", "--start-phase", "bootstrap-tokens"]);
  assert.deepEqual([apply.apply, apply.startPhase], [true, "bootstrap-tokens"]);
  assert.throws(() => parseArgs([...base, "--apply", "--run-id", "r"]), /--approval-reference/);
  assert.throws(() => parseArgs([...base, "--apply", "--approval-reference", "m"]), /--run-id/);
  assert.throws(() => parseArgs([...base, "--days", "30"]), /--days is only for --mode runner-stale/);
  assert.throws(() => parseArgs([...base, "--heartbeat-hours", "24"]), /--heartbeat-hours is only for --mode runner-stale/);
  assert.throws(() => parseArgs([...base, "--start-phase", "nope"]), /--start-phase must be/);
  assert.throws(() => parseArgs(["--environment", "production", "--start-phase", "credentials"]), /only for --mode deleted-agents/);
  assert.throws(() => parseArgs(["--environment", "production", "--mode", "everything"]), /--mode must be/);
});
