import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import type { DatabaseExecutor } from "../db/index";
import { currentConversationAuthorityStatus } from "./slackBridgeConversationAuthorityStatus";

const installId = "00000000-0000-4000-8000-000000000001";
const registrationId = "00000000-0000-4000-8000-000000000002";
const bindingId = "00000000-0000-4000-8000-000000000003";
const projectionId = "00000000-0000-4000-8000-000000000004";
const now = new Date("2026-10-27T09:00:00Z");
const binding = {
  id: bindingId, installId, registrationId, connectionEpoch: 4,
  bindingEpoch: 2, providerConversationId: "C_CHANNEL",
};
const hash = (label: string) => createHash("sha256")
  .update(JSON.stringify([label, ["U_MEMBER"]])).digest("hex");

async function fixture() {
  const client = new PGlite();
  await client.exec(`
    CREATE TABLE external_app_installs (
      id uuid, registration_id uuid, connection_epoch int, state text, provider_authority_id text
    );
    CREATE TABLE external_binding_audience_snapshots (
      id uuid DEFAULT gen_random_uuid(), binding_id uuid, binding_epoch int,
      audience_revision int, external_member_count int, external_audience_digest text,
      raft_member_count int, raft_audience_digest text, status text,
      observed_at timestamptz, expires_at timestamptz, created_at timestamptz
    );
    CREATE UNIQUE INDEX idx_external_binding_audience_revision
      ON external_binding_audience_snapshots(binding_id,binding_epoch,audience_revision);
    CREATE TABLE external_actor_projections (
      id uuid, external_actor_id text, provider text, app_registration_id text,
      install_id text, workspace_id text, actor_kind text, state text, deactivated boolean
    );
    CREATE TABLE external_addressability_projections (
      projection_id uuid, provider text, app_registration_id text, install_id text,
      workspace_id text, connection_epoch int, binding_id text, binding_epoch int,
      conversation_id text, member_revision int, context_revision int,
      state text, expires_at timestamptz
    );
    INSERT INTO external_app_installs VALUES ('${installId}','${registrationId}',4,'active','T_WORKSPACE');
    INSERT INTO external_actor_projections VALUES (
      '${projectionId}','U_MEMBER','slack','${registrationId}','${installId}','T_WORKSPACE','human','active',false
    );
    INSERT INTO external_addressability_projections VALUES (
      '${projectionId}','slack','${registrationId}','${installId}','T_WORKSPACE',4,
      '${bindingId}',2,'C_CHANNEL',1,1,'active','2026-10-27T10:00:00Z'
    );
    INSERT INTO external_binding_audience_snapshots
      (binding_id,binding_epoch,audience_revision,external_member_count,external_audience_digest,
       raft_member_count,raft_audience_digest,status,observed_at,expires_at,created_at)
      VALUES ('${bindingId}',2,1,1,'${hash("slack-external-audience")}',1,
        '${hash("raft-authorized-provider-audience")}','matched','2026-10-27T08:55:00Z',
        '2026-10-27T10:00:00Z','2026-10-27T08:55:00Z');
  `);
  // This adapter fixture creates only the four relations this read boundary uses.
  return { client, db: drizzle(client) as unknown as DatabaseExecutor };
}

test("audience read stays matched when a complete refresh commits after snapshot selection", async () => {
  const { client, db } = await fixture();
  try {
    const query = client.query.bind(client);
    let refreshCommitted = false;
    client.query = (async (...args: Parameters<PGlite["query"]>) => {
      const result = await query(...args);
      if (!refreshCommitted && args[0].includes('"external_binding_audience_snapshots"')) {
        // Publish a complete R+1 after the reader has fetched R, before it
        // consumes that result. Separate snapshot/member SELECTs mix versions;
        // one statement returns the coherent R view even after this commit.
        refreshCommitted = true;
        await client.exec(`
          BEGIN;
          UPDATE external_addressability_projections SET member_revision=2,context_revision=2;
          INSERT INTO external_binding_audience_snapshots
            SELECT gen_random_uuid(),binding_id,binding_epoch,2,external_member_count,
              external_audience_digest,raft_member_count,raft_audience_digest,status,
              observed_at,expires_at,created_at FROM external_binding_audience_snapshots;
          COMMIT;
        `);
      }
      return result;
    }) as PGlite["query"];
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "matched");
    assert.equal(refreshCommitted, true, "the competing refresh must actually commit");
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "matched", "next read sees coherent R+1");
  } finally { await client.close(); }
});

test("audience read preserves stored mismatch and missing/expired authority results", async () => {
  const { client, db } = await fixture();
  try {
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "matched");
    await client.exec("UPDATE external_binding_audience_snapshots SET status='mismatch'; DELETE FROM external_addressability_projections;");
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "mismatch", "no members cannot hide an observed mismatch");
    await client.exec("UPDATE external_binding_audience_snapshots SET status='matched';");
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "unavailable");
    await client.exec("UPDATE external_binding_audience_snapshots SET expires_at='2026-10-27T08:00:00Z';");
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "unavailable");
    await client.exec("DELETE FROM external_binding_audience_snapshots;");
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "unavailable");
  } finally { await client.close(); }
});

test("audience read still rejects actual revision, workspace, membership and connection drift", async () => {
  const { client, db } = await fixture();
  try {
    await client.exec("UPDATE external_addressability_projections SET member_revision=2;");
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "unavailable");
    await client.exec("UPDATE external_addressability_projections SET member_revision=1,workspace_id='T_OTHER';");
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "unavailable");
    await client.exec("UPDATE external_addressability_projections SET workspace_id='T_WORKSPACE'; UPDATE external_actor_projections SET deactivated=true;");
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "unavailable");
    await client.exec("UPDATE external_actor_projections SET deactivated=false; UPDATE external_app_installs SET connection_epoch=5;");
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "unavailable");
    await client.exec("UPDATE external_app_installs SET connection_epoch=4,state='revoked';");
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "unavailable");
  } finally { await client.close(); }
});

test("latest audience state stays scoped to the current binding epoch and exact member digest", async () => {
  const { client, db } = await fixture();
  try {
    await client.exec(`INSERT INTO external_binding_audience_snapshots
      SELECT gen_random_uuid(),binding_id,1,999,external_member_count,external_audience_digest,
        raft_member_count,raft_audience_digest,'mismatch',observed_at,expires_at,created_at
      FROM external_binding_audience_snapshots;`);
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "matched");
    await client.exec("UPDATE external_binding_audience_snapshots SET external_audience_digest='wrong' WHERE binding_epoch=2;");
    assert.equal(await currentConversationAuthorityStatus(db, binding, now), "unavailable");
  } finally { await client.close(); }
});
