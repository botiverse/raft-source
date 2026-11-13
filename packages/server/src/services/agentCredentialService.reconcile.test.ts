import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index";
import { migratePglite } from "../db/pgliteMigrations";
import * as schema from "../db/schema";
import {
  RUNNER_CREDENTIAL_RECONCILE_MAX_HELD,
  RUNNER_NOT_HELD_REVOKE_REASON,
  countRunnerCredentialsNotHeld, revokeRunnerCredentialsNotHeld,
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
const KEYS: Record<string, Key> = {
  [id(0x501)]: { created: 600 }, // not listed, old, never used: revoked
  [id(0x502)]: { created: 600, used: 120 }, // not listed, idle for 2h: revoked
  [id(0x503)]: { created: 600, used: 3 }, // not listed but used 3 min ago: spared
  [id(0x504)]: { created: 2 }, // not listed, minted 2 min before the ready (in grace): spared
  [id(0x505)]: { created: 600 }, // listed: spared
  [id(0x506)]: { created: 600, machine: OTHER_MACHINE }, // another Machine's: spared
  [id(0x507)]: { created: 600, issuedVia: "human", createdBy: PERSON, machine: null }, // a person's key: spared
  [id(0x508)]: { created: 600, name: "ci-runner" }, // not a runner credential: spared
  [id(0x509)]: { created: 600, provision: true }, // a cloud runtime's: spared
  [id(0x50a)]: { created: 600, revoked: true }, // already revoked: untouched
};
const LISTED = [id(0x505)];

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

const reconcile = (db: Database, heldIds: readonly string[], limit?: number) => revokeRunnerCredentialsNotHeld(
  { machineId: MACHINE, heldIds, issuedBefore: new Date(READY_AT.getTime() - GRACE_MS), now: NOW, limit },
  db,
);

test("revokes exactly this Machine's idle runner credentials the daemon does not hold", async () => {
  const { db, reasons } = await seeded();
  assert.equal(await reconcile(db, LISTED), 2);
  const after = await reasons();
  for (const keyId of Object.keys(KEYS)) {
    const expected = keyId === id(0x501) || keyId === id(0x502)
      ? RUNNER_NOT_HELD_REVOKE_REASON
      : keyId === id(0x50a) ? "managed_runner_launch_ended" : null;
    assert.equal(after[keyId], expected, keyId);
  }
  assert.equal(await reconcile(db, LISTED), 0, "a repeat changes nothing");
});

test("an empty list (a restarted daemon) still spares recent mints and recent use", async () => {
  const { db, reasons } = await seeded();
  assert.equal(await reconcile(db, []), 3);
  const after = await reasons();
  assert.equal(after[id(0x505)], RUNNER_NOT_HELD_REVOKE_REASON);
  assert.equal(after[id(0x503)], null);
  assert.equal(after[id(0x504)], null);
});

test("ids that are not credential ids are ignored, not an error", async () => {
  const { db } = await seeded();
  assert.equal(await reconcile(db, [...LISTED, "not-a-uuid", ""]), 2);
});

test("an oversized claim reconciles nothing", async () => {
  const { db, reasons } = await seeded();
  const before = await reasons();
  const tooMany = Array.from({ length: RUNNER_CREDENTIAL_RECONCILE_MAX_HELD + 1 }, (_, n) => id(0x10000 + n));
  assert.equal(await reconcile(db, tooMany), null);
  assert.deepEqual(await reasons(), before);
});

test("revokes at most `limit` per call; the rest go on the next one", async () => {
  const { db } = await seeded();
  assert.equal(await reconcile(db, LISTED, 1), 1);
  assert.equal(await reconcile(db, LISTED, 1), 1);
  assert.equal(await reconcile(db, LISTED, 1), 0);
});

test("count-only counts the same set the revoke would take, uncapped, and writes nothing", async () => {
  const { db, reasons } = await seeded();
  const before = await reasons();
  const input = { machineId: MACHINE, heldIds: LISTED, issuedBefore: new Date(READY_AT.getTime() - GRACE_MS), now: NOW };
  // 0x501 and 0x502 (idle 2h: used in the last 24h).
  assert.deepEqual(await countRunnerCredentialsNotHeld(input, db), { wouldRevoke: 2, usedLast24h: 1 });
  assert.deepEqual(await reasons(), before);
  assert.equal(await countRunnerCredentialsNotHeld({ ...input, heldIds: Array.from({ length: RUNNER_CREDENTIAL_RECONCILE_MAX_HELD + 1 }, (_, n) => id(0x10000 + n)) }, db), null);
  assert.equal(await reconcile(db, LISTED), 2, "the revoke takes exactly what was counted");
});
