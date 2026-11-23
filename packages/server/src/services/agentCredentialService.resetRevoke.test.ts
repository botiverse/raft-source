import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index";
import { migratePglite } from "../db/pgliteMigrations";
import * as schema from "../db/schema";
import { AGENT_RESET_REVOKE_REASON, readDatabaseNow, revokeAgentRunnerCredentialsForReset } from "./agentCredentialService";

// A person's Restart / Reset revokes the agent's live runner credentials, on the real schema.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const PERSON = id(0x101);
const SERVER = id(0x201);
const MACHINE = id(0x301);
const OTHER_MACHINE = id(0x302);
const AGENT = id(0x401);
const OTHER_AGENT = id(0x402);
const RUNNER = "runner:claude:00000000";
const NOW = new Date("2026-11-16T10:00:00Z");

type Key = { agent?: string; name?: string; issuedVia?: string; machine?: string | null; createdBy?: string; revoked?: boolean; provision?: boolean };
const KEYS: Record<string, Key> = {
  [id(0x501)]: {}, // a live runner key of this agent: revoked
  [id(0x502)]: { machine: OTHER_MACHINE }, // one another Machine minted: revoked
  [id(0x503)]: { issuedVia: "human", createdBy: PERSON, machine: null, name: "laptop" }, // a person's key: spared
  [id(0x504)]: { issuedVia: "app", machine: null, name: "app-bot" }, // an App's: spared
  [id(0x505)]: { issuedVia: "provision", machine: null, name: "runner:hosted" }, // a cloud runtime's: spared
  [id(0x506)]: { provision: true }, // a provider holds it, whatever its classification: spared
  [id(0x507)]: { name: "ci-runner" }, // not named as a runner credential: spared
  [id(0x508)]: { createdBy: PERSON }, // a person issued it: spared
  [id(0x509)]: { agent: OTHER_AGENT }, // another agent's runner key: spared
  [id(0x50a)]: { revoked: true }, // already revoked: untouched
};

async function seeded() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await client.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, 'p@test.invalid', 'p', 'x')`, [PERSON]);
  await client.query(`INSERT INTO servers (id, name, slug, owner_id) VALUES ($1, 's', 's', $2)`, [SERVER, PERSON]);
  for (const machineId of [MACHINE, OTHER_MACHINE]) {
    await client.query(`INSERT INTO daemons (id, server_id, user_id, name, api_key_hash) VALUES ($1, $2, $3, 'm', 'x')`, [machineId, SERVER, PERSON]);
  }
  for (const agentId of [AGENT, OTHER_AGENT]) {
    await client.query(`INSERT INTO agents (id, server_id, name, daemon_id, status) VALUES ($1, $2, $3, $4, 'active')`, [agentId, SERVER, `a-${agentId.slice(-3)}`, MACHINE]);
  }
  for (const [keyId, key] of Object.entries(KEYS)) {
    await client.query(
      `INSERT INTO agent_credentials (id, agent_id, api_key_hash, api_key_prefix, scopes, name, issued_via, issued_by_machine_id,
         created_by_user_id, revoked_at, revoked_reason)
       VALUES ($1, $2, 'x', 'sk_agent_x', '{send}', $3, $4, $5, $6,
         CASE WHEN $7::boolean THEN $8::timestamptz - interval '1 day' END,
         CASE WHEN $7::boolean THEN 'managed_runner_launch_ended' END)`,
      [keyId, key.agent ?? AGENT, key.name ?? RUNNER, key.issuedVia ?? "computer", key.machine === undefined ? MACHINE : key.machine,
        key.createdBy ?? null, key.revoked ?? false, NOW.toISOString()],
    );
    if (key.provision) {
      await client.query(
        `INSERT INTO agent_runtime_provisions (agent_id, server_id, provider, state, credential_id, provisioned_name, provisioned_instructions)
         VALUES ($1, $2, 'antiproton', 'active', $3, 'n', 'i')`,
        [key.agent ?? AGENT, SERVER, keyId],
      );
    }
  }
  const credentials = async () => Object.fromEntries((await client.query<{ id: string; revoked_reason: string | null; revoked_by_user_id: string | null }>(
    `SELECT id, revoked_reason, revoked_by_user_id FROM agent_credentials ORDER BY id`,
  )).rows.map((row) => [row.id, { reason: row.revoked_reason, by: row.revoked_by_user_id }]));
  const audits = async () => (await client.query<{
    server_id: string; event_type: string; outcome: string; source: string; actor_type: string; actor_id: string | null;
    subject_type: string | null; subject_id: string | null; target_type: string; target_id: string; metadata: Record<string, unknown>;
  }>(`SELECT * FROM integration_audit_events WHERE event_type = 'agent_credential.revoked' ORDER BY target_id`)).rows;
  // The reset began after every key above was created (the database's clock).
  const resetStartedAt = await readDatabaseNow(db);
  return { client, db, credentials, audits, resetStartedAt };
}

test("revokes exactly the agent's live runner credentials and audits each, with the person who reset as actor", async () => {
  const { db, credentials, audits, resetStartedAt } = await seeded();
  const revoked = await revokeAgentRunnerCredentialsForReset({ agentId: AGENT, serverId: SERVER, actorUserId: PERSON, createdBefore: resetStartedAt, now: NOW }, db);
  assert.deepEqual([...revoked].sort(), [id(0x501), id(0x502)]);

  const after = await credentials();
  for (const keyId of Object.keys(KEYS)) {
    const expected = keyId === id(0x501) || keyId === id(0x502)
      ? { reason: AGENT_RESET_REVOKE_REASON, by: PERSON }
      : keyId === id(0x50a) ? { reason: "managed_runner_launch_ended", by: null } : { reason: null, by: null };
    assert.deepEqual(after[keyId], expected, keyId);
  }

  const events = await audits();
  assert.equal(events.length, 2, "one audit event per revoked key");
  const operationIds = new Set<unknown>();
  for (const [index, event] of events.entries()) {
    const credentialId = [id(0x501), id(0x502)][index]!;
    assert.equal(event.server_id, SERVER);
    assert.equal(event.outcome, "success");
    assert.equal(event.source, "web");
    assert.equal(event.actor_type, "human");
    assert.equal(event.actor_id, PERSON);
    assert.equal(event.subject_type, "agent");
    assert.equal(event.subject_id, AGENT);
    assert.equal(event.target_type, "agent_credential");
    assert.equal(event.target_id, credentialId);
    const { operationId, ...metadata } = event.metadata;
    assert.deepEqual(metadata, { agentId: AGENT, credentialId, reason: AGENT_RESET_REVOKE_REASON, via: "reset" });
    operationIds.add(operationId);
  }
  assert.equal(operationIds.size, 1, "one operation");

  assert.deepEqual(await revokeAgentRunnerCredentialsForReset({ agentId: AGENT, serverId: SERVER, actorUserId: PERSON, createdBefore: resetStartedAt, now: NOW }, db), [], "a repeat revokes nothing");
  assert.equal((await audits()).length, 2, "and records nothing");
});

test("an agent on another server revokes nothing", async () => {
  const { client, db, credentials, resetStartedAt } = await seeded();
  const otherServer = id(0x202);
  await client.query(`INSERT INTO servers (id, name, slug, owner_id) VALUES ($1, 's2', 's2', $2)`, [otherServer, PERSON]);
  const before = await credentials();
  assert.deepEqual(await revokeAgentRunnerCredentialsForReset({ agentId: AGENT, serverId: otherServer, actorUserId: PERSON, createdBefore: resetStartedAt, now: NOW }, db), []);
  assert.deepEqual(await credentials(), before);
});

test("a person gone since the reset was asked: still revoked, audited as the system", async () => {
  const { db, credentials, audits, resetStartedAt } = await seeded();
  const revoked = await revokeAgentRunnerCredentialsForReset({ agentId: AGENT, serverId: SERVER, actorUserId: id(0x199), createdBefore: resetStartedAt, now: NOW }, db);
  assert.equal(revoked.length, 2);
  assert.deepEqual((await credentials())[id(0x501)], { reason: AGENT_RESET_REVOKE_REASON, by: null });
  for (const event of await audits()) {
    assert.equal(event.actor_type, "system");
    assert.equal(event.actor_id, null);
    assert.equal(event.source, "system");
  }
});

test("a runner key created when the reset began or after (the new launch's, minted after its start) stays", async () => {
  const { client, db, credentials, resetStartedAt } = await seeded();
  const NEW_KEY = id(0x5ff);
  const AT_BOUND = id(0x5fe);
  for (const [keyId, createdAt] of [[NEW_KEY, null], [AT_BOUND, resetStartedAt]] as const) {
    await client.query(
      `INSERT INTO agent_credentials (id, agent_id, api_key_hash, api_key_prefix, scopes, name, issued_via, issued_by_machine_id, created_at)
       VALUES ($1, $2, 'x', 'sk_agent_x', '{send}', $3, 'computer', $4, COALESCE($5::timestamptz, now()))`,
      [keyId, AGENT, RUNNER, MACHINE, createdAt],
    );
  }
  const revoked = await revokeAgentRunnerCredentialsForReset({ agentId: AGENT, serverId: SERVER, actorUserId: PERSON, createdBefore: resetStartedAt, now: NOW }, db);
  assert.deepEqual([...revoked].sort(), [id(0x501), id(0x502)], "only the keys created before the reset began");
  const after = await credentials();
  assert.deepEqual(after[NEW_KEY], { reason: null, by: null });
  assert.deepEqual(after[AT_BOUND], { reason: null, by: null });
});
