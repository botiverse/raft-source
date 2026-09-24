import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest.js";
import { oauthClients, oauthClientInstalls, users } from "../db/schema.js";
import { createServer } from "./serverService.js";
import { createOAuthClient } from "./oauthService.js";
import { createAppOutboundPermissionRevision } from "./appOutboundPermissionService.js";
import { ensureLocalAppSourceInstallation, backfillLocalAppSourceInstallations } from "./appSourceInstallationService.js";
import { configureAppWebhook, __setAppWebhookEncryptionKeyForTests } from "./appWebhookConfigService.js";

test("local source upgrade is idempotent, preserves suspension and only inserts eligible missing rows", async ({ db }) => {
  const [owner] = await db.insert(users).values({ name: "owner", email: "local-upgrade@slock.test", passwordHash: "unused" }).returning();
  const server = await createServer("Local upgrade", "local-upgrade", owner.id);
  const create = async (name: string, appType: "server_local" | "third_party_global" = "server_local") => (await createOAuthClient({
    serverId: server.id, createdByUserId: owner.id, name, clientId: name, appType,
  })).client;
  const legacy = await create("raft-release");
  await createAppOutboundPermissionRevision({ clientId: legacy.id, actor: { type: "human", id: owner.id }, groups: ["agent"], events: [] });
  await db.delete(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, legacy.id));
  const suspended = await create("suspended");
  const [suspendedInstall] = await db.insert(oauthClientInstalls).values({ clientId: suspended.id, serverId: server.id, installedByUserId: owner.id, status: "suspended" }).returning();
  const disabled = await create("disabled");
  await db.update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, disabled.id));
  await create("shared", "third_party_global");
  assert.deepEqual(await backfillLocalAppSourceInstallations(db), { scanned: 2, missing: 1, created: 0, failed: 0, failures: [] });
  assert.equal((await db.select().from(oauthClientInstalls)).length, 1);
  assert.deepEqual(await backfillLocalAppSourceInstallations(db, true), { scanned: 2, missing: 1, created: 1, failed: 0, failures: [] });
  assert.deepEqual(await backfillLocalAppSourceInstallations(db, true), { scanned: 2, missing: 0, created: 0, failed: 0, failures: [] });
  const [installation] = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, legacy.id));
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, legacy.id));
  assert.equal(installation.approvedRequestRevisionId, client.outboundCurrentRevisionId);
  assert.deepEqual(installation.approvedGroups, ["agent"]);
  assert.deepEqual(installation.subscribedEvents, []);
  assert.equal(client.appType, "server_local");
  assert.deepEqual((await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, suspendedInstall.id)))[0], suspendedInstall);
  await assert.rejects(db.insert(oauthClientInstalls).values({ clientId: legacy.id, serverId: server.id, installedByUserId: owner.id }), (error: unknown) => error instanceof Error && error.cause instanceof Error && "code" in error.cause && error.cause.code === "23505");
  const rollback = await create("rollback");
  await assert.rejects(db.transaction(async (tx) => {
    await ensureLocalAppSourceInstallation(rollback.id, tx);
    throw new Error("rollback control");
  }), /rollback control/);
  assert.equal((await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, rollback.id))).length, 0);
});

test("enabling App Notifications repairs an old local app without granting subscriptions", async ({ db }) => {
  const [owner] = await db.insert(users).values({ name: "owner", email: "local-webhook@slock.test", passwordHash: "unused" }).returning();
  const server = await createServer("Local webhook", "local-webhook", owner.id);
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, name: "Local webhook", clientId: "local-webhook" });
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 7));
  try {
    await configureAppWebhook({ clientId: client.id, actorUserId: owner.id, endpointUrl: "https://example.test/notifications" });
    const [install] = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id));
    assert.ok(install, "enabling notifications must create the missing source installation");
    assert.deepEqual(install.approvedGroups, []);
    assert.deepEqual(install.subscribedEvents, []);
    await configureAppWebhook({ clientId: client.id, actorUserId: owner.id, endpointUrl: "https://example.test/notifications" });
    assert.equal((await db.select().from(oauthClientInstalls)).length, 1);
  } finally {
    __setAppWebhookEncryptionKeyForTests(null);
  }
});


test("backfill isolates a middle transaction rollback and counts only committed outcomes", async ({ db }) => {
  const [owner] = await db.insert(users).values({ name: "repair", email: "repair-failure@slock.test", passwordHash: "unused" }).returning();
  const server = await createServer("Repair failure", "repair-failure", owner.id);
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
  ];
  for (const [index, id] of ids.entries()) {
    await db.insert(oauthClients).values({ id, serverId: server.id, createdByUserId: owner.id,
      clientId: `repair-${index}`, name: `Repair ${index}`, clientSecretHash: "unused" });
  }
  const withMiddleRollback = () => {
    let calls = 0;
    const transaction: typeof db.transaction = (callback, config) => db.transaction(async (tx) => {
      const result = await callback(tx);
      if (++calls === 2) throw new Error("private SQL/DSN must not enter receipt");
      return result;
    }, config);
    return new Proxy(db, { get: (target, key, receiver) => key === "transaction" ? transaction : Reflect.get(target, key, receiver) });
  };
  assert.deepEqual(await backfillLocalAppSourceInstallations(withMiddleRollback()), {
    scanned: 3, missing: 2, created: 0, failed: 1,
    failures: [{ clientId: ids[1], stage: "transaction" }],
  });
  assert.equal((await db.select().from(oauthClientInstalls)).length, 0);
  assert.deepEqual(await backfillLocalAppSourceInstallations(withMiddleRollback(), true), {
    scanned: 3, missing: 2, created: 2, failed: 1,
    failures: [{ clientId: ids[1], stage: "transaction" }],
  });
  const installed = await db.select().from(oauthClientInstalls);
  assert.deepEqual(installed.map((row) => row.clientId).sort(), [ids[0], ids[2]], "failed middle insert rolls back; later candidate still commits");
  assert.deepEqual(await backfillLocalAppSourceInstallations(db, true), {
    scanned: 3, missing: 1, created: 1, failed: 0, failures: [],
  });
  assert.deepEqual(await backfillLocalAppSourceInstallations(db, true), {
    scanned: 3, missing: 0, created: 0, failed: 0, failures: [],
  });
});
