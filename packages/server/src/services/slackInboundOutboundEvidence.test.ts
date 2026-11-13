import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DatabaseExecutor } from "../db/index";
import { readSlackInboundOutboundEvidence } from "./slackInboundOutboundEvidence";

async function fixture() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE external_app_registrations(id uuid PRIMARY KEY, provider text, environment text, provider_app_id text);
    CREATE TABLE external_app_installs(id uuid PRIMARY KEY, registration_id uuid, provider_app_id text, provider_authority_id text);
    CREATE TABLE external_channel_bindings(id uuid PRIMARY KEY, install_id uuid, registration_id uuid, provider_conversation_id text);
    CREATE TABLE external_message_links(install_id text, provider text, provider_authority_id text,
      provider_conversation_id text, provider_message_id text, first_direction text, outcome_state text);
    CREATE TABLE external_outbound_deliveries(binding_id text, state text, state_reason text,
      first_dispatched_at timestamptz, updated_at timestamptz, provider_attempts integer NOT NULL DEFAULT 0);
    ALTER TABLE external_outbound_deliveries ADD COLUMN id uuid;
    CREATE TABLE external_delivery_attempts(delivery_id uuid, provider_io_started_at timestamptz);
    CREATE TABLE external_delivery_operator_decisions(delivery_id uuid, action text, data_loss_acknowledged boolean, consumed_at timestamptz);
  `);
  const registrationId = randomUUID(), installId = randomUUID(), bindingId = randomUUID();
  await pg.query("INSERT INTO external_app_registrations VALUES ($1,'slack','test','A_SELF')", [registrationId]);
  await pg.query("INSERT INTO external_app_installs VALUES ($1,$2,'A_SELF','T_ONE')", [installId, registrationId]);
  await pg.query("INSERT INTO external_channel_bindings VALUES ($1,$2,$3,'C_ONE')", [bindingId, installId, registrationId]);
  const scope = { db: drizzle(pg) as unknown as DatabaseExecutor, registrationId, installId,
    environment: "test" as const, providerAppId: "A_SELF", workspaceId: "T_ONE", conversationId: "C_ONE", providerMessageId: "1700000000.000001", receivedAt: new Date("2026-11-02T00:00:00Z") };
  return { pg, bindingId, scope };
}

test("only a same-install, workspace, channel and ts outbound link proves an echo", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await readSlackInboundOutboundEvidence(f.scope), { exactMessageMatch: false, unresolvedCandidate: false, manualSkipCandidate: false });
    await f.pg.query("INSERT INTO external_message_links VALUES ($1,'slack','T_ONE','C_ONE',$2,'raft_outbound','accepted')", [f.scope.installId, f.scope.providerMessageId]);
    assert.deepEqual(await readSlackInboundOutboundEvidence(f.scope), { exactMessageMatch: true, unresolvedCandidate: false, manualSkipCandidate: false });
    for (const changed of [{ conversationId: "C_OTHER" }, { workspaceId: "T_OTHER" }, { providerMessageId: "1700000000.000002" },
      { providerAppId: "A_OTHER" }, { environment: "production" as const }, { registrationId: randomUUID() }, { installId: randomUUID() }]) {
      assert.deepEqual(await readSlackInboundOutboundEvidence({ ...f.scope, ...changed }), { exactMessageMatch: false, unresolvedCandidate: false, manualSkipCandidate: false });
    }
    await f.pg.query("UPDATE external_message_links SET first_direction='provider_inbound'");
    assert.deepEqual(await readSlackInboundOutboundEvidence(f.scope), { exactMessageMatch: false, unresolvedCandidate: false, manualSkipCandidate: false });
  } finally { await f.pg.close(); }
});

test("only same-channel dispatching or ambiguous outbound work delays an unknown bot", async () => {
  const f = await fixture();
  try {
    for (const state of ["queued", "retry_wait", "accepted", "dead", "revoked"]) {
      await f.pg.query("DELETE FROM external_outbound_deliveries");
      await f.pg.query("INSERT INTO external_outbound_deliveries (binding_id,state,first_dispatched_at) VALUES ($1,$2,$3)", [f.bindingId, state, new Date("2026-11-01T23:59:00Z")]);
      assert.equal((await readSlackInboundOutboundEvidence(f.scope)).unresolvedCandidate, false, state);
    }
    for (const state of ["dispatching", "outcome_unknown"]) {
      await f.pg.query("DELETE FROM external_outbound_deliveries");
      const id = randomUUID();
      await f.pg.query("INSERT INTO external_outbound_deliveries (id,binding_id,state,first_dispatched_at) VALUES ($1,$2,$3,$4)", [id, f.bindingId, state, new Date("2026-11-02T00:00:30Z")]);
      await f.pg.query("INSERT INTO external_delivery_attempts VALUES ($1,$2)", [id, new Date("2026-11-01T23:59:59Z")]);
      assert.equal((await readSlackInboundOutboundEvidence(f.scope)).unresolvedCandidate, true, "late mutable delivery timestamp must not release an earlier started send");
      assert.equal((await readSlackInboundOutboundEvidence({ ...f.scope, conversationId: "C_OTHER" })).unresolvedCandidate, false);
      assert.equal((await readSlackInboundOutboundEvidence({ ...f.scope, environment: "production" })).unresolvedCandidate, false);
      await f.pg.query("UPDATE external_delivery_attempts SET provider_io_started_at=$1 WHERE delivery_id=$2", [new Date("2026-11-02T00:00:06Z"), id]);
      assert.equal((await readSlackInboundOutboundEvidence(f.scope)).unresolvedCandidate, false, "sends after the clock-skew margin cannot hold an earlier receipt");
      await f.pg.query("UPDATE external_delivery_attempts SET provider_io_started_at=$1 WHERE delivery_id=$2", [new Date("2026-11-02T00:00:04Z"), id]);
      assert.equal((await readSlackInboundOutboundEvidence(f.scope)).unresolvedCandidate, true, "small host clock skew remains conservative");
      await f.pg.query("DELETE FROM external_delivery_attempts WHERE delivery_id=$1", [id]);
      assert.equal((await readSlackInboundOutboundEvidence(f.scope)).unresolvedCandidate, false, "a claimed delivery with no provider attempt cannot have produced an echo");
      await f.pg.query("UPDATE external_outbound_deliveries SET provider_attempts=1 WHERE id=$1", [id]);
      assert.equal((await readSlackInboundOutboundEvidence(f.scope)).unresolvedCandidate, true, "missing legacy attempt evidence fails closed");
    }
    // Acceptance and the exact link commit together; one statement observes
    // either pending or the committed link, never a split two-read snapshot.
    await f.pg.transaction(async tx => {
      await tx.query("UPDATE external_outbound_deliveries SET state='accepted'");
      await tx.query("INSERT INTO external_message_links VALUES ($1,'slack','T_ONE','C_ONE',$2,'raft_outbound','accepted')", [f.scope.installId, f.scope.providerMessageId]);
    });
    assert.deepEqual(await readSlackInboundOutboundEvidence(f.scope), { exactMessageMatch: true, unresolvedCandidate: false, manualSkipCandidate: false });
  } finally { await f.pg.close(); }
});

test("a same-channel operator skip after isolation is audit context, not proof of message identity", async () => {
  const f = await fixture();
  try {
    const pendingSince = new Date("2026-11-02T00:00:00Z");
    const deliveryId = randomUUID();
    await f.pg.query(`INSERT INTO external_outbound_deliveries
      (binding_id,state,state_reason,first_dispatched_at,updated_at,id,provider_attempts) VALUES
      ($1,'skipped','operator_audited_skip','2026-11-01T23:59:00Z','2026-11-02T00:01:00Z',$2,0)`, [f.bindingId, deliveryId]);
    await f.pg.query(`INSERT INTO external_delivery_operator_decisions VALUES
      ($1,'skip',true,'2026-11-02T00:01:00Z')`, [deliveryId]);
    const read = (extra = {}) => readSlackInboundOutboundEvidence({ ...f.scope, pendingSince, ...extra });
    assert.deepEqual(await read(), { exactMessageMatch: false, unresolvedCandidate: false, manualSkipCandidate: false }, "a skipped delivery without an attempt cannot explain the event");
    await f.pg.query("UPDATE external_outbound_deliveries SET provider_attempts=1 WHERE id=$1", [deliveryId]);
    assert.deepEqual(await read(), { exactMessageMatch: false, unresolvedCandidate: false, manualSkipCandidate: true }, "historical attempts without records remain conservative");
    await f.pg.query("INSERT INTO external_delivery_attempts VALUES ($1,$2)", [deliveryId, new Date("2026-11-02T00:00:06Z")]);
    assert.equal((await read()).manualSkipCandidate, false, "a later recorded attempt cannot explain the event");
    await f.pg.query("UPDATE external_delivery_attempts SET provider_io_started_at=$1 WHERE delivery_id=$2", [new Date("2026-11-01T23:59:59Z"), deliveryId]);
    assert.equal((await read()).manualSkipCandidate, true, "a recorded earlier attempt remains audit context");
    assert.equal((await readSlackInboundOutboundEvidence(f.scope)).manualSkipCandidate, false);
    assert.equal((await read({ conversationId: "C_OTHER" })).manualSkipCandidate, false);
    assert.equal((await read({ pendingSince: new Date("2026-11-02T00:02:00Z") })).manualSkipCandidate, false);
    await f.pg.query("UPDATE external_outbound_deliveries SET state_reason='destination_deleted'");
    assert.equal((await read()).manualSkipCandidate, false);
    await f.pg.query("UPDATE external_outbound_deliveries SET state_reason='operator_audited_skip'");
    await f.pg.query("UPDATE external_delivery_operator_decisions SET data_loss_acknowledged=false");
    assert.equal((await read()).manualSkipCandidate, false);
  } finally { await f.pg.close(); }
});
