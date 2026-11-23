import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index";
import { migratePglite } from "../db/pgliteMigrations";
import * as schema from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { agentCredentials } from "../db/schema";
import {
  RUNNER_CREDENTIAL_RECONCILE_BATCH,
  RUNNER_CREDENTIAL_RECONCILE_FOLLOWUP_MAX_IDS,
  RUNNER_CREDENTIAL_RECONCILE_MAX_HELD,
  RUNNER_NOT_HELD_REVOKE_REASON,
  captureRunnerCredentialsNotHeld, countRunnerCredentialsNotHeld, countRunnerCredentialsUsedSince, revokeRunnerCredentialsNotHeld,
} from "./agentCredentialService";

// #wg-rbac:#27: the server half of the reconnect reconcile, on the real schema.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const PERSON = id(0x101);
const SERVER = id(0x201);
const MACHINE = id(0x301);
const OTHER_MACHINE = id(0x302);
const AGENT = id(0x401);
const RUNNER = "runner:claude:00000000";
const NOW = new Date("2026-11-05T10:00:00Z");
const READY_AT = NOW;
const GRACE_MS = 5 * 60_000;

type Key = {
  name?: string;
  issuedVia?: string;
  machine?: string | null;
  createdBy?: string;
  /** Minutes before NOW. */
  created: number;
  used?: number;
  revoked?: boolean;
  provision?: boolean;
};
const DAY = 24 * 60;
const KEYS: Record<string, Key> = {
  [id(0x501)]: { created: 8 * DAY }, // not listed, minted 8 days ago, never used: revoked
  [id(0x502)]: { created: 30 * DAY, used: 8 * DAY }, // not listed, unused for 8 days: revoked
  [id(0x503)]: { created: 30 * DAY, used: 3 }, // not listed but used 3 min ago: spared
  [id(0x504)]: { created: 2 }, // not listed, minted 2 min before the ready (in grace): spared
  [id(0x505)]: { created: 30 * DAY }, // listed: spared
  [id(0x506)]: { created: 30 * DAY, machine: OTHER_MACHINE }, // another Machine's: spared
  [id(0x507)]: { created: 30 * DAY, issuedVia: "human", createdBy: PERSON, machine: null }, // a person's key: spared
  [id(0x508)]: { created: 30 * DAY, name: "ci-runner" }, // not a runner credential: spared
  [id(0x509)]: { created: 30 * DAY, provision: true }, // a cloud runtime's: spared
  [id(0x50a)]: { created: 30 * DAY, revoked: true }, // already revoked: untouched
  [id(0x50b)]: { created: 30 * DAY, used: DAY + 60 }, // not listed, used a day ago: spared (the 15-minute rule took it)
  [id(0x50c)]: { created: DAY }, // not listed, minted a day ago, never used: spared (the 15-minute rule took it)
  [id(0x50d)]: { created: 30 * DAY, used: 120 }, // not listed, idle for 2h: spared (the 15-minute rule took it)
};
const LISTED = [id(0x505)];
/** What the 7-day rule takes with LISTED. */
const REVOKED = [id(0x501), id(0x502)];

async function seeded() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await client.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, 'p@test.invalid', 'p', 'x')`, [PERSON]);
  await client.query(`INSERT INTO servers (id, name, slug, owner_id) VALUES ($1, 's', 's', $2)`, [SERVER, PERSON]);
  for (const machineId of [MACHINE, OTHER_MACHINE]) {
    await client.query(`INSERT INTO daemons (id, server_id, user_id, name, api_key_hash) VALUES ($1, $2, $3, 'm', 'x')`, [machineId, SERVER, PERSON]);
  }
  await client.query(`INSERT INTO agents (id, server_id, name, daemon_id, status) VALUES ($1, $2, 'a', $3, 'active')`, [AGENT, SERVER, MACHINE]);
  for (const [keyId, key] of Object.entries(KEYS)) {
    await client.query(
      `INSERT INTO agent_credentials (id, agent_id, api_key_hash, api_key_prefix, scopes, name, issued_via, issued_by_machine_id,
         created_by_user_id, created_at, last_used_at, revoked_at, revoked_reason)
       VALUES ($1, $2, 'x', 'sk_agent_x', '{send}', $3, $4, $5, $6, $7::timestamptz - make_interval(mins => $8::int),
         CASE WHEN $9::int IS NULL THEN NULL ELSE $7::timestamptz - make_interval(mins => $9::int) END,
         CASE WHEN $10::boolean THEN $7::timestamptz - interval '1 day' END,
         CASE WHEN $10::boolean THEN 'managed_runner_launch_ended' END)`,
      [keyId, AGENT, key.name ?? RUNNER, key.issuedVia ?? "computer", key.machine === undefined ? MACHINE : key.machine,
        key.createdBy ?? null, NOW.toISOString(), key.created, key.used ?? null, key.revoked ?? false],
    );
    if (key.provision) {
      await client.query(
        `INSERT INTO agent_runtime_provisions (agent_id, server_id, provider, state, credential_id, provisioned_name, provisioned_instructions)
         VALUES ($1, $2, 'antiproton', 'active', $3, 'n', 'i')`,
        [AGENT, SERVER, keyId],
      );
    }
  }
  const reasons = async () => Object.fromEntries((await client.query<{ id: string; revoked_reason: string | null }>(
    `SELECT id, revoked_reason FROM agent_credentials ORDER BY id`,
  )).rows.map((row) => [row.id, row.revoked_reason]));
  return { db, reasons };
}

const input = (heldIds: readonly string[]) => (
  { machineId: MACHINE, heldIds, issuedBefore: new Date(READY_AT.getTime() - GRACE_MS), now: NOW }
);
const reconcile = async (db: Database, heldIds: readonly string[], limit?: number) => {
  const result = await revokeRunnerCredentialsNotHeld({ ...input(heldIds), limit }, db);
  return result.outcome === "ok" ? result.revoked : result.outcome;
};

/** `count` more of this Machine's runner credentials, minted `createdMins` before NOW, never used. */
async function addRunnerKeys(db: Database, count: number, createdMins: number) {
  await db.execute(sql`INSERT INTO agent_credentials (id, agent_id, api_key_hash, api_key_prefix, scopes, name, issued_via, issued_by_machine_id, created_at)
    SELECT gen_random_uuid(), ${AGENT}, 'x' || n, 'sk_agent_x', '{send}', ${RUNNER}, 'computer', ${MACHINE}, ${NOW.toISOString()}::timestamptz - make_interval(mins => ${createdMins}::int)
    FROM generate_series(1, ${count}) AS n`);
}

test("revokes exactly this Machine's runner credentials the daemon does not hold and nobody used for 7 days", async () => {
  const { db, reasons } = await seeded();
  assert.equal(await reconcile(db, LISTED), REVOKED.length);
  const after = await reasons();
  for (const keyId of Object.keys(KEYS)) {
    const expected = REVOKED.includes(keyId)
      ? RUNNER_NOT_HELD_REVOKE_REASON
      : keyId === id(0x50a) ? "managed_runner_launch_ended" : null;
    assert.equal(after[keyId], expected, keyId);
  }
  assert.equal(await reconcile(db, LISTED), 0, "a repeat changes nothing");
});

test("a list with no credential id (a just-started daemon) revokes nothing", async () => {
  const { db, reasons } = await seeded();
  const before = await reasons();
  assert.equal(await reconcile(db, []), "skipped_empty_held");
  assert.equal(await reconcile(db, ["not-a-uuid", ""]), "skipped_empty_held");
  assert.deepEqual(await reasons(), before);
});

test("the 7-day rule: used a day ago, or minted a day ago and never used, is spared; unused for 8 days is not", async () => {
  const { db, reasons } = await seeded();
  await reconcile(db, LISTED);
  const after = await reasons();
  assert.equal(after[id(0x50b)], null, "used a day ago");
  assert.equal(after[id(0x50c)], null, "minted a day ago, never used");
  assert.equal(after[id(0x50d)], null, "used 2h ago");
  assert.equal(after[id(0x502)], RUNNER_NOT_HELD_REVOKE_REASON, "unused for 8 days");
  assert.equal(after[id(0x501)], RUNNER_NOT_HELD_REVOKE_REASON, "minted 8 days ago, never used");
});

test("ids that are not credential ids are ignored, not an error", async () => {
  const { db } = await seeded();
  assert.equal(await reconcile(db, [...LISTED, "not-a-uuid", ""]), REVOKED.length);
});

test("an oversized claim reconciles nothing", async () => {
  const { db, reasons } = await seeded();
  const before = await reasons();
  const tooMany = Array.from({ length: RUNNER_CREDENTIAL_RECONCILE_MAX_HELD + 1 }, (_, n) => id(0x10000 + n));
  assert.equal(await reconcile(db, tooMany), "refused_too_many");
  assert.deepEqual(await reasons(), before);
});

test("revokes at most `limit` per call; the rest go on the next one", async () => {
  const { db } = await seeded();
  assert.equal(await reconcile(db, LISTED, 1), 1);
  assert.equal(await reconcile(db, LISTED, 1), 1);
  assert.equal(await reconcile(db, LISTED, 1), 0);
});

test("250 candidates: 200 go on one ready, the rest on the next; the listed key never", async () => {
  const { db, reasons } = await seeded();
  await addRunnerKeys(db, 248, 8 * DAY);
  assert.equal(await reconcile(db, LISTED), RUNNER_CREDENTIAL_RECONCILE_BATCH);
  assert.equal(await reconcile(db, LISTED), 250 - RUNNER_CREDENTIAL_RECONCILE_BATCH);
  assert.equal(await reconcile(db, LISTED), 0);
  assert.equal((await reasons())[id(0x505)], null);
});

test("count-only counts the same set the revoke would take, uncapped, and the 15-minute rule's, and writes nothing", async () => {
  const { db, reasons } = await seeded();
  const before = await reasons();
  // The 15-minute rule: 0x501, 0x502, 0x50b, 0x50c, 0x50d; used in the last 24h: 0x50d.
  assert.deepEqual(await countRunnerCredentialsNotHeld(input(LISTED), db), { wouldRevoke: 2, wouldRevoke15mRule: 5, usedLast24h: 1 });
  // An empty list: the revoke skips it; the 15-minute rule also took the unlisted 0x505.
  assert.deepEqual(await countRunnerCredentialsNotHeld(input([]), db), { wouldRevoke: 0, wouldRevoke15mRule: 6, usedLast24h: 1 });
  assert.deepEqual(await reasons(), before);
  assert.equal(await countRunnerCredentialsNotHeld(input(Array.from({ length: RUNNER_CREDENTIAL_RECONCILE_MAX_HELD + 1 }, (_, n) => id(0x10000 + n))), db), null);
  assert.equal(await reconcile(db, LISTED), 2, "the revoke takes exactly what was counted");
});

test("the follow-up counts only the unlisted keys used after the ready", async () => {
  const { db } = await seeded();
  const captured = await captureRunnerCredentialsNotHeld(input(LISTED), db);
  assert.ok(captured);
  // Unlisted, past the grace, whatever their use: 0x501 0x502 0x503 0x50b 0x50c 0x50d.
  assert.deepEqual([...captured.ids].sort(), [id(0x501), id(0x502), id(0x503), id(0x50b), id(0x50c), id(0x50d)]);
  assert.deepEqual([...captured.wouldRevokeIds].sort(), REVOKED);
  assert.equal(captured.truncated, false);
  const setUsed = (keyId: string, at: Date) => db.update(agentCredentials).set({ lastUsedAt: at }).where(eq(agentCredentials.id, keyId));
  await setUsed(id(0x501), new Date(READY_AT.getTime() + 60_000)); // would be revoked, used after: a live miss
  await setUsed(id(0x503), new Date(READY_AT.getTime() + 60_000)); // unlisted, used after
  await setUsed(id(0x505), new Date(READY_AT.getTime() + 60_000)); // listed: not a candidate
  await setUsed(id(0x50b), new Date(READY_AT.getTime() - 60_000)); // used before the ready only
  assert.deepEqual(
    await countRunnerCredentialsUsedSince({ ids: captured.ids, wouldRevokeIds: captured.wouldRevokeIds, since: READY_AT }, db),
    { usedSince: 2, wouldRevokeUsedSince: 1 },
  );
  // An empty list: every unlisted key is a candidate, none would be revoked.
  const empty = await captureRunnerCredentialsNotHeld(input([]), db);
  assert.equal(empty?.ids.length, 7);
  assert.deepEqual(empty?.wouldRevokeIds, []);
});

test("the follow-up keeps at most RUNNER_CREDENTIAL_RECONCILE_FOLLOWUP_MAX_IDS ids and says so", async () => {
  const { db } = await seeded();
  await addRunnerKeys(db, RUNNER_CREDENTIAL_RECONCILE_FOLLOWUP_MAX_IDS, 8 * DAY);
  const captured = await captureRunnerCredentialsNotHeld(input(LISTED), db);
  assert.equal(captured?.ids.length, RUNNER_CREDENTIAL_RECONCILE_FOLLOWUP_MAX_IDS);
  assert.equal(captured?.truncated, true);
});
